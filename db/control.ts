import { env } from "cloudflare:workers";
import { GAME_MINUTES } from "@/app/admin/availability";
import {
  evaluateControlReadiness,
  evaluateRoomCommandReadiness,
  normalizeControlTimestamp,
  resolveRoomControlEventTimestamp,
  type ControlReadiness,
  type RoomCommandReadiness,
} from "./control-readiness";

type ControlEnv = {
  DB?: D1Database;
  JUMPING_AGENT_TOKEN?: string;
  JUMPING_AGENT_ID?: string;
  PAYMENT_EXPLICIT_EXECUTION_V2?: string;
  PAYMENT_TRANSPORT?: string;
  LOCAL_PAYMENT_BRIDGE_URL?: string;
};

const DEFAULT_AGENT_ID = "store-main";

const INITIAL_ROOMS = [
  ["0", "A1(중)", "중형"],
  ["1", "C1(소)", "소형"],
  ["2", "B1(대)", "대형"],
  ["3", "C2(소2)", "소형"],
] as const;

export type RoomUpdate = {
  roomId: string;
  status?: string;
  teamName?: string;
  mapName?: string;
  mapIndex?: number;
  mapOptions?: string[];
  people?: number;
  remainingSeconds?: number;
  score?: number;
  level?: string;
};

export type RoomTransition = {
  roomId: string;
  previousStatus: string;
  nextStatus: string;
  previousTeamName: string;
  nextTeamName: string;
  previousMapName: string;
  nextMapName: string;
  previousPeople: number;
  nextPeople: number;
  previousScore: number;
  nextScore: number;
  previousLevel: string;
  nextLevel: string;
  nextRemainingSeconds: number;
  gameStartedAt: string;
};

export type RoomControlUpdate = {
  roomId: string;
  state: string;
  action?: string;
  commandId?: string;
  errorCode?: string;
  errorMessage?: string;
  occurredAt?: string;
  lastSuccessAt?: string;
  updatedAt?: string;
};

export function getControlEnv(): ControlEnv {
  return env as unknown as ControlEnv;
}

export function getD1(): D1Database {
  const database = getControlEnv().DB;
  if (!database) {
    throw new Error("점핑배틀 제어 데이터베이스 연결이 준비되지 않았습니다.");
  }
  return database;
}

export function getControlAgentId() {
  return String(getControlEnv().JUMPING_AGENT_ID ?? DEFAULT_AGENT_ID).trim() || DEFAULT_AGENT_ID;
}

export function paymentExplicitExecutionV2Enabled() {
  return /^(1|true|on|yes)$/i.test(
    String(getControlEnv().PAYMENT_EXPLICIT_EXECUTION_V2 ?? "").trim(),
  );
}

let controlSchemaReady: Promise<void> | null = null;

