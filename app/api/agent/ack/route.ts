import {
  ensureControlSchema,
  finalizeCommandAck,
  isAgentAuthorized,
  upsertRoom,
  type RoomUpdate,
} from "@/db/control";
import { autoCompleteStoppedRoom } from "../auto-complete";
import { completePaymentCommand } from "@/db/payments";
import {
  normalizePaymentTraceId,
  recordPaymentLatencyEvents,
  type PaymentLatencyEvent,
} from "@/db/payment-latency";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { syncKioskCommandResult, syncKioskRoomTransition } from "@/db/customer-flow";
import { ControlPerformanceTrace } from "@/db/control-performance";

type BridgeLatencyEvent = {
  trace_id?: unknown;
  component?: unknown;
  stage?: unknown;
  iso_timestamp?: unknown;
  elapsed_ms?: unknown;
  duration_ms?: unknown;
  details?: unknown;
};

type AckBody = {
  commandId?: string;
  status?: "completed" | "failed";
  result?: string;
  errorCode?: string;
  roomControlState?: string;
  room?: RoomUpdate;
  traceId?: string;
  latencyEvents?: BridgeLatencyEvent[];
};

type AckCommandRow = {
  action: string;
  room_id: string;
  payload_json: string;
};

function backendEvent(
  traceId: string,
  startedAt: number,
  stage: string,
  durationMs?: number,
  details: Record<string, unknown> = {},
): PaymentLatencyEvent {
  return {
    traceId,
    component: "backend",
    stage,
    isoTimestamp: new Date().toISOString(),
    elapsedMs: performance.now() - startedAt,
    durationMs: durationMs ?? null,
    details,
  };
}

function bridgeEvents(body: AckBody, traceId: string): PaymentLatencyEvent[] {
  return (body.latencyEvents ?? []).slice(0, 100).flatMap((event) => {
    if (normalizePaymentTraceId(event.trace_id) !== traceId) return [];
    const component = event.component === "mpos" ? "mpos" : "bridge";
    return [{
      traceId,
      component,
      stage: String(event.stage ?? "").slice(0, 80),
      isoTimestamp: String(event.iso_timestamp ?? "").slice(0, 80),
      elapsedMs: Number(event.elapsed_ms) || 0,
      durationMs: event.duration_ms == null ? null : Number(event.duration_ms) || 0,
      details:
        event.details && typeof event.details === "object"
          ? event.details as Record<string, unknown>
          : {},
    } satisfies PaymentLatencyEvent];
  }).filter((event) => event.stage);
}

