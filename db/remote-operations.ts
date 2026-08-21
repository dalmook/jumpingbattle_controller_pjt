import { ROOM_OPTIONS } from "@/app/reservation-config";
import { ensureControlSchema, getD1 } from "./control";
import { listKioskOperations } from "./customer-flow";
import { getPaymentTerminalState } from "./payments";
import { deferOperationalPush } from "./push-notifications";
import { evaluateControlReadiness, evaluateRoomCommandReadiness } from "./control-readiness";

type RoomRow = {
  room_id: string;
  name: string;
  size: string;
  status: string;
  team_name: string;
  map_name: string;
  map_index: number;
  people: number;
  remaining_seconds: number;
  game_started_at: string | null;
  updated_at: string;
  room_control_state: string;
  current_control_action: string;
  current_command_id: string;
  room_last_success_at: string | null;
  room_last_error_code: string;
  room_last_error: string;
  room_last_error_at: string | null;
  room_state_seen_at: string | null;
  room_observed_at: string | null;
};

type AgentRow = {
  version: string;
  last_seen: string;
  armed: number;
  manager_visible: number;
  control_state: string;
  current_control_action: string;
  control_started_at: string | null;
  last_control_success_at: string | null;
  last_control_error: string;
  state_stale: number;
  manager_state: string;
  manager_probe_at: string | null;
  manager_probe_success_count: number;
  manager_modal_active: number;
  control_loop_last_seen: string | null;
  manager_probe_fresh: number;
  control_loop_alive: number;
};

let runtimeSchemaReady = false;