async function initializeControlSchema() {
  const db = getD1();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        size TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        team_name TEXT NOT NULL DEFAULT '',
        map_name TEXT NOT NULL DEFAULT '',
        map_index INTEGER NOT NULL DEFAULT 0,
        people INTEGER NOT NULL DEFAULT 0,
        remaining_seconds INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        level TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        version TEXT NOT NULL DEFAULT '',
        last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS agent_runtime (
        agent_id TEXT PRIMARY KEY,
        armed INTEGER NOT NULL DEFAULT 0,
        simulate INTEGER NOT NULL DEFAULT 0,
        manager_visible INTEGER NOT NULL DEFAULT 0,
        bridge_instance_id TEXT NOT NULL DEFAULT '',
        control_state TEXT NOT NULL DEFAULT 'IDLE',
        current_control_action TEXT NOT NULL DEFAULT '',
        control_started_at TEXT,
        last_control_success_at TEXT,
        last_control_error TEXT NOT NULL DEFAULT '',
        state_stale INTEGER NOT NULL DEFAULT 0,
        manager_state TEXT NOT NULL DEFAULT 'UNAVAILABLE',
        manager_probe_at TEXT,
        manager_probe_success_count INTEGER NOT NULL DEFAULT 0,
        manager_modal_active INTEGER NOT NULL DEFAULT 0,
        control_loop_last_seen TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS room_game_runtime (
        room_id TEXT PRIMARY KEY,
        game_started_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS room_metadata (
        room_id TEXT PRIMARY KEY,
        map_options_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS room_control_runtime (
        room_id TEXT PRIMARY KEY,
        control_state TEXT NOT NULL DEFAULT 'READY',
        current_action TEXT NOT NULL DEFAULT '',
        current_command_id TEXT NOT NULL DEFAULT '',
        last_success_at TEXT,
        last_error_code TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        last_error_at TEXT,
        state_seen_at TEXT,
        observed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        requested_by TEXT NOT NULL,
        target_agent_id TEXT NOT NULL DEFAULT 'store-main',
        result TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS commands_status_created_idx
      ON commands(status, created_at)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS commands_agent_status_created_idx
      ON commands(target_agent_id, status, created_at)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS commands_room_status_idx
      ON commands(room_id, status)
    `),
    db.prepare(`
      CREATE TRIGGER IF NOT EXISTS commands_control_active_insert_guard
      BEFORE INSERT ON commands
      WHEN NEW.action IN ('set_info', 'start', 'stop', 'all_stop')
        AND NEW.status IN ('pending', 'claimed')
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM commands existing
          WHERE existing.action IN ('set_info', 'start', 'stop', 'all_stop')
            AND existing.status IN ('pending', 'claimed')
            AND (
              NEW.room_id = 'ALL'
              OR existing.room_id = 'ALL'
              OR existing.room_id = NEW.room_id
            )
        ) THEN RAISE(ABORT, 'CONTROL_ROOM_BUSY') END;
      END
    `),
    db.prepare(`
      CREATE TRIGGER IF NOT EXISTS commands_control_pending_runtime_insert
      AFTER INSERT ON commands
      WHEN NEW.action IN ('set_info', 'start', 'stop', 'all_stop')
        AND NEW.status IN ('pending', 'claimed')
      BEGIN
        INSERT INTO room_control_runtime
          (room_id, control_state, current_action, current_command_id,
           state_seen_at, observed_at, updated_at)
        SELECT room_id, 'CONTROL_PENDING', NEW.action, NEW.id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM rooms
        WHERE NEW.room_id = 'ALL' OR room_id = NEW.room_id
        ON CONFLICT(room_id) DO UPDATE SET
          control_state = 'CONTROL_PENDING',
          current_action = NEW.action,
          current_command_id = NEW.id,
          state_seen_at = excluded.state_seen_at,
          observed_at = excluded.observed_at,
          updated_at = excluded.updated_at;
      END
    `),
    db.prepare(`
      CREATE TRIGGER IF NOT EXISTS commands_control_active_update_guard
      BEFORE UPDATE OF room_id, action, status ON commands
      WHEN NEW.action IN ('set_info', 'start', 'stop', 'all_stop')
        AND NEW.status IN ('pending', 'claimed')
        AND (
          OLD.action NOT IN ('set_info', 'start', 'stop', 'all_stop')
          OR OLD.status NOT IN ('pending', 'claimed')
          OR OLD.room_id <> NEW.room_id
        )
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM commands existing
          WHERE existing.id <> OLD.id
            AND existing.action IN ('set_info', 'start', 'stop', 'all_stop')
            AND existing.status IN ('pending', 'claimed')
            AND (
              NEW.room_id = 'ALL'
              OR existing.room_id = 'ALL'
              OR existing.room_id = NEW.room_id
            )
        ) THEN RAISE(ABORT, 'CONTROL_ROOM_BUSY') END;
      END
    `),
    db.prepare(`
      CREATE TRIGGER IF NOT EXISTS commands_control_pending_runtime_update
      AFTER UPDATE OF room_id, action, status ON commands
      WHEN NEW.action IN ('set_info', 'start', 'stop', 'all_stop')
        AND NEW.status IN ('pending', 'claimed')
        AND (
          OLD.action NOT IN ('set_info', 'start', 'stop', 'all_stop')
          OR OLD.status NOT IN ('pending', 'claimed')
          OR OLD.room_id <> NEW.room_id
        )
      BEGIN
        INSERT INTO room_control_runtime
          (room_id, control_state, current_action, current_command_id,
           state_seen_at, observed_at, updated_at)
        SELECT room_id, 'CONTROL_PENDING', NEW.action, NEW.id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM rooms
        WHERE NEW.room_id = 'ALL' OR room_id = NEW.room_id
        ON CONFLICT(room_id) DO UPDATE SET
          control_state = 'CONTROL_PENDING',
          current_action = NEW.action,
          current_command_id = NEW.id,
          state_seen_at = excluded.state_seen_at,
          observed_at = excluded.observed_at,
          updated_at = excluded.updated_at;
      END
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS pin_attempts (
        client_key TEXT PRIMARY KEY,
        failures INTEGER NOT NULL DEFAULT 0,
        window_started INTEGER NOT NULL DEFAULT 0,
        blocked_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `),
  ]);

  await db.batch(
    INITIAL_ROOMS.map(([roomId, name, size]) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO rooms (room_id, name, size) VALUES (?, ?, ?)`,
        )
        .bind(roomId, name, size),
    ),
  );
  await db.prepare(`
    INSERT OR IGNORE INTO room_control_runtime (room_id)
    SELECT room_id FROM rooms
  `).run();
}

