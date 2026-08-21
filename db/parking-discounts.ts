import { getD1 } from "./control";

export const PARKING_REQUEST_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SUCCESS",
  "SKIPPED",
  "NOT_FOUND",
  "DISABLED",
  "SESSION_EXPIRED",
  "LIMIT_EXCEEDED",
  "INVALID_DISCOUNT",
  "AMBIGUOUS_RESULT",
  "NEEDS_REVIEW",
  "FAILED",
] as const;

export type ParkingRequestStatus = typeof PARKING_REQUEST_STATUSES[number];
export const PARKING_MAX_DISCOUNT_MINUTES = 270;

export type ParkingDiscountResult = {
  entryId: string;
  carNo: string;
  entryTime: string;
  beforeMinutes: number;
  action: string;
  addedMinutes: number;
  afterMinutes: number;
  status: ParkingRequestStatus;
  message: string;
};

type ParkingRequestRow = {
  id: string;
  idempotency_key: string;
  reservation_id: string;
  trigger_mode: string;
  car_last4: string;
  status: ParkingRequestStatus;
  match_count: number;
  results_json: string;
  error_code: string;
  error_message: string;
  dry_run: number;
  requested_by: string;
  command_id: string;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export type ParkingDiscountRequest = {
  id: string;
  idempotencyKey: string;
  reservationId: string;
  triggerMode: "auto" | "manual";
  carLast4: string;
  status: ParkingRequestStatus;
  matchCount: number;
  results: ParkingDiscountResult[];
  errorCode: string;
  errorMessage: string;
  dryRun: boolean;
  commandId: string;
  createdAt: string;
  claimedAt: string;
  completedAt: string;
  updatedAt: string;
};

let schemaReady: Promise<void> | null = null;

async function initializeSchema() {
  const db = getD1();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS parking_discount_requests (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        reservation_id TEXT NOT NULL DEFAULT '',
        trigger_mode TEXT NOT NULL DEFAULT 'manual',
        car_last4 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        match_count INTEGER NOT NULL DEFAULT 0,
        results_json TEXT NOT NULL DEFAULT '[]',
        error_code TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        dry_run INTEGER NOT NULL DEFAULT 0,
        requested_by TEXT NOT NULL,
        command_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        claimed_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS parking_discount_requests_idempotency_idx
      ON parking_discount_requests(idempotency_key)
    `),
    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS parking_discount_requests_command_idx
      ON parking_discount_requests(command_id)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS parking_discount_requests_status_created_idx
      ON parking_discount_requests(status, created_at)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS parking_discount_requests_reservation_idx
      ON parking_discount_requests(reservation_id, created_at)
    `),
  ]);
}

export async function ensureParkingDiscountSchema() {
  if (!schemaReady) {
    schemaReady = initializeSchema().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function parseResults(value: string): ParkingDiscountResult[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is ParkingDiscountResult => Boolean(item) && typeof item === "object").slice(0, 50)
      : [];
  } catch {
    return [];
  }
}

function mapRequest(row: ParkingRequestRow): ParkingDiscountRequest {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    reservationId: row.reservation_id,
    triggerMode: row.trigger_mode === "auto" ? "auto" : "manual",
    carLast4: row.car_last4,
    status: row.status,
    matchCount: row.match_count,
    results: parseResults(row.results_json),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    dryRun: row.dry_run === 1,
    commandId: row.command_id,
    createdAt: row.created_at,
    claimedAt: row.claimed_at ?? "",
    completedAt: row.completed_at ?? "",
    updatedAt: row.updated_at,
  };
}

const REQUEST_COLUMNS = `
  id, idempotency_key, reservation_id, trigger_mode, car_last4, status, match_count, results_json,
  error_code, error_message, dry_run, requested_by, command_id,
  created_at, claimed_at, completed_at, updated_at
`;

export async function getParkingDiscountRequest(id: string) {
  await ensureParkingDiscountSchema();
  const row = await getD1().prepare(`
    SELECT ${REQUEST_COLUMNS} FROM parking_discount_requests WHERE id = ?
  `).bind(id).first<ParkingRequestRow>();
  return row ? mapRequest(row) : null;
}