function timestamp(value: string | null | undefined) {
  if (!value) return 0;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecent(value: string | null | undefined, maxAgeMs: number) {
  const parsed = timestamp(value);
  return parsed > 0 && Date.now() - parsed < maxAgeMs;
}

async function ensureRemoteRuntimeSchema() {
  if (runtimeSchemaReady) return;
  await getD1().prepare(`CREATE TABLE IF NOT EXISTS kiosk_runtime (
    kiosk_id TEXT PRIMARY KEY, current_visit_id TEXT NOT NULL DEFAULT '',
    current_status TEXT NOT NULL DEFAULT 'HOME', last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  runtimeSchemaReady = true;
}

function dispatchInfrastructureAlerts(
  agent: AgentRow | null | undefined,
  kiosk: { kiosk_id: string; last_seen: string } | null | undefined,
) {
  const bridgeOnline = isRecent(agent?.last_seen, 25_000);
  const kioskOnline = isRecent(kiosk?.last_seen, 15_000);
  if (agent?.last_seen && !bridgeOnline) {
    deferOperationalPush({
      eventType: "BRIDGE_OFFLINE",
      dedupKey: `bridge-offline:${agent.last_seen}`,
      title: "매장 브릿지 확인 필요",
      body: "브릿지 연결이 끊겼습니다. 매장 PC 상태를 확인해주세요.",
    });
  }
  if (bridgeOnline && (agent?.state_stale === 1 || Boolean(agent?.last_control_error))) {
    deferOperationalPush({
      eventType: "CONTROL_ERROR",
      dedupKey: `control-error:${agent?.last_control_success_at || agent?.last_seen}:${agent?.last_control_error}`,
      title: "원격제어 상태 확인 필요",
      body: "브릿지는 연결되어 있지만 원격제어 상태를 확인해야 합니다.",
    });
  }
  if (kiosk?.last_seen && !kioskOnline) {
    deferOperationalPush({
      eventType: "KIOSK_ERROR",
      dedupKey: `kiosk-offline:${kiosk.kiosk_id}:${kiosk.last_seen}`,
      title: "키오스크 상태 확인 필요",
      body: "키오스크 상태 갱신이 중단되었습니다.",
    });
  }
  return { bridgeOnline, kioskOnline };
}

export async function maybeDispatchInfrastructureAlerts() {
  await Promise.all([ensureControlSchema(), ensureRemoteRuntimeSchema()]);
  const db = getD1();
  const [agent, kiosk] = await Promise.all([
    db.prepare(`SELECT agents.version, agents.last_seen,
      COALESCE(agent_runtime.armed, 0) AS armed,
      COALESCE(agent_runtime.manager_visible, 0) AS manager_visible,
      COALESCE(agent_runtime.control_state, 'IDLE') AS control_state,
      COALESCE(agent_runtime.current_control_action, '') AS current_control_action,
      agent_runtime.control_started_at AS control_started_at,
      agent_runtime.last_control_success_at AS last_control_success_at,
      COALESCE(agent_runtime.last_control_error, '') AS last_control_error,
      COALESCE(agent_runtime.state_stale, 0) AS state_stale
      FROM agents LEFT JOIN agent_runtime ON agent_runtime.agent_id = agents.agent_id
      ORDER BY agents.last_seen DESC LIMIT 1`).first<AgentRow>(),
    db.prepare(`SELECT kiosk_id, last_seen FROM kiosk_runtime ORDER BY last_seen DESC LIMIT 1`)
      .first<{ kiosk_id: string; last_seen: string }>(),
  ]);
  return dispatchInfrastructureAlerts(agent, kiosk);
}

export async function touchKioskRuntime(input: {
  kioskId?: string;
  visitId?: string;
  status?: string;
}) {
  await ensureRemoteRuntimeSchema();
  const kioskId = String(input.kioskId || "main-kiosk").trim().slice(0, 80) || "main-kiosk";
  await getD1().prepare(`INSERT INTO kiosk_runtime
    (kiosk_id, current_visit_id, current_status, last_seen, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(kiosk_id) DO UPDATE SET
      current_visit_id = CASE WHEN excluded.current_visit_id <> '' THEN excluded.current_visit_id ELSE kiosk_runtime.current_visit_id END,
      current_status = excluded.current_status, last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`)
    .bind(kioskId, String(input.visitId || "").slice(0, 80), String(input.status || "ACTIVE").slice(0, 60)).run();
}

export async function getRemoteOperationsOverview() {
  await Promise.all([ensureControlSchema(), ensureRemoteRuntimeSchema()]);
  const db = getD1();
  const [rooms, agent, commands, kiosk, operations, terminal] = await Promise.all([
    db.prepare(`SELECT rooms.*, room_game_runtime.game_started_at AS game_started_at,
      COALESCE(room_control_runtime.control_state, 'READY') AS room_control_state,
      COALESCE(room_control_runtime.current_action, '') AS current_control_action,
      COALESCE(room_control_runtime.current_command_id, '') AS current_command_id,
      room_control_runtime.last_success_at AS room_last_success_at,
      COALESCE(room_control_runtime.last_error_code, '') AS room_last_error_code,
      COALESCE(room_control_runtime.last_error, '') AS room_last_error,
      room_control_runtime.last_error_at AS room_last_error_at,
      room_control_runtime.state_seen_at AS room_state_seen_at,
      room_control_runtime.observed_at AS room_observed_at
      FROM rooms LEFT JOIN room_game_runtime ON room_game_runtime.room_id = rooms.room_id
      LEFT JOIN room_control_runtime ON room_control_runtime.room_id = rooms.room_id
      ORDER BY CAST(rooms.room_id AS INTEGER)`).all<RoomRow>(),
    db.prepare(`SELECT agents.version, agents.last_seen,
      COALESCE(agent_runtime.armed, 0) AS armed,
      COALESCE(agent_runtime.manager_visible, 0) AS manager_visible,
      COALESCE(agent_runtime.control_state, 'IDLE') AS control_state,
      COALESCE(agent_runtime.current_control_action, '') AS current_control_action,
      agent_runtime.control_started_at AS control_started_at,
      agent_runtime.last_control_success_at AS last_control_success_at,
      COALESCE(agent_runtime.last_control_error, '') AS last_control_error,
      COALESCE(agent_runtime.state_stale, 0) AS state_stale,
      COALESCE(agent_runtime.manager_state,
        CASE WHEN COALESCE(agent_runtime.manager_visible, 0) = 0 THEN 'UNAVAILABLE'
          WHEN COALESCE(agent_runtime.state_stale, 0) = 1 THEN 'STALE' ELSE 'AVAILABLE' END
      ) AS manager_state,
      agent_runtime.manager_probe_at AS manager_probe_at,
      COALESCE(agent_runtime.manager_probe_success_count, 0) AS manager_probe_success_count,
      COALESCE(agent_runtime.manager_modal_active, 0) AS manager_modal_active,
      agent_runtime.control_loop_last_seen AS control_loop_last_seen,
      CASE WHEN datetime(agent_runtime.manager_probe_at) > datetime('now', '-10 seconds')
        THEN 1 ELSE 0 END AS manager_probe_fresh,
      CASE WHEN datetime(agent_runtime.control_loop_last_seen) > datetime('now', '-10 seconds')
        THEN 1 ELSE 0 END AS control_loop_alive
      FROM agents LEFT JOIN agent_runtime ON agent_runtime.agent_id = agents.agent_id
      ORDER BY agents.last_seen DESC LIMIT 1`).first<AgentRow>(),
    db.prepare(`SELECT id, room_id, action, status, result, created_at, completed_at
      FROM commands ORDER BY created_at DESC LIMIT 24`).all<{
        id: string; room_id: string; action: string; status: string;
        result: string; created_at: string; completed_at: string | null;
      }>(),
    db.prepare(`SELECT kiosk_id, current_visit_id, current_status, last_seen, updated_at
      FROM kiosk_runtime ORDER BY last_seen DESC LIMIT 1`).first<{
        kiosk_id: string; current_visit_id: string; current_status: string; last_seen: string; updated_at: string;
      }>(),
    listKioskOperations(),
    getPaymentTerminalState(),
  ]);

  const roomOrder = new Map<string, number>(ROOM_OPTIONS.map((room, index) => [room.roomId, index]));
  const { bridgeOnline, kioskOnline } = dispatchInfrastructureAlerts(agent, kiosk);
  const readiness = evaluateControlReadiness({
    bridgeOnline,
    armed: agent?.armed === 1,
    controlState: agent?.control_state ?? "ERROR",
    controlLoopAlive: agent?.control_loop_alive === 1,
    managerProbeFresh: agent?.manager_probe_fresh === 1,
    managerState: agent?.manager_state ?? "UNAVAILABLE",
    managerModalActive: agent?.manager_modal_active === 1,
    stateStale: agent?.state_stale === 1,
  });
  return {
    generatedAt: new Date().toISOString(),
    bridge: {
      online: bridgeOnline,
      lastSeen: agent?.last_seen ?? "",
      version: agent?.version ?? "",
      armed: agent?.armed === 1,
      managerVisible: agent?.manager_visible === 1,
      controlState: agent?.control_state ?? "IDLE",
      currentAction: agent?.current_control_action ?? "",
      controlStartedAt: agent?.control_started_at ?? "",
      lastSuccessAt: agent?.last_control_success_at ?? "",
      lastError: agent?.last_control_error ?? "",
      stateStale: agent?.state_stale === 1,
    },
    control: {
      state: readiness.controlState,
      ready: readiness.ready,
      currentAction: agent?.current_control_action ?? "",
      startedAt: agent?.control_started_at ?? "",
      lastSuccessAt: agent?.last_control_success_at ?? "",
      lastError: agent?.last_control_error ?? "",
      loopAlive: agent?.control_loop_alive === 1,
      loopLastSeen: agent?.control_loop_last_seen ?? "",
      reasonCode: readiness.reasonCode,
      reason: readiness.reason,
    },
    manager: {
      state: readiness.managerState,
      visible: agent?.manager_visible === 1,
      probeAt: agent?.manager_probe_at ?? "",
      probeSuccessCount: Number(agent?.manager_probe_success_count) || 0,
      modalActive: agent?.manager_modal_active === 1,
      stale: agent?.state_stale === 1,
    },
    payment: terminal,
    kiosk: {
      online: kioskOnline,
      kioskId: kiosk?.kiosk_id ?? "main-kiosk",
      currentVisitId: kiosk?.current_visit_id ?? "",
      currentStatus: kiosk?.current_status ?? "UNKNOWN",
      lastSeen: kiosk?.last_seen ?? "",
    },
    rooms: rooms.results
      .map((room) => {
        const roomStateFresh = isRecent(room.room_observed_at, 10_000);
        const roomReadiness = (requestedAction: string) => evaluateRoomCommandReadiness(readiness, {
          roomControlState: roomStateFresh ? room.room_control_state : "STALE",
          currentCommandId: room.current_command_id,
          lastAction: room.current_control_action,
          requestedAction,
        });
        const setInfoReadiness = roomReadiness("set_info");
        const startReadiness = roomReadiness("start");
        const stopReadiness = roomReadiness("stop");
        return {
          roomId: room.room_id,
          code: ROOM_OPTIONS.find((option) => option.roomId === room.room_id)?.code ?? room.name,
          name: room.name,
          size: room.size,
          status: room.status,
          teamName: room.team_name,
          mapName: room.map_name,
          mapIndex: room.map_index,
          people: room.people,
          remainingSeconds: room.remaining_seconds,
          gameStartedAt: room.game_started_at ?? "",
          updatedAt: room.updated_at,
          controlState: room.room_control_state,
          currentControlAction: room.current_control_action,
          currentCommandId: room.current_command_id,
          lastControlSuccessAt: room.room_last_success_at ?? "",
          lastControlErrorCode: room.room_last_error_code,
          lastControlError: room.room_last_error,
          lastControlErrorAt: room.room_last_error_at ?? "",
          stateSeenAt: room.room_state_seen_at ?? room.updated_at,
          stateFresh: roomStateFresh,
          canSetInfo: setInfoReadiness.ready,
          canStart: startReadiness.ready,
          canStop: stopReadiness.ready,
          controlReasonCode: startReadiness.reasonCode,
          controlReason: startReadiness.reason,
        };
      })
      .sort((left, right) => (roomOrder.get(left.roomId) ?? 99) - (roomOrder.get(right.roomId) ?? 99)),
    visits: operations.visits,
    recentCommands: commands.results.map((command) => ({
      id: command.id,
      roomId: command.room_id,
      action: command.action,
      status: command.status,
      result: command.result,
      createdAt: command.created_at,
      completedAt: command.completed_at ?? "",
    })),
  };
}