export function isControlCommandBusyError(error: unknown) {
  return String(error instanceof Error ? error.message : error).includes("CONTROL_ROOM_BUSY");
}

export async function ensureControlSchema() {
  if (!controlSchemaReady) {
    controlSchemaReady = initializeControlSchema().catch((error) => {
      controlSchemaReady = null;
      throw error;
    });
  }
  await controlSchemaReady;
}

type ControlReadinessRow = {
  online: number;
  armed: number;
  manager_visible: number;
  control_state: string;
  state_stale: number;
  manager_state: string;
  manager_modal_active: number;
  manager_probe_fresh: number;
  control_loop_alive: number;
};

export async function getControlCommandReadiness(
  roomId = "",
  requestedAction = "",
): Promise<ControlReadiness | RoomCommandReadiness> {
  await ensureControlSchema();
  const db = getD1();
  const [row, room] = await Promise.all([
    db.prepare(`
    SELECT
      CASE WHEN agents.last_seen > datetime('now', '-25 seconds') THEN 1 ELSE 0 END AS online,
      COALESCE(agent_runtime.armed, 0) AS armed,
      COALESCE(agent_runtime.manager_visible, 0) AS manager_visible,
      COALESCE(agent_runtime.control_state, 'IDLE') AS control_state,
      COALESCE(agent_runtime.state_stale, 0) AS state_stale,
      COALESCE(agent_runtime.manager_state,
        CASE
          WHEN COALESCE(agent_runtime.manager_visible, 0) = 0 THEN 'UNAVAILABLE'
          WHEN COALESCE(agent_runtime.state_stale, 0) = 1 THEN 'STALE'
          ELSE 'AVAILABLE'
        END
      ) AS manager_state,
      COALESCE(agent_runtime.manager_modal_active, 0) AS manager_modal_active,
      CASE WHEN datetime(agent_runtime.manager_probe_at) > datetime('now', '-10 seconds')
        THEN 1 ELSE 0 END AS manager_probe_fresh,
      CASE WHEN datetime(agent_runtime.control_loop_last_seen) > datetime('now', '-10 seconds')
        THEN 1 ELSE 0 END AS control_loop_alive
    FROM agents
    LEFT JOIN agent_runtime ON agent_runtime.agent_id = agents.agent_id
    ORDER BY agents.last_seen DESC LIMIT 1
    `).first<ControlReadinessRow>(),
    roomId && roomId !== "ALL"
      ? db.prepare(`SELECT control_state, current_command_id, current_action,
          CASE WHEN datetime(observed_at) > datetime('now', '-10 seconds') THEN 1 ELSE 0 END AS state_fresh
          FROM room_control_runtime WHERE room_id = ? LIMIT 1`)
        .bind(roomId).first<{ control_state: string; current_command_id: string; current_action: string; state_fresh: number }>()
      : Promise.resolve(null),
  ]);

  const readiness = evaluateControlReadiness({
    bridgeOnline: row?.online === 1,
    armed: row?.armed === 1,
    controlState: row?.control_state ?? "ERROR",
    controlLoopAlive: row?.control_loop_alive === 1,
    managerProbeFresh: row?.manager_probe_fresh === 1,
    managerState: row?.manager_state ?? "UNAVAILABLE",
    managerModalActive: row?.manager_modal_active === 1,
    stateStale: row?.state_stale === 1,
  });
  if (!roomId || roomId === "ALL") return readiness;
  return evaluateRoomCommandReadiness(readiness, {
    roomControlState: room?.state_fresh === 0 ? "STALE" : room?.control_state ?? "READY",
    currentCommandId: room?.current_command_id ?? "",
    lastAction: room?.current_action ?? "",
    requestedAction,
  });
}

