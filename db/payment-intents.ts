import { getControlAgentId, getControlEnv, getD1 } from "./control";
import {
  completePaymentCommand,
  completePaymentCommandDerived,
  getPaymentOverview,
  type PaymentDbTrace,
  type PaymentStageTrace,
} from "./payments";
import { normalizePaymentTraceId } from "./payment-latency";
import { normalizePaymentMethod } from "./payment-ledger";
import {
  evaluatePaymentExecutionGuard,
  PAYMENT_GUARD_ATTEMPTS_SQL,
  PAYMENT_GUARD_PAYMENT_SQL,
  PAYMENT_INTENT_SCHEMA_CHECK_SQL,
  paymentIntentSchemaIsReady,
} from "./payment-wave-guards";

export type PaymentTransport = "CLOUD_FAST_LANE" | "LOCAL_DIRECT";

export type SignedPaymentIntent = {
  version: 1;
  intent_id: string;
  reservation_id: string;
  payment_id: string;
  attempt_id: string;
  transaction_uuid: string;
  amount: number;
  payment_method: "CARD";
  issued_at: string;
  expires_at: string;
  nonce: string;
  trace_id: string;
  signature: string;
};

type PaymentIntentRow = {
  id: string;
  reservation_id: string;
  payment_id: string;
  attempt_id: string;
  transaction_uuid: string;
  amount: number;
  payment_method: string;
  request_key: string;
  nonce: string;
  version: number;
  signature: string;
  status: string;
  trace_id: string;
  issued_at: string;
  expires_at: string;
  result_json: string;
  cloud_synced_at: string | null;
};

type PaymentIntentSchemaRow = {
  column_count: number;
  index_count: number;
};

type IntentGuardPaymentRow = {
  id: string;
  reservation_id: string;
  split_count: number;
  status: string;
};

type IntentGuardAttemptRow = {
  id: string;
  reservation_id: string;
  payment_id: string | null;
  split_index: number;
  attempt_type: string;
  amount: number;
  payment_method: string;
  status: string;
  command_id: string | null;
  active_key: string | null;
};

const INTENT_VERSION = 1 as const;
const INTENT_TTL_MS = 75_000;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function assertPaymentIntentSchema(row?: PaymentIntentSchemaRow | null) {
  if (!paymentIntentSchemaIsReady(row)) {
    throw new Error("LOCAL_PAYMENT_SCHEMA_INVALID");
  }
}

function intentDbMetrics(value: unknown) {
  const results = Array.isArray(value) ? value : [value];
  let rowsRead = 0;
  let rowsWritten = 0;
  let observed = false;
  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    const meta = (result as { meta?: Record<string, unknown> }).meta;
    if (!meta) continue;
    const read = Number(meta.rows_read ?? meta.rowsRead);
    const written = Number(meta.rows_written ?? meta.rowsWritten ?? meta.changes);
    if (Number.isFinite(read)) {
      rowsRead += Math.max(0, read);
      observed = true;
    }
    if (Number.isFinite(written)) {
      rowsWritten += Math.max(0, written);
      observed = true;
    }
  }
  return {
    rowsRead: observed ? rowsRead : null,
    rowsWritten: observed ? rowsWritten : null,
  };
}

