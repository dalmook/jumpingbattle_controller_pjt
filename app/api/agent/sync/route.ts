import {
  ensureControlSchema,
  getControlAgentId,
  getD1,
  isAgentAuthorized,
  upsertRoom,
  type RoomUpdate,
} from "@/db/control";
import { autoCompleteStoppedRoom } from "../auto-complete";
import { maybeDispatchDueSalesBriefing } from "@/db/push-notifications";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { ensurePaymentSchema, recordTerminalStatus } from "@/db/payments";
import { supportsControlFastLane, supportsPaymentFastLane } from "@/db/bridge-capabilities";
import {
  normalizePaymentTraceId,
  recordPaymentLatencyEvents,
  type PaymentLatencyEvent,
} from "@/db/payment-latency";
import { syncKioskRoomTransition } from "@/db/customer-flow";
import { ControlPerformanceTrace } from "@/db/control-performance";

type SyncBody = {
  agentId?: string;
  version?: string;
  armed?: boolean;
  simulate?: boolean;
  managerVisible?: boolean;
  rooms?: RoomUpdate[];
  paymentTerminal?: Record<string, unknown>;
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
  const perf = new ControlPerformanceTrace("POST /api/agent/sync");
  const authStarted = perf.start();
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "제어 모듈 인증 실패" }, { status: 401 });
  }
  perf.end("agent_auth", authStarted);

  try {
    const parseStarted = perf.start();
    const body = (await request.json()) as SyncBody;
    perf.end("request_parse", parseStarted);
    const agentId = String(body.agentId ?? "").trim().slice(0, 80);
    const version = String(body.version ?? "").trim().slice(0, 40);
    const paymentFastLane = supportsPaymentFastLane(version);
    const controlFastLane = supportsControlFastLane(version);
    if (!agentId) {
      return Response.json({ error: "agentId가 필요합니다." }, { status: 400 });
    }

    if (agentId !== getControlAgentId()) {
      return Response.json({ error: "허용되지 않은 매장 제어 모듈입니다." }, { status: 403 });
    }

    const schemaStarted = perf.start();
    await ensureControlSchema();
    await ensurePaymentSchema();
    perf.end("schema_ready", schemaStarted);
    const db = getD1();
    const agentUpsertStarted = perf.start();
    await db
      .prepare(
        `INSERT INTO agents (agent_id, version, last_seen)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(agent_id) DO UPDATE SET
           version = excluded.version,
           last_seen = CURRENT_TIMESTAMP`,
      )
      .bind(agentId, version)
      .run();
    perf.end("agent_upsert", agentUpsertStarted);
    const runtimeUpsertStarted = perf.start();
    await db
      .prepare(
        `INSERT INTO agent_runtime
         (agent_id, armed, simulate, manager_visible, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(agent_id) DO UPDATE SET
           armed = excluded.armed,
           simulate = excluded.simulate,
           manager_visible = excluded.manager_visible,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(
        agentId,
        body.armed === true ? 1 : 0,
        body.simulate === true ? 1 : 0,
        body.managerVisible === true ? 1 : 0,
      )
      .run();
    perf.end("agent_runtime_upsert", runtimeUpsertStarted);

    const roomsStarted = perf.start();
    for (const room of (body.rooms ?? []).slice(0, 4)) {
      if (["0", "1", "2", "3"].includes(String(room.roomId))) {
        const transition = await upsertRoom({
          ...room,
          roomId: String(room.roomId),
        });
        if (transition) {
          await syncKioskRoomTransition(transition.roomId, transition.previousStatus, transition.nextStatus);
        }
        await autoCompleteStoppedRoom(transition);
      }
    }
    perf.end("room_state_upserts", roomsStarted);

    if (body.paymentTerminal && typeof body.paymentTerminal === "object") {
      const terminalStarted = perf.start();
      await recordTerminalStatus(body.paymentTerminal);
      perf.end("payment_terminal_status", terminalStarted);
    }

    const now = new Date().toISOString();
    const maintenanceStarted = perf.start();
    await db.batch([
      db.prepare(
        `UPDATE commands SET
           status = 'failed',
           result = '명령 유효시간 초과',
           completed_at = ?
         WHERE status IN ('pending', 'claimed') AND expires_at <= ?
           AND action <> 'parking_register'`,
      ).bind(now, now),
      db.prepare(`
        UPDATE room_control_runtime SET
          control_state = CASE WHEN current_action = 'set_info' THEN 'SET_INFO_FAILED' ELSE 'CONTROL_FAILED' END,
          current_command_id = '',
          last_error_code = 'COMMAND_EXPIRED',
          last_error = '명령 유효시간 초과',
          last_error_at = ?,
          state_seen_at = ?,
          observed_at = ?,
          updated_at = ?
        WHERE current_command_id IN (
          SELECT id FROM commands
          WHERE status = 'failed' AND completed_at = ?
            AND action IN ('set_info', 'start', 'stop', 'all_stop')
        )
      `).bind(now, now, now, now, now),
    ]);

    await db
      .prepare(`
        UPDATE payment_attempts SET
          status = 'ERROR', error_code = 'TIMEOUT',
          response_message = '매장 브릿지에서 결제 명령을 수신하지 못했습니다.',
          completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE status = 'PENDING' AND command_id IN (
          SELECT id FROM commands
          WHERE status = 'failed' AND completed_at = ?
        )
      `)
      .bind(now)
      .run();

    const controlClaimCutoff = new Date(Date.now() - 30_000).toISOString();
    await db.batch([
      db.prepare(`UPDATE commands SET
          status = 'failed',
          result = 'CONTROL_ACK_TIMEOUT_AMBIGUOUS',
          completed_at = ?
        WHERE status = 'claimed'
          AND action IN ('set_info', 'start', 'stop', 'all_stop')
          AND expires_at > ?
          AND datetime(claimed_at) < datetime(?)`).bind(now, now, controlClaimCutoff),
      db.prepare(`UPDATE room_control_runtime SET
          control_state = CASE WHEN current_action = 'set_info' THEN 'SET_INFO_FAILED' ELSE 'CONTROL_FAILED' END,
          current_command_id = '',
          last_error_code = 'CONTROL_ACK_TIMEOUT_AMBIGUOUS',
          last_error = '제어 명령 처리 결과를 확인하지 못했습니다.',
          last_error_at = ?,
          state_seen_at = ?,
          observed_at = ?,
          updated_at = ?
        WHERE current_command_id IN (
          SELECT id FROM commands
          WHERE status = 'failed'
            AND result = 'CONTROL_ACK_TIMEOUT_AMBIGUOUS'
            AND completed_at = ?
            AND action IN ('set_info', 'start', 'stop', 'all_stop')
        )`).bind(now, now, now, now, now),
      db.prepare(`UPDATE commands SET status = 'pending', claimed_at = NULL
        WHERE status = 'claimed'
          AND action NOT IN ('parking_register', 'set_info', 'start', 'stop', 'all_stop')
          AND expires_at > ?
          AND datetime(claimed_at) < datetime(?)`).bind(now, controlClaimCutoff),
    ]);
    perf.end("command_maintenance", maintenanceStarted);

    const claimStarted = perf.start();
    const claimed = await db
      .prepare(
        `UPDATE commands SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP
         WHERE id IN (
           SELECT id FROM commands
           WHERE status = 'pending' AND expires_at > ?
              AND target_agent_id = ?
              AND action <> 'parking_register'
              AND (? = 0 OR action NOT IN ('payment_status', 'payment_pay', 'payment_cancel'))
              AND (? = 0 OR action NOT IN ('set_info', 'start', 'stop', 'all_stop'))
              AND (
                action NOT IN ('set_info', 'start', 'stop', 'all_stop')
                OR (
                  NOT EXISTS (
                    SELECT 1 FROM commands active_control
                    WHERE active_control.status = 'claimed'
                      AND active_control.action IN ('set_info', 'start', 'stop', 'all_stop')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM commands earlier_control
                    WHERE earlier_control.status = 'pending'
                      AND earlier_control.target_agent_id = commands.target_agent_id
                      AND earlier_control.action IN ('set_info', 'start', 'stop', 'all_stop')
                      AND datetime(earlier_control.expires_at) > datetime('now')
                      AND (
                        earlier_control.created_at < commands.created_at
                        OR (earlier_control.created_at = commands.created_at AND earlier_control.id < commands.id)
                      )
                  )
                )
              )
            ORDER BY created_at ASC LIMIT 8
         )
         RETURNING id, room_id, action, payload_json, expires_at`,
      )
      .bind(now, agentId, paymentFastLane ? 1 : 0, controlFastLane ? 1 : 0)
      .all<CommandRow>();
    perf.end("command_claim", claimStarted);

    const claimedCommands = claimed.results;

    const paymentClaimEvents = claimedCommands.flatMap((command) => {
      if (!command.action.startsWith("payment_")) return [];
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
        stage: "COMMAND_CLAIMED",
        isoTimestamp: new Date().toISOString(),
        elapsedMs: performance.now() - startedAt,
        durationMs: null,
        details: { commandId: command.id, action: command.action },
      } satisfies PaymentLatencyEvent];
    });

    getRequestExecutionContext()?.waitUntil(maybeDispatchDueSalesBriefing());
    if (paymentClaimEvents.length) {
      getRequestExecutionContext()?.waitUntil(
        recordPaymentLatencyEvents(paymentClaimEvents).catch((error) => {
          console.error("[PAY TRACE] command claim persistence failed", error);
        }),
      );
    }

    if (claimedCommands.length || performance.now() - startedAt >= 1_000) {
      perf.log({
        claimed_commands: claimedCommands.map((command) => ({
          trace_id: `CTRL-${command.id}`,
          action: command.action,
          room_id: command.room_id,
        })),
      });
    }
    return Response.json(
      {
        commands: claimedCommands.map((command) => ({
          id: command.id,
          roomId: command.room_id,
          action: command.action,
          payload: JSON.parse(command.payload_json),
          expiresAt: command.expires_at,
        })),
      },
      { headers: perf.headers() },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "동기화에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
