import {
  ensureControlSchema,
  getControlAgentId,
  getD1,
  isAgentAuthorized,
} from "@/db/control";
import { supportsPaymentFastLane } from "@/db/bridge-capabilities";
import {
  normalizePaymentTraceId,
  recordPaymentLatencyEvents,
  type PaymentLatencyEvent,
} from "@/db/payment-latency";
import { getRequestExecutionContext } from "vinext/shims/request-context";

type PaymentCommandBody = {
  agentId?: string;
  version?: string;
};

type CommandRow = {
  id: string;
  room_id: string;
  action: string;
  payload_json: string;
  expires_at: string;
};

export async function POST(request: Request) {
  const startedAt = performance.now();
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "제어 모듈 인증 실패" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as PaymentCommandBody;
    const agentId = String(body.agentId ?? "").trim().slice(0, 80);
    const version = String(body.version ?? "").trim().slice(0, 40);
    if (!agentId) {
      return Response.json({ error: "agentId가 필요합니다." }, { status: 400 });
    }
    if (agentId !== getControlAgentId()) {
      return Response.json({ error: "허용되지 않은 매장 결제 모듈입니다." }, { status: 403 });
    }
    if (!supportsPaymentFastLane(version)) {
      return Response.json(
        { error: "Payment Fast Lane을 지원하지 않는 브릿지 버전입니다." },
        { status: 409 },
      );
    }

    await ensureControlSchema();
    const now = new Date().toISOString();
    const claimed = await getD1()
      .prepare(
        `UPDATE commands SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP
         WHERE id IN (
           SELECT id FROM commands
           WHERE status = 'pending' AND expires_at > ?
             AND target_agent_id = ?
             AND action IN ('payment_status', 'payment_pay', 'payment_cancel')
           ORDER BY created_at ASC LIMIT 2
         )
         RETURNING id, room_id, action, payload_json, expires_at`,
      )
      .bind(now, agentId)
      .all<CommandRow>();

    const events = claimed.results.flatMap((command) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(command.payload_json) as Record<string, unknown>;
      } catch {
        return [];
      }
      const traceId = normalizePaymentTraceId(payload.traceId);
      if (!traceId) return [];
      return [{
        traceId,
        component: "backend" as const,
        stage: "PAYMENT_FAST_LANE_CLAIMED",
        isoTimestamp: new Date().toISOString(),
        elapsedMs: performance.now() - startedAt,
        durationMs: performance.now() - startedAt,
        details: { commandId: command.id, action: command.action, agentId },
      } satisfies PaymentLatencyEvent];
    });

    if (events.length) {
      const write = recordPaymentLatencyEvents(events).catch((error) => {
        console.error("[PAY TRACE] fast-lane claim persistence failed", error);
      });
      const context = getRequestExecutionContext();
      if (context) context.waitUntil(write);
      else void write;
    }

    return Response.json({
      commands: claimed.results.map((command) => ({
        id: command.id,
        roomId: command.room_id,
        action: command.action,
        payload: JSON.parse(command.payload_json),
        expiresAt: command.expires_at,
      })),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "결제 명령 수신에 실패했습니다." },
      { status: 500 },
    );
  }
}