export async function assertControlCommandReady(roomId = "", requestedAction = "") {
  const readiness = await getControlCommandReadiness(roomId, requestedAction);
  if (!readiness.ready) {
    const error = new Error(readiness.reason) as Error & { code?: string };
    error.code = readiness.reasonCode;
    throw error;
  }
  return readiness;
}

function normalizeRoomControlState(value: unknown) {
  const state = String(value ?? "READY").toUpperCase();
  return ["READY", "CONTROL_PENDING", "SET_INFO_FAILED", "CONTROL_FAILED", "STALE"]
    .includes(state) ? state : "CONTROL_FAILED";
}

export async function upsertRoomControlStates(updates: RoomControlUpdate[]) {
  const byRoom = new Map<string, RoomControlUpdate>();
  for (const update of updates) {
    const roomId = String(update.roomId);
    if (["0", "1", "2", "3"].includes(roomId)) byRoom.set(roomId, { ...update, roomId });
  }
  const safe = [...byRoom.values()];
  if (!safe.length) return;
  await ensureControlSchema();
  const db = getD1();
  const statements = safe.flatMap((update) => {
    const observedAt = new Date().toISOString();
    const state = normalizeRoomControlState(update.state);
    const occurredAt = normalizeControlTimestamp(update.occurredAt);
    const lastSuccessAt = normalizeControlTimestamp(update.lastSuccessAt);
    const stateSeenAt = resolveRoomControlEventTimestamp({
      state,
      updatedAt: update.updatedAt,
      occurredAt,
      lastSuccessAt,
      nowIso: new Date().toISOString(),
    });
    if (!stateSeenAt) return [];
    return [db.prepare(`
      INSERT INTO room_control_runtime
        (room_id, control_state, current_action, current_command_id, last_success_at,
         last_error_code, last_error, last_error_at, state_seen_at, observed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        control_state = excluded.control_state,
        current_action = excluded.current_action,
        current_command_id = excluded.current_command_id,
        last_success_at = COALESCE(excluded.last_success_at, room_control_runtime.last_success_at),
        last_error_code = excluded.last_error_code,
        last_error = excluded.last_error,
        last_error_at = excluded.last_error_at,
        state_seen_at = excluded.state_seen_at,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
      WHERE (
          excluded.state_seen_at > COALESCE(room_control_runtime.state_seen_at, '')
          OR (
            excluded.state_seen_at = COALESCE(room_control_runtime.state_seen_at, '')
            AND (
              excluded.control_state <> 'CONTROL_PENDING'
              OR room_control_runtime.control_state = 'CONTROL_PENDING'
            )
          )
        )
        AND NOT (
          excluded.control_state = 'READY'
          AND room_control_runtime.control_state IN ('CONTROL_PENDING', 'SET_INFO_FAILED', 'CONTROL_FAILED')
        )
    `).bind(
      String(update.roomId), state, String(update.action ?? "").slice(0, 40),
      String(update.commandId ?? "").slice(0, 80), lastSuccessAt,
      String(update.errorCode ?? "").slice(0, 80), String(update.errorMessage ?? "").slice(0, 300),
      state === "SET_INFO_FAILED" || state === "CONTROL_FAILED" ? occurredAt : null,
      stateSeenAt, observedAt, observedAt,
    )];
  });
  if (!statements.length) return;
  await db.batch(statements);
}

export async function markRoomControlsPending(inputs: Array<{
  roomId: string;
  action: string;
  commandId: string;
}>) {
  const now = new Date().toISOString();
  await upsertRoomControlStates(inputs.flatMap((input) => {
    const targets = input.roomId === "ALL" ? INITIAL_ROOMS.map(([roomId]) => roomId) : [input.roomId];
    return targets.map((roomId) => ({
      roomId,
      state: "CONTROL_PENDING",
      action: input.action,
      commandId: input.commandId,
      updatedAt: now,
    }));
  }));
}