async function measureIntentDb<T>(
  trace: PaymentDbTrace | undefined,
  query: string,
  operation: () => Promise<T>,
  details: Record<string, unknown> = {},
) {
  const started = performance.now();
  try {
    const value = await operation();
    trace?.(query, performance.now() - started, {
      ...details,
      ...intentDbMetrics(value),
    });
    return value;
  } catch (error) {
    trace?.(query, performance.now() - started, {
      ...details,
      rowsRead: null,
      rowsWritten: null,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function paymentTransportConfiguration() {
  const env = getControlEnv();
  const requested = String(env.PAYMENT_TRANSPORT ?? "CLOUD_FAST_LANE").trim().toUpperCase();
  const transport: PaymentTransport = requested === "LOCAL_DIRECT"
    ? "LOCAL_DIRECT"
    : "CLOUD_FAST_LANE";
  const configuredUrl = String(env.LOCAL_PAYMENT_BRIDGE_URL ?? "http://127.0.0.1:8765").trim();
  let bridgeUrl = "";
  try {
    const parsed = new URL(configuredUrl);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && LOCAL_HOSTS.has(parsed.hostname)) {
      bridgeUrl = parsed.origin;
    }
  } catch {
    bridgeUrl = "";
  }
  return {
    transport,
    localDirectEnabled: transport === "LOCAL_DIRECT" && Boolean(bridgeUrl),
    bridgeUrl,
  };
}

export function canonicalPaymentIntent(intent: Omit<SignedPaymentIntent, "signature">) {
  return [
    "JUMPING_PAYMENT_INTENT_V1",
    String(intent.version),
    intent.intent_id,
    intent.reservation_id,
    intent.payment_id,
    intent.attempt_id,
    intent.transaction_uuid,
    String(intent.amount),
    intent.payment_method,
    intent.issued_at,
    intent.expires_at,
    intent.nonce,
    intent.trace_id,
  ].join("\n");
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signIntent(intent: Omit<SignedPaymentIntent, "signature">) {
  const secret = String(getControlEnv().JUMPING_AGENT_TOKEN ?? "").trim();
  if (secret.length < 24) throw new Error("LOCAL_PAYMENT_SIGNING_KEY_NOT_CONFIGURED");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalPaymentIntent(intent)),
  );
  return base64Url(new Uint8Array(digest));
}

let paymentIntentSchemaReady: Promise<void> | null = null;

export async function ensurePaymentIntentSchema() {
  if (paymentIntentSchemaReady) return paymentIntentSchemaReady;
  paymentIntentSchemaReady = (async () => {
    const row = await getD1().prepare(PAYMENT_INTENT_SCHEMA_CHECK_SQL)
      .first<PaymentIntentSchemaRow>();
    assertPaymentIntentSchema(row);
  })().catch((error) => {
    paymentIntentSchemaReady = null;
    throw error;
  });
  return paymentIntentSchemaReady;
}

function rowToIntent(row: PaymentIntentRow): SignedPaymentIntent {
  return {
    version: INTENT_VERSION,
    intent_id: row.id,
    reservation_id: row.reservation_id,
    payment_id: row.payment_id,
    attempt_id: row.attempt_id,
    transaction_uuid: row.transaction_uuid,
    amount: row.amount,
    payment_method: "CARD",
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    nonce: row.nonce,
    trace_id: row.trace_id,
    signature: row.signature,
  };
}

async function intentById(intentId: string) {
  const result = await getD1()
    .prepare(`SELECT * FROM payment_intents WHERE id = ? LIMIT 1`)
    .bind(intentId)
    .all<PaymentIntentRow>();
  return result.results[0] ?? null;
}

async function reactivateLocalIntentCommand(row: PaymentIntentRow) {
  const db = getD1();
  await db.batch([
    db.prepare(`UPDATE commands SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT id FROM payment_intents
        WHERE attempt_id = ? AND id <> ? AND status = 'READY'
      ) AND status = 'prepared'`).bind(row.attempt_id, row.id),
    db.prepare(`UPDATE payment_intents
      SET status = 'REVOKED', updated_at = CURRENT_TIMESTAMP
      WHERE attempt_id = ? AND id <> ? AND status = 'READY'`).bind(row.attempt_id, row.id),
    db.prepare(`UPDATE commands
      SET status = 'prepared', completed_at = NULL
      WHERE id = ? AND action = 'payment_local_direct'`).bind(row.id),
    db.prepare(`UPDATE payment_attempts
      SET command_id = ?, request_key = ?, active_key = 'MPOS:ACTIVE',
        transaction_source = 'LOCAL_DIRECT', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'PENDING'`).bind(row.id, row.request_key, row.attempt_id),
  ]);
}

async function loadPaymentIntentExecutionGuard(input: {
  reservationId: string;
  attemptId: string;
  requestKey: string;
  trace?: PaymentDbTrace;
  splitPhase: string;
}) {
  const db = getD1();
  const results = await measureIntentDb(input.trace, "intent_execution_guard_batch", () => db.batch([
    db.prepare(`
      UPDATE payment_attempts
      SET command_id = NULL, request_key = NULL, active_key = NULL,
        transaction_source = 'POS_BRIDGE', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'PENDING' AND command_id IN (
        SELECT id FROM payment_intents
        WHERE status = 'READY' AND datetime(expires_at) <= CURRENT_TIMESTAMP
        LIMIT 20
      )
    `),
    db.prepare(`
      UPDATE commands SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
      WHERE status = 'prepared' AND id IN (
        SELECT id FROM payment_intents
        WHERE status = 'READY' AND datetime(expires_at) <= CURRENT_TIMESTAMP
        LIMIT 20
      )
    `),
    db.prepare(`
      UPDATE payment_intents SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT id FROM payment_intents
        WHERE status = 'READY' AND datetime(expires_at) <= CURRENT_TIMESTAMP
        LIMIT 20
      )
    `),
    db.prepare(`SELECT * FROM payment_intents
      WHERE request_key = ? OR (
        attempt_id = ? AND status = 'READY' AND datetime(expires_at) > CURRENT_TIMESTAMP
      )
      ORDER BY CASE WHEN request_key = ? THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1`).bind(input.requestKey, input.attemptId, input.requestKey),
    db.prepare(PAYMENT_GUARD_PAYMENT_SQL).bind(input.reservationId, input.reservationId),
    db.prepare(PAYMENT_GUARD_ATTEMPTS_SQL)
      .bind(input.reservationId, input.reservationId),
  ]), { splitPhase: input.splitPhase, statementCount: 6 }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/payment_intents|no such table|no such column/i.test(message)) {
      throw new Error("LOCAL_PAYMENT_SCHEMA_INVALID");
    }
    throw error;
  });
  return {
    reusable: results[3]?.results?.[0] as PaymentIntentRow | undefined,
    payment: results[4]?.results?.[0] as IntentGuardPaymentRow | undefined,
    attempts: (results[5]?.results ?? []) as IntentGuardAttemptRow[],
  };
}