export async function POST(request: Request) {
  const startedAt = performance.now();
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "제어 모듈 인증 실패" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as AckBody;
    const commandId = String(body.commandId ?? "").trim();
    const controlPerf = new ControlPerformanceTrace(
      "POST /api/agent/ack",
      commandId,
    );
    controlPerf.end("auth_and_request_parse", startedAt);
    const status = body.status;
    const result = String(body.result ?? "").trim().slice(0, 4000);
    const traceId = normalizePaymentTraceId(body.traceId);
    const events = traceId
      ? [
          ...bridgeEvents(body, traceId),
          backendEvent(traceId, startedAt, "BRIDGE_RESPONSE_RECEIVED"),
        ]
      : [];
    if (!commandId || !status || !["completed", "failed"].includes(status)) {
      return Response.json(
        { error: "올바르지 않은 완료 응답입니다." },
        { status: 400 },
      );
    }

    const schemaStarted = controlPerf.start();
    await ensureControlSchema();
    controlPerf.end("schema_ready", schemaStarted);
    const commandSaveStarted = performance.now();
    if (traceId) events.push(backendEvent(traceId, startedAt, "COMMAND_DB_SAVE_START"));
    const commandSaveResult = await finalizeCommandAck({
      commandId,
      status,
      result,
      errorCode: String(body.errorCode ?? "").trim().slice(0, 80),
      roomControlState: String(body.roomControlState ?? "").trim().slice(0, 40),
    });
    controlPerf.end("command_status_update", commandSaveStarted);
    if (commandSaveResult.disposition === "NOT_FOUND") {
      return Response.json(
        { error: "ACK_COMMAND_NOT_FOUND", code: "ACK_COMMAND_NOT_FOUND" },
        { status: 404, headers: controlPerf.headers() },
      );
    }
    if (commandSaveResult.disposition === "CONFLICT") {
      return Response.json(
        {
          error: "ACK_STATE_CONFLICT",
          code: "ACK_STATE_CONFLICT",
          commandStatus: commandSaveResult.command?.status ?? "unknown",
        },
        { status: 409, headers: controlPerf.headers() },
      );
    }
    const commandRow = commandSaveResult?.command as AckCommandRow | undefined;
    const commandNewlyFinalized = commandSaveResult?.newlyFinalized === true;
    const commandAction = String(commandRow?.action ?? "");
    if (traceId) {
      const commandSaveDurationMs = performance.now() - commandSaveStarted;
      events.push(backendEvent(
        traceId,
        startedAt,
        "PAYMENT_D1_QUERY",
        commandSaveDurationMs,
        {
          query: "ack_command_status_update",
          rowsRead: 0,
          rowsWritten: commandNewlyFinalized ? 1 : 0,
        },
      ));
      events.push(backendEvent(
        traceId,
        startedAt,
        "COMMAND_DB_SAVE_DONE",
        commandSaveDurationMs,
      ));
    }

    const paymentCommand = commandNewlyFinalized && (commandAction.startsWith("payment_") || Boolean(traceId));
    const paymentSaveStarted = performance.now();
    if (paymentCommand) {
      if (traceId) events.push(backendEvent(traceId, startedAt, "PAYMENT_DB_SAVE_START"));
      await completePaymentCommand(
        commandId,
        status,
        result,
        traceId
          ? (query, durationMs, details) => events.push(backendEvent(
              traceId,
              startedAt,
              "PAYMENT_D1_QUERY",
              durationMs,
              { query, ...details },
            ))
          : undefined,
      );
      controlPerf.end("payment_command_finalize", paymentSaveStarted);
    }
    let kioskCommand = false;
    if (["set_info", "start", "stop"].includes(commandAction) && commandRow?.payload_json) {
      try {
        const commandPayload = JSON.parse(commandRow.payload_json) as Record<string, unknown>;
        kioskCommand = Boolean(String(commandPayload.customerVisitId ?? "").trim());
      } catch {
        kioskCommand = false;
      }
    }
    if (kioskCommand && commandNewlyFinalized) {
      const kioskSyncStarted = controlPerf.start();
      await syncKioskCommandResult(commandId, status === "completed", result);
      controlPerf.end("kiosk_command_sync", kioskSyncStarted);
    }
    if (traceId && paymentCommand) {
      events.push(backendEvent(
        traceId,
        startedAt,
        "PAYMENT_DB_SAVE_DONE",
        performance.now() - paymentSaveStarted,
      ));
    }

    if (body.room && ["0", "1", "2", "3"].includes(String(body.room.roomId))) {
      const roomUpdateStarted = controlPerf.start();
      const transition = await upsertRoom({
        ...body.room,
        roomId: String(body.room.roomId),
      });
      if (transition) {
        await syncKioskRoomTransition(transition.roomId, transition.previousStatus, transition.nextStatus);
      }
      await autoCompleteStoppedRoom(transition);
      controlPerf.end("room_state_update", roomUpdateStarted);
    }

    if (traceId) {
      events.push(backendEvent(traceId, startedAt, "API_RESPONSE_START"));
      events.push(backendEvent(traceId, startedAt, "API_RESPONSE_DONE"));
      const persistence = recordPaymentLatencyEvents(events).catch((error) => {
        console.error("[PAY TRACE] bridge ACK persistence failed", error);
      });
      const context = getRequestExecutionContext();
      if (context) context.waitUntil(persistence);
      else void persistence;
    }
    controlPerf.log({
      command_id: commandId,
      status,
      payment_trace: Boolean(traceId),
      command_action: commandAction,
      payment_finalize: paymentCommand,
      kiosk_sync: kioskCommand,
    });
    return Response.json(
      { ok: true, ...(traceId ? { traceId } : {}) },
      { headers: controlPerf.headers() },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "완료 응답 저장에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