export async function markRoomControlPending(input: {
  roomId: string;
  action: string;
  commandId: string;
}) {
  await markRoomControlsPending([input]);
}

type ControlCommandAckRow = {
  id: string;
  room_id: string;
  action: string;
  payload_json: string;
  status: string;
  result: string;
  completed_at: string | null;
};

function controlRoomTargets(roomId: string) {
  return roomId === "ALL" ? INITIAL_ROOMS.map(([targetRoomId]) => targetRoomId) : [roomId];
}

function finalRoomControlState(input: {
  action: string;
  succeeded: boolean;
  roomControlState?: string;
}) {
  if (input.succeeded) return "READY";
  const explicit = String(input.roomControlState ?? "").toUpperCase();
  if (explicit === "SET_INFO_FAILED" || explicit === "CONTROL_FAILED") return explicit;
  return input.action === "set_info" ? "SET_INFO_FAILED" : "CONTROL_FAILED";
}

function roomControlFinalStatements(
  db: D1Database,
  input: {
    roomId: string;
    action: string;
    commandId: string;
    succeeded: boolean;
    roomControlState?: string;
    errorCode?: string;
    result?: string;
    finalizedAt: string;
    requireCommandFinalizedAt?: string;
    requireCommandStatus?: string;
  },
) {
  const state = finalRoomControlState(input);
  const currentAction = input.succeeded ? "" : state === "SET_INFO_FAILED" ? "set_info" : input.action;
  const errorCode = input.succeeded
    ? ""
    : String(input.errorCode || state).trim().slice(0, 80);
  const errorMessage = input.succeeded ? "" : String(input.result ?? "").trim().slice(0, 300);
  return controlRoomTargets(input.roomId).map((roomId) => db.prepare(`
    UPDATE room_control_runtime SET
      control_state = ?,
      current_action = ?,
      current_command_id = '',
      last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
      last_error_code = ?,
      last_error = ?,
      last_error_at = CASE WHEN ? = 1 THEN NULL ELSE ? END,
      state_seen_at = ?,
      observed_at = ?,
      updated_at = ?
    WHERE room_id = ?
      AND current_command_id = ?
      AND EXISTS (
        SELECT 1 FROM commands
        WHERE id = ? AND status = ?
          AND (? = '' OR completed_at = ?)
      )
  `).bind(
    state,
    currentAction,
    input.succeeded ? 1 : 0,
    input.finalizedAt,
    errorCode,
    errorMessage,
    input.succeeded ? 1 : 0,
    input.finalizedAt,
    input.finalizedAt,
    input.finalizedAt,
    input.finalizedAt,
    roomId,
    input.commandId,
    input.commandId,
    input.requireCommandStatus ?? (input.succeeded ? "completed" : "failed"),
    input.requireCommandFinalizedAt ?? "",
    input.requireCommandFinalizedAt ?? "",
  ));
}

export async function markRoomControlResult(input: {
  roomId: string;
  action: string;
  commandId: string;
  succeeded: boolean;
  roomControlState?: string;
  errorCode?: string;
  result?: string;
}) {
  await ensureControlSchema();
  const db = getD1();
  const now = new Date().toISOString();
  await db.batch(roomControlFinalStatements(db, {
    ...input,
    finalizedAt: now,
  }));
}

