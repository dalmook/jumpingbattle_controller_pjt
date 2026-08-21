import {
  ensureControlSchema,
  getControlAgentId,
  getD1,
  isAgentAuthorized,
  upsertRoomControlStates,
  type RoomControlUpdate,
} from "@/db/control";
import { normalizedManagerState } from "@/db/control-readiness";
import { maybeDispatchInfrastructureAlerts } from "@/db/remote-operations";
import { getRequestExecutionContext } from "vinext/shims/request-context";

type HeartbeatBody = {
  agentId?: string;
  version?: string;
  bridgeInstanceId?: string;
  armed?: boolean;
  simulate?: boolean;
  managerVisible?: boolean;
  controlState?: string;
  currentControlAction?: string;
  controlStartedAt?: string;
  lastControlSuccessAt?: string;
  lastControlError?: string;
  stateStale?: boolean;
  managerState?: string;
  managerProbeAt?: string;
  managerProbeSuccessCount?: number;
  managerModalActive?: boolean;
  controlLoopLastSeen?: string;
  roomControlStates?: RoomControlUpdate[];
};

const CONTROL_STATES = new Set(["IDLE", "BUSY", "ERROR", "DEGRADED"]);

function cleanTimestamp(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const timestamp = new Date(text).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export async function POST(request: Request) {
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "제어 모듈 인증 실패" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as HeartbeatBody;
    const agentId = String(body.agentId ?? "").trim().slice(0, 80);
    const version = String(body.version ?? "").trim().slice(0, 40);
    if (!agentId) {
      return Response.json({ error: "agentId가 필요합니다." }, { status: 400 });
    }
    if (agentId !== getControlAgentId()) {
      return Response.json(
        { error: "허용되지 않은 매장 제어 모듈입니다." },
        { status: 403 },
      );
    }

    await ensureControlSchema();
    const db = getD1();
    const requestedState = String(body.controlState ?? "IDLE").toUpperCase();
    const controlState = CONTROL_STATES.has(requestedState)
      ? requestedState
      : "ERROR";
    const stateStale = body.stateStale === true;
    const managerVisible = body.managerVisible === true;
    const managerState = normalizedManagerState(body.managerState, {
      managerVisible,
      stateStale,
    });
    const managerProbeAt = cleanTimestamp(body.managerProbeAt);
    const controlLoopLastSeen = cleanTimestamp(body.controlLoopLastSeen);
    const managerProbeSuccessCount = Math.max(
      0,
      Math.min(1_000, Math.trunc(Number(body.managerProbeSuccessCount) || 0)),
    );
    await db.batch([
      db
        .prepare(
          `INSERT INTO agents (agent_id, version, last_seen)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(agent_id) DO UPDATE SET
             version = excluded.version,
             last_seen = CURRENT_TIMESTAMP`,
        )
        .bind(agentId, version),
      db
        .prepare(
          `INSERT INTO agent_runtime
           (agent_id, armed, simulate, manager_visible, bridge_instance_id,
            control_state, current_control_action, control_started_at,
            last_control_success_at, last_control_error, state_stale,
            manager_state, manager_probe_at, manager_probe_success_count,
            manager_modal_active, control_loop_last_seen, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(agent_id) DO UPDATE SET
             armed = excluded.armed,
             simulate = excluded.simulate,
             manager_visible = excluded.manager_visible,
             bridge_instance_id = excluded.bridge_instance_id,
             control_state = excluded.control_state,
             current_control_action = excluded.current_control_action,
             control_started_at = excluded.control_started_at,
             last_control_success_at = excluded.last_control_success_at,
             last_control_error = excluded.last_control_error,
             state_stale = excluded.state_stale,
             manager_state = excluded.manager_state,
              manager_probe_at = COALESCE(excluded.manager_probe_at, agent_runtime.manager_probe_at),
              manager_probe_success_count = CASE
                WHEN excluded.manager_probe_at IS NULL THEN agent_runtime.manager_probe_success_count
                ELSE excluded.manager_probe_success_count
              END,
              manager_modal_active = excluded.manager_modal_active,
              control_loop_last_seen = COALESCE(excluded.control_loop_last_seen, agent_runtime.control_loop_last_seen),
             updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(
          agentId,
          body.armed === true ? 1 : 0,
          body.simulate === true ? 1 : 0,
          managerVisible ? 1 : 0,
          String(body.bridgeInstanceId ?? "").trim().slice(0, 80),
          controlState,
          String(body.currentControlAction ?? "").trim().slice(0, 40),
          cleanTimestamp(body.controlStartedAt),
          cleanTimestamp(body.lastControlSuccessAt),
          String(body.lastControlError ?? "").trim().slice(0, 300),
          stateStale ? 1 : 0,
          managerState,
          managerProbeAt,
          managerProbeSuccessCount,
          body.managerModalActive === true ? 1 : 0,
          controlLoopLastSeen,
        ),
    ]);
    await upsertRoomControlStates(Array.isArray(body.roomControlStates) ? body.roomControlStates : []);
    getRequestExecutionContext()?.waitUntil(maybeDispatchInfrastructureAlerts());

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "브릿지 생존 신호 저장에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