export async function prepareLocalDirectPaymentIntent(input: {
  reservationId: string;
  attemptId: string;
  requestKey: string;
  requestedBy: string;
  traceId?: string;
  dbTrace?: PaymentDbTrace;
  stageTrace?: PaymentStageTrace;
  splitPhase?: "INITIAL" | "SUBSEQUENT" | "RETRY";
}) {
  const config = paymentTransportConfiguration();
  if (!config.localDirectEnabled) throw new Error("LOCAL_PAYMENT_DISABLED");
  const splitPhase = input.splitPhase ?? "UNKNOWN";
  const dbTrace: PaymentDbTrace | undefined = input.dbTrace
    ? (query, durationMs, details) => input.dbTrace?.(query, durationMs, { splitPhase, ...details })
    : undefined;
  const requestKey = String(input.requestKey ?? "").trim().slice(0, 100);
  if (!requestKey) throw new Error("PAYMENT_REQUEST_KEY_REQUIRED");

  await measureIntentDb(dbTrace, "intent_schema_guard", () => ensurePaymentIntentSchema());
  input.stageTrace?.("INTENT_SCHEMA_READY", { source: "migration_0042_once_guard" });
  input.stageTrace?.("INTENT_GUARD_START", { splitPhase, source: "d1_authoritative_batch" });
  input.stageTrace?.("INTENT_CONTEXT_START", { source: "d1_authoritative" });
  const guardStarted = performance.now();
  const snapshot = await loadPaymentIntentExecutionGuard({
    reservationId: input.reservationId,
    attemptId: input.attemptId,
    requestKey,
    trace: dbTrace,
    splitPhase,
  });
  if (snapshot.reusable) {
    const durationMs = performance.now() - guardStarted;
    input.stageTrace?.("INTENT_CONTEXT_DONE", {
      source: "d1_authoritative_batch",
      reused: true,
    }, durationMs);
    input.stageTrace?.("INTENT_GUARD_DONE", { splitPhase, reused: true }, durationMs);
    return rowToIntent(snapshot.reusable);
  }
  const guard = evaluatePaymentExecutionGuard({
    attempts: snapshot.attempts,
    splitCount: snapshot.payment?.split_count ?? 0,
    attemptId: input.attemptId,
  });
  const guardDurationMs = performance.now() - guardStarted;
  input.stageTrace?.("INTENT_CONTEXT_DONE", {
    source: "d1_authoritative_batch",
    reused: false,
  }, guardDurationMs);
  if (!snapshot.payment || guard.hasUnknown) throw new Error("PAYMENT_PLAN_NOT_FOUND");
  if (!["PENDING", "PARTIALLY_PAID"].includes(snapshot.payment.status)) {
    throw new Error("PAYMENT_TRANSACTION_NOT_PENDING");
  }
  const attempt = guard.attempt;
  if (!attempt || attempt.attempt_type !== "PAY") throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
  if (normalizePaymentMethod(attempt.payment_method) !== "card") {
    throw new Error("LOCAL_PAYMENT_CARD_ONLY");
  }
  if (!Number.isSafeInteger(attempt.amount) || attempt.amount <= 0) {
    throw new Error("PAYMENT_PLAN_STALE");
  }
  if (attempt.status !== "PENDING" || attempt.command_id || attempt.active_key) {
    throw new Error("PAYMENT_TRANSACTION_NOT_PENDING");
  }
  if (guard.firstUnfinishedAttemptId !== attempt.id) {
    throw new Error("PAYMENT_TRANSACTION_OUT_OF_ORDER");
  }
  if (guard.otherActiveAttemptId) throw new Error("PAYMENT_TERMINAL_BUSY");
  input.stageTrace?.("INTENT_GUARD_DONE", {
    splitPhase,
    reused: false,
    paymentStatus: snapshot.payment.status,
  }, guardDurationMs);

  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + INTENT_TTL_MS).toISOString();
  const intentId = crypto.randomUUID();
  const traceId = normalizePaymentTraceId(input.traceId);
  const unsigned: Omit<SignedPaymentIntent, "signature"> = {
    version: INTENT_VERSION,
    intent_id: intentId,
    reservation_id: input.reservationId,
    payment_id: snapshot.payment.id,
    attempt_id: attempt.id,
    transaction_uuid: attempt.id,
    amount: attempt.amount,
    payment_method: "CARD",
    issued_at: issuedAt,
    expires_at: expiresAt,
    nonce: crypto.randomUUID(),
    trace_id: traceId,
  };
  const intent: SignedPaymentIntent = { ...unsigned, signature: await signIntent(unsigned) };
  const db = getD1();
  const results = await measureIntentDb(dbTrace, "intent_prepare_write_batch", () => db.batch([
    db.prepare(`INSERT INTO payment_intents (
        id, reservation_id, payment_id, attempt_id, transaction_uuid, amount,
        payment_method, request_key, nonce, version, signature, status,
        trace_id, requested_by, issued_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'CARD', ?, ?, 1, ?, 'READY', ?, ?, ?, ?)`)
      .bind(
        intent.intent_id,
        intent.reservation_id,
        intent.payment_id,
        intent.attempt_id,
        intent.transaction_uuid,
        intent.amount,
        requestKey,
        intent.nonce,
        intent.signature,
        intent.trace_id,
        input.requestedBy,
        intent.issued_at,
        intent.expires_at,
      ),
    db.prepare(`INSERT INTO commands (
        id, room_id, action, payload_json, status, requested_by, target_agent_id, expires_at
      ) VALUES (?, 'PAYMENT', 'payment_local_direct', ?, 'prepared', ?, ?, ?)`)
      .bind(
        intent.intent_id,
        JSON.stringify({
          reservationId: intent.reservation_id,
          transactionUuid: intent.transaction_uuid,
          amount: intent.amount,
          traceId: intent.trace_id,
          intentId: intent.intent_id,
        }),
        input.requestedBy,
        getControlAgentId(),
        expiresAt,
      ),
    db.prepare(`UPDATE payment_attempts
      SET command_id = ?, request_key = ?, active_key = 'MPOS:ACTIVE',
        transaction_source = 'LOCAL_DIRECT', trace_id = ?, requested_by = ?,
        response_message = '로컬 결제 준비됨', error_code = 'NONE', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'PENDING' AND command_id IS NULL AND active_key IS NULL`)
      .bind(intent.intent_id, requestKey, intent.trace_id, input.requestedBy, intent.attempt_id),
  ]), { statementCount: 3 });
  if (Number(results[2]?.meta.changes ?? 0) !== 1) {
    await measureIntentDb(dbTrace, "intent_prepare_conflict_cleanup", () => db.batch([
      db.prepare(`DELETE FROM payment_intents WHERE id = ?`).bind(intent.intent_id),
      db.prepare(`DELETE FROM commands WHERE id = ? AND status = 'prepared'`).bind(intent.intent_id),
    ]), { statementCount: 2 });
    throw new Error("PAYMENT_TERMINAL_BUSY");
  }
  input.stageTrace?.("INTENT_BINDING_DONE", {
    attemptId: intent.attempt_id,
    intentId: intent.intent_id,
    statementCount: 3,
  });
  return intent;
}