export async function finalizeCommandAck(input: {
  commandId: string;
  status: "completed" | "failed";
  result?: string;
  roomControlState?: string;
  errorCode?: string;
}) {
  await ensureControlSchema();
  const db = getD1();
  const succeeded = input.status === "completed";
  const finalizedAt = new Date().toISOString();
  const explicitRoomState = ["SET_INFO_FAILED", "CONTROL_FAILED"].includes(
    String(input.roomControlState ?? "").toUpperCase(),
  ) ? String(input.roomControlState).toUpperCase() : "";
  const cleanResult = String(input.result ?? "").trim().slice(0, 4000);
  const cleanErrorCode = String(input.errorCode ?? "").trim().slice(0, 80);
  const results = await db.batch([
    db.prepare(`UPDATE commands SET status = ?, result = ?, completed_at = ?
      WHERE id = ? AND status = 'claimed'
      RETURNING id, room_id, action, payload_json, status, result, completed_at`)
      .bind(input.status, cleanResult, finalizedAt, input.commandId),
    db.prepare(`UPDATE room_control_runtime SET
      control_state = CASE
        WHEN ? = 'completed' THEN 'READY'
        WHEN ? <> '' THEN ?
        WHEN (SELECT action FROM commands WHERE id = ?) = 'set_info' THEN 'SET_INFO_FAILED'
        ELSE 'CONTROL_FAILED'
      END,
      current_action = CASE
        WHEN ? = 'completed' THEN ''
        WHEN ? = 'SET_INFO_FAILED' THEN 'set_info'
        WHEN ? = '' AND (SELECT action FROM commands WHERE id = ?) = 'set_info' THEN 'set_info'
        ELSE COALESCE((SELECT action FROM commands WHERE id = ?), '')
      END,
      current_command_id = '',
      last_success_at = CASE WHEN ? = 'completed' THEN ? ELSE last_success_at END,
      last_error_code = CASE
        WHEN ? = 'completed' THEN ''
        WHEN ? <> '' THEN ?
        WHEN ? = 'SET_INFO_FAILED' THEN 'SET_INFO_FAILED'
        WHEN ? = '' AND (SELECT action FROM commands WHERE id = ?) = 'set_info' THEN 'SET_INFO_FAILED'
        ELSE 'CONTROL_FAILED'
      END,
      last_error = CASE WHEN ? = 'completed' THEN '' ELSE ? END,
      last_error_at = CASE WHEN ? = 'completed' THEN NULL ELSE ? END,
      state_seen_at = ?,
      observed_at = ?,
      updated_at = ?
    WHERE current_command_id = ?
      AND EXISTS (
        SELECT 1 FROM commands finalized
        WHERE finalized.id = ?
          AND finalized.status = ?
          AND finalized.completed_at = ?
          AND finalized.action IN ('set_info', 'start', 'stop', 'all_stop')
          AND (finalized.room_id = room_control_runtime.room_id OR finalized.room_id = 'ALL')
      )`)
      .bind(
        input.status,
        explicitRoomState, explicitRoomState, input.commandId,
        input.status,
        explicitRoomState,
        explicitRoomState, input.commandId,
        input.commandId,
        input.status, finalizedAt,
        input.status,
        cleanErrorCode, cleanErrorCode,
        explicitRoomState,
        explicitRoomState, input.commandId,
        input.status, cleanResult,
        input.status, finalizedAt,
        finalizedAt,
        finalizedAt,
        finalizedAt,
        input.commandId,
        input.commandId,
        input.status,
        finalizedAt,
      ),
  ]);
  const saved = results[0] as D1Result<ControlCommandAckRow>;
  const command = saved.results?.[0];
  const newlyFinalized = Boolean(command);
  if (command) return { command, newlyFinalized, disposition: "FINALIZED" as const };

  const existing = await db.prepare(`SELECT id, room_id, action, payload_json, status, result, completed_at
    FROM commands WHERE id = ? LIMIT 1`)
    .bind(input.commandId).first<ControlCommandAckRow>();
  if (!existing) {
    return {
      command: null,
      newlyFinalized: false,
      disposition: "NOT_FOUND" as const,
    };
  }
  if (existing.result === "CONTROL_ACK_TIMEOUT_AMBIGUOUS") {
    return {
      command: existing,
      newlyFinalized: false,
      disposition: "CONFLICT" as const,
    };
  }
  if (
    existing.status === input.status
    && ["set_info", "start", "stop", "all_stop"].includes(existing.action)
  ) {
    await markRoomControlResult({
      roomId: existing.room_id,
      action: existing.action,
      commandId: existing.id,
      succeeded,
      roomControlState: input.roomControlState,
      errorCode: input.errorCode,
      result: existing.result || input.result,
    });
  }
  const duplicate = existing.status === input.status;
  return {
    command: existing,
    newlyFinalized: false,
    disposition: duplicate ? "DUPLICATE" as const : "CONFLICT" as const,
  };
}