export async function getParkingDiscountRequestByIdempotency(idempotencyKey: string) {
  await ensureParkingDiscountSchema();
  const row = await getD1().prepare(`
    SELECT ${REQUEST_COLUMNS} FROM parking_discount_requests WHERE idempotency_key = ?
  `).bind(idempotencyKey).first<ParkingRequestRow>();
  return row ? mapRequest(row) : null;
}

export async function createParkingDiscountRequest(input: {
  id: string;
  idempotencyKey: string;
  reservationId: string;
  triggerMode: "auto" | "manual";
  carLast4: string;
  requestedBy: string;
  commandId: string;
  agentId: string;
}) {
  await ensureParkingDiscountSchema();
  const db = getD1();
  const expiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
  const payload = JSON.stringify({
    requestId: input.id,
    idempotencyKey: input.idempotencyKey,
    reservationId: input.reservationId,
    triggerMode: input.triggerMode,
    carLast4: input.carLast4,
  });
  await db.batch([
    db.prepare(`
      INSERT INTO parking_discount_requests
        (id, idempotency_key, reservation_id, trigger_mode, car_last4, requested_by, command_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.idempotencyKey,
      input.reservationId,
      input.triggerMode,
      input.carLast4,
      input.requestedBy,
      input.commandId,
    ),
    db.prepare(`
      INSERT INTO commands
        (id, room_id, action, payload_json, status, requested_by, target_agent_id, expires_at)
      VALUES (?, 'PARKING', 'parking_register', ?, 'pending', ?, ?, ?)
    `).bind(input.commandId, payload, input.requestedBy, input.agentId, expiresAt),
    db.prepare(`
      UPDATE reservations SET
        vehicle_last4 = ?, parking_registration_status = 'PENDING',
        parking_registration_request_id = ?, parking_registered_vehicle_last4 = '',
        parking_registration_completed_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status <> 'cancelled'
    `).bind(input.carLast4, input.id, input.reservationId),
  ]);
  return getParkingDiscountRequest(input.id);
}

export async function markParkingRequestClaimed(commandIds: string[]) {
  if (!commandIds.length) return;
  await ensureParkingDiscountSchema();
  const placeholders = commandIds.map(() => "?").join(",");
  await getD1().prepare(`
    UPDATE parking_discount_requests
    SET status = 'PROCESSING', claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE command_id IN (${placeholders}) AND status = 'PENDING'
  `).bind(...commandIds).run();
  await getD1().prepare(`
    UPDATE reservations SET parking_registration_status = 'PROCESSING', updated_at = CURRENT_TIMESTAMP
    WHERE parking_registration_request_id IN (
      SELECT id FROM parking_discount_requests WHERE command_id IN (${placeholders})
    ) AND parking_registration_status = 'PENDING'
  `).bind(...commandIds).run();
}

export async function maintainParkingDiscountRequests() {
  await ensureParkingDiscountSchema();
  const db = getD1();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`
      UPDATE commands SET
        status = 'failed',
        result = CASE
          WHEN status = 'claimed' THEN '주차등록 응답 시간 초과 - 수동 확인 필요'
          ELSE '주차등록 명령 유효시간 초과 - 수동 확인 필요'
        END,
        completed_at = CURRENT_TIMESTAMP
      WHERE action = 'parking_register'
        AND status IN ('pending', 'claimed')
        AND (
          expires_at <= ?
          OR (status = 'claimed' AND claimed_at < datetime('now', '-60 seconds'))
        )
    `).bind(now),
    db.prepare(`
      UPDATE parking_discount_requests SET
        status = 'NEEDS_REVIEW',
        error_code = CASE
          WHEN COALESCE((SELECT result FROM commands WHERE id = command_id), '') LIKE '%시간 초과%'
            THEN 'COMMAND_TIMEOUT'
          ELSE 'COMMAND_FAILED'
        END,
        error_message = COALESCE(
          NULLIF((SELECT result FROM commands WHERE id = command_id), ''),
          '주차등록 명령을 완료하지 못했습니다. 수동으로 확인해주세요.'
        ),
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('PENDING', 'PROCESSING')
        AND command_id IN (
          SELECT id FROM commands
          WHERE action = 'parking_register' AND status = 'failed'
        )
    `),
    db.prepare(`
      UPDATE reservations SET
        parking_registration_status = 'NEEDS_REVIEW',
        parking_registration_completed_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE parking_registration_status IN ('PENDING', 'PROCESSING')
        AND parking_registration_request_id IN (
          SELECT id FROM parking_discount_requests WHERE status = 'NEEDS_REVIEW'
        )
    `),
  ]);
}

function cleanResult(value: unknown): ParkingDiscountResult | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const status = String(source.status ?? "FAILED") as ParkingRequestStatus;
  if (!PARKING_REQUEST_STATUSES.includes(status)) return null;
  const carNo = String(source.carNo ?? "").replace(/[^0-9*]/g, "").slice(-12);
  return {
    entryId: String(source.entryId ?? "").slice(0, 100),
    carNo,
    entryTime: String(source.entryTime ?? "").slice(0, 40),
    beforeMinutes: Math.max(0, Math.min(PARKING_MAX_DISCOUNT_MINUTES, Math.trunc(Number(source.beforeMinutes) || 0))),
    action: String(source.action ?? "").slice(0, 40),
    addedMinutes: Math.max(0, Math.min(PARKING_MAX_DISCOUNT_MINUTES, Math.trunc(Number(source.addedMinutes) || 0))),
    afterMinutes: Math.max(0, Math.min(PARKING_MAX_DISCOUNT_MINUTES, Math.trunc(Number(source.afterMinutes) || 0))),
    status,
    message: String(source.message ?? "").slice(0, 200),
  };
}

export async function completeParkingDiscountRequest(input: {
  commandId: string;
  commandStatus: "completed" | "failed";
  status: ParkingRequestStatus;
  matchCount: number;
  results: unknown[];
  errorCode: string;
  errorMessage: string;
  dryRun: boolean;
}) {
  await ensureParkingDiscountSchema();
  const results = input.results.map(cleanResult).filter((item): item is ParkingDiscountResult => Boolean(item)).slice(0, 50);
  const status = PARKING_REQUEST_STATUSES.includes(input.status)
    ? input.status
    : input.commandStatus === "completed" ? "SUCCESS" : "FAILED";
  const reservationStatus = ["SUCCESS", "SKIPPED", "LIMIT_EXCEEDED"].includes(status)
    ? "SUCCESS"
    : status;
  await getD1().batch([
    getD1().prepare(`
      UPDATE commands SET status = ?, result = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'claimed'
    `).bind(
      input.commandStatus,
      input.errorMessage.slice(0, 500),
      input.commandId,
    ),
    getD1().prepare(`
      UPDATE parking_discount_requests SET
        status = ?, match_count = ?, results_json = ?, error_code = ?,
        error_message = ?, dry_run = ?, completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE command_id = ?
    `).bind(
      status,
      Math.max(0, Math.min(100, Math.trunc(input.matchCount) || 0)),
      JSON.stringify(results),
      input.errorCode.slice(0, 80),
      input.errorMessage.slice(0, 500),
      input.dryRun ? 1 : 0,
      input.commandId,
    ),
    getD1().prepare(`
      UPDATE reservations SET
        parking_registration_status = ?,
        parking_registered_vehicle_last4 = CASE WHEN ? = 'SUCCESS' THEN vehicle_last4 ELSE '' END,
        parking_registration_completed_at = CASE WHEN ? = 'SUCCESS' THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP
      WHERE parking_registration_request_id = (
        SELECT id FROM parking_discount_requests WHERE command_id = ?
      )
    `).bind(reservationStatus, reservationStatus, reservationStatus, input.commandId),
  ]);
  const row = await getD1().prepare(`
    SELECT ${REQUEST_COLUMNS} FROM parking_discount_requests WHERE command_id = ?
  `).bind(input.commandId).first<ParkingRequestRow>();
  return row ? mapRequest(row) : null;
}