export async function releaseLocalDirectPaymentIntent(input: {
  reservationId: string;
  intentId: string;
}) {
  await ensurePaymentIntentSchema();
  const row = await intentById(input.intentId);
  if (!row || row.reservation_id !== input.reservationId) return { released: true };
  if (row.status !== "READY") throw new Error("LOCAL_PAYMENT_RELEASE_NOT_ALLOWED");
  const db = getD1();
  await db.batch([
    db.prepare(`UPDATE payment_intents SET status = 'REVOKED', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'READY'`).bind(row.id),
    db.prepare(`UPDATE commands SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'prepared'`).bind(row.id),
    db.prepare(`UPDATE payment_attempts
      SET command_id = NULL, request_key = NULL, active_key = NULL,
        transaction_source = 'POS_BRIDGE', response_message = '', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND command_id = ? AND status = 'PENDING'`)
      .bind(row.attempt_id, row.id),
  ]);
  return { released: true };
}

function normalizeLocalResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LOCAL_PAYMENT_RESULT_INVALID");
  }
  const result = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of [
    "kind", "success", "transaction_uuid", "transaction_type", "status", "amount",
    "response_code", "response_message", "auth_no", "auth_date", "issuer_name",
    "acquirer_name", "masked_card_no", "raw_return_code", "elapsed_ms", "error_code",
    "mpos_transaction_id", "trace_id", "approval_time", "terminal_id",
  ]) {
    if (key in result) safe[key] = result[key];
  }
  return safe;
}