export async function upsertRoom(update: RoomUpdate) {
  const db = getD1();
  const [current, currentRuntime] = await Promise.all([
    db
      .prepare(`SELECT * FROM rooms WHERE room_id = ?`)
      .bind(update.roomId)
      .first<Record<string, unknown>>(),
    db
      .prepare(`SELECT game_started_at FROM room_game_runtime WHERE room_id = ?`)
      .bind(update.roomId)
      .first<{ game_started_at: string | null }>(),
  ]);

  if (!current) return null;

  const nextStatus = String(update.status ?? current.status ?? "offline");
  const nextTeamName = String(update.teamName ?? current.team_name ?? "");
  const nextRemainingSeconds = Math.max(
    0,
    update.remainingSeconds ?? Number(current.remaining_seconds) ?? 0,
  );
  const previousRemainingSeconds = Math.max(
    0,
    Number(current.remaining_seconds) || 0,
  );
  const nextMapName = String(update.mapName ?? current.map_name ?? "");
  const nextPeople = Math.max(
    0,
    Number(update.people ?? current.people) || 0,
  );
  const nextScore = Math.max(
    0,
    Number(update.score ?? current.score) || 0,
  );
  const nextLevel = String(update.level ?? current.level ?? "");

  await db
    .prepare(`
      UPDATE rooms SET
        status = ?,
        team_name = ?,
        map_name = ?,
        map_index = ?,
        people = ?,
        remaining_seconds = ?,
        score = ?,
        level = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE room_id = ?
    `)
    .bind(
      nextStatus,
      nextTeamName,
      nextMapName,
      update.mapIndex ?? current.map_index ?? 0,
      nextPeople,
      nextRemainingSeconds,
      nextScore,
      nextLevel,
      update.roomId,
    )
    .run();
  const observedAt = new Date().toISOString();
  await db.prepare(`
    INSERT INTO room_control_runtime (room_id, observed_at, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET
      observed_at = excluded.observed_at,
      updated_at = excluded.updated_at
  `).bind(update.roomId, observedAt, observedAt).run();

  const gameRestarted =
    nextStatus === "running" &&
    (String(current.status ?? "offline") !== "running" ||
      !currentRuntime?.game_started_at ||
      nextRemainingSeconds > previousRemainingSeconds + 30);
  let gameStartedAt = currentRuntime?.game_started_at ?? null;

  if (gameRestarted) {
    const gameSeconds = GAME_MINUTES * 60;
    const elapsedSeconds = Math.max(
      0,
      gameSeconds - Math.min(gameSeconds, nextRemainingSeconds),
    );
    gameStartedAt = new Date(Date.now() - elapsedSeconds * 1_000).toISOString();
  } else if (nextStatus !== "running") {
    gameStartedAt = null;
  }

  await db
    .prepare(`
      INSERT INTO room_game_runtime (room_id, game_started_at, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(room_id) DO UPDATE SET
        game_started_at = excluded.game_started_at,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(update.roomId, gameStartedAt)
    .run();

  if (Array.isArray(update.mapOptions)) {
    const mapOptions = update.mapOptions
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 50);
    await db
      .prepare(`
        INSERT INTO room_metadata (room_id, map_options_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(room_id) DO UPDATE SET
          map_options_json = excluded.map_options_json,
          updated_at = CURRENT_TIMESTAMP
      `)
      .bind(update.roomId, JSON.stringify(mapOptions))
      .run();
  }

  return {
    roomId: update.roomId,
    previousStatus: String(current.status ?? "offline"),
    nextStatus,
    previousTeamName: String(current.team_name ?? ""),
    nextTeamName,
    previousMapName: String(current.map_name ?? ""),
    nextMapName,
    previousPeople: Math.max(0, Number(current.people) || 0),
    nextPeople,
    previousScore: Math.max(0, Number(current.score) || 0),
    nextScore,
    previousLevel: String(current.level ?? ""),
    nextLevel,
    nextRemainingSeconds,
    gameStartedAt: currentRuntime?.game_started_at ?? "",
  } satisfies RoomTransition;
}

export function isAgentAuthorized(request: Request) {
  const expected = getControlEnv().JUMPING_AGENT_TOKEN ?? "";
  const supplied = request.headers.get("x-jumping-agent-token") ?? "";
  if (!expected || expected.length !== supplied.length) return false;

  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return difference === 0;
}