export async function completeLocalDirectPaymentResult(input: {
  intent: SignedPaymentIntent;
  result: unknown;
  localDurableAt?: string;
  dbTrace?: PaymentDbTrace;
  stageTrace?: PaymentStageTrace;
}) {
  input.stageTrace?.("CORE_GUARD_START");
  await ensurePaymentIntentSchema();
  const row = await intentById(String(input.intent?.intent_id ?? ""));
  if (!row) throw new Error("LOCAL_PAYMENT_INTENT_NOT_FOUND");
  if (row.status === "REVOKED") {
    throw new Error("LOCAL_PAYMENT_INTENT_INACTIVE");
  }
  const expected = rowToIntent(row);
  if (
    input.intent.signature !== expected.signature ||
    input.intent.transaction_uuid !== expected.transaction_uuid ||
    input.intent.attempt_id !== expected.attempt_id ||
    Number(input.intent.amount) !== expected.amount
  ) throw new Error("LOCAL_PAYMENT_INTENT_MISMATCH");
  const unsigned = { ...input.intent } as SignedPaymentIntent & { signature?: string };
  delete unsigned.signature;
  const calculated = await signIntent(unsigned as Omit<SignedPaymentIntent, "signature">);
  if (calculated !== expected.signature) throw new Error("LOCAL_PAYMENT_SIGNATURE_INVALID");

  const result = normalizeLocalResult(input.result);
  if (
    String(result.transaction_uuid ?? "") !== row.transaction_uuid ||
    Math.trunc(Number(result.amount)) !== row.amount
  ) throw new Error("LOCAL_PAYMENT_RESULT_MISMATCH");
  input.stageTrace?.("CORE_GUARD_DONE");
  if (row.cloud_synced_at) {
    return {
      synced: true,
      coreCommitted: true,
      reservationId: row.reservation_id,
      attemptId: row.attempt_id,
      status: row.status,
    };
  }

  const rawResult = JSON.stringify(result);
  const status = String(result.status ?? "UNKNOWN").toUpperCase();
  const commandStatus = ["APPROVED", "COMPLETED", "DECLINED", "USER_CANCELLED", "BUSY", "ERROR", "CANCELLED"].includes(status)
    ? "completed" as const
    : "failed" as const;
  const db = getD1();
  if (row.status === "READY") {
    input.stageTrace?.("CORE_WRITE_START");
    // An approval may remain only in the local outbox while Cloud is offline.
    // Restore an expired/rotated command binding before replaying the existing,
    // signed result into the normal durable payment ledger. This never calls MPOS.
    await reactivateLocalIntentCommand(row);
    // Persist the financial source of truth first. The UI long-poll can then
    // activate the next split immediately while the local outbox retains this
    // same signed result for retryable derived reconciliation.
    await completePaymentCommand(row.id, commandStatus, rawResult, input.dbTrace, { deferDerived: true });
    await db.batch([
      db.prepare(`UPDATE payment_intents
        SET status = ?, result_json = ?, local_durable_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'READY'`)
        .bind(status, rawResult, String(input.localDurableAt ?? "").slice(0, 40) || null, row.id),
      db.prepare(`UPDATE commands
        SET status = ?, result = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('prepared', 'completed', 'failed')`)
        .bind(commandStatus, rawResult.slice(0, 4000), row.id),
    ]);
    input.stageTrace?.("CORE_WRITE_DONE");
    input.stageTrace?.("NEXT_SPLIT_RESULT_READY", { attemptId: row.attempt_id, status });
    return {
      synced: false,
      coreCommitted: true,
      reservationId: row.reservation_id,
      attemptId: row.attempt_id,
      status,
    };
  }

  // A replay after the core commit completes only idempotent derived work.
  // Re-applying the core batch keeps upgrades from older partial states safe.
  input.stageTrace?.("DERIVED_SYNC_START");
  await completePaymentCommand(row.id, commandStatus, rawResult, input.dbTrace, { deferDerived: true });
  await completePaymentCommandDerived(row.id, input.dbTrace);
  await db.prepare(`UPDATE payment_intents
      SET cloud_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND cloud_synced_at IS NULL`)
    .bind(row.id)
    .run();
  input.stageTrace?.("DERIVED_SYNC_DONE");
  return {
    synced: true,
    coreCommitted: true,
    reservationId: row.reservation_id,
    attemptId: row.attempt_id,
    status,
  };
}

export async function markLocalDirectPaymentUnknown(input: {
  reservationId: string;
  intentId: string;
  reason?: string;
}) {
  await ensurePaymentIntentSchema();
  const row = await intentById(input.intentId);
  if (!row || row.reservation_id !== input.reservationId) {
    throw new Error("LOCAL_PAYMENT_INTENT_NOT_FOUND");
  }
  if (row.status === "REVOKED") throw new Error("LOCAL_PAYMENT_INTENT_INACTIVE");
  if (row.cloud_synced_at) return getPaymentOverview(row.reservation_id);
  await reactivateLocalIntentCommand(row);
  const rawResult = JSON.stringify({
    kind: "payment",
    success: false,
    transaction_uuid: row.transaction_uuid,
    transaction_type: "PAY",
    status: "UNKNOWN",
    amount: row.amount,
    response_message: String(input.reason ?? "로컬 결제 응답을 확인하지 못했습니다.").slice(0, 300),
    error_code: "UNKNOWN",
    trace_id: row.trace_id,
  });
  await getD1().batch([
    getD1().prepare(`UPDATE payment_intents SET status = 'UNKNOWN', result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(rawResult, row.id),
    getD1().prepare(`UPDATE commands SET status = 'failed', result = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(rawResult, row.id),
  ]);
  await completePaymentCommand(row.id, "failed", rawResult);
  return getPaymentOverview(row.reservation_id);
}
