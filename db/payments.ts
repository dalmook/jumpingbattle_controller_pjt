import {
  getControlAgentId,
  getD1,
  paymentExplicitExecutionV2Enabled,
} from "./control";
import {
  buildPaymentPlan,
  calculatePaymentLedger,
  normalizePaymentMethod,
  PAYMENT_TRANSACTION_STATUSES,
  type LedgerStatus,
  type PaymentMethod,
  type PaymentPlanMode,
  type PaymentWholeStatus,
} from "./payment-ledger";
import { getPricingSettings } from "./pricing-settings";
import {
  allocateMemberCoupons,
  memberCouponAmountsFitParticipantSlots,
} from "../app/member-coupon-allocation";
import {
  canAppendExternalApprovalTopUp,
  externalApprovalTopUpRequestKey,
  externalTerminalTransactionKey,
  matchExternalApprovalAmount,
  normalizeApprovalTime,
  normalizeAuthorizationDate,
  normalizeAuthorizationNumber,
  normalizeManualPaymentReason,
  normalizeMaskedCardLast4,
  normalizeTerminalId,
} from "./payment-reconciliation";
import {
  assertPassPurchaseRefundable,
  ensureMemberBenefitSchema,
  syncPassPurchasePayment,
  validateMemberCouponForPayment,
} from "./member-benefits";
import {
  deleteAddOnSaleOrder,
  ensureAddOnSaleSchema,
  quoteAddOnSale,
  syncAddOnSalePayment,
  type AddOnSaleSelectionInput,
} from "./add-on-sales";
import { allocateGroupPaymentMethods } from "./payment-group";
import { normalizePaymentTraceId } from "./payment-latency";
import { evaluatePaymentExecutionGuard } from "./payment-wave-guards";
import type { MinimalNextSplitResult } from "../app/payment-progress";

export type PaymentDbTrace = (
  query: string,
  durationMs: number,
  details?: Record<string, unknown>,
) => void;

export type PaymentStageTrace = (
  stage: string,
  details?: Record<string, unknown>,
  durationMs?: number,
) => void;

async function measurePaymentDb<T>(
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
      ...paymentDbMetrics(value),
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

async function measurePaymentStage<T>(
  trace: PaymentStageTrace | undefined,
  startStage: string,
  doneStage: string,
  operation: () => Promise<T>,
  details: Record<string, unknown> = {},
) {
  trace?.(startStage, details);
  const started = performance.now();
  try {
    const value = await operation();
    trace?.(doneStage, details, performance.now() - started);
    return value;
  } catch (error) {
    trace?.(`${doneStage}_ERROR`, {
      ...details,
      error: error instanceof Error ? error.message : String(error),
    }, performance.now() - started);
    throw error;
  }
}

function paymentDbMetrics(value: unknown) {
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

async function measurePaymentFirst<T>(
  trace: PaymentDbTrace | undefined,
  query: string,
  operation: () => Promise<{ results: T[]; meta?: Record<string, unknown> }>,
  details: Record<string, unknown> = {},
) {
  const result = await measurePaymentDb(trace, query, operation, details);
  return result.results[0] ?? null;
}

export const PAYMENT_STATUSES = PAYMENT_TRANSACTION_STATUSES;
export type PaymentStatus = LedgerStatus;
export type PaymentAttemptType = "PAY" | "CANCEL";

type PaymentRow = {
  id: string;
  reservation_id: string;
  payment_type: string;
  member_id: string | null;
  member_pass_id: string | null;
  mode: string;
  split_count: number;
  final_amount: number;
  deposit_amount: number;
  payable_amount: number;
  status: PaymentWholeStatus;
  full_cancel_requested: number;
  plan_request_key: string | null;
  requested_by: string;
  created_at: string;
  updated_at: string;
};

type PaymentAttemptRow = {
  id: string;
  reservation_id: string;
  payment_id: string | null;
  member_id: string | null;
  member_pass_id: string | null;
  member_coupon_id: string | null;
  split_index: number;
  attempt_type: PaymentAttemptType;
  attempt_number: number;
  amount: number;
  sale_amount: number;
  add_on_amount: number;
  discount_amount: number;
  payment_method: string;
  status: PaymentStatus;
  response_code: string;
  response_message: string;
  auth_no: string;
  auth_date: string;
  issuer_name: string;
  acquirer_name: string;
  masked_card_no: string;
  raw_return_code: number | null;
  error_code: string;
  elapsed_ms: number;
  mpos_transaction_id: number | null;
  original_attempt_id: string | null;
  original_mpos_transaction_id: number | null;
  command_id: string | null;
  request_key: string | null;
  active_key: string | null;
  trace_id: string;
  transaction_source: string;
  verification_status: string;
  approval_time: string;
  terminal_id: string;
  external_transaction_id: string;
  external_transaction_key: string | null;
  operator_note: string;
  requested_by: string;
  requested_at: string;
  completed_at: string | null;
  updated_at: string;
};

type ReservationPaymentRow = {
  id: string;
  booking_code: string;
  source: string;
  status: string;
  scheduled_date: string;
  scheduled_time: string;
  room_code: string;
  team_name: string;
  adult_count: number;
  youth_count: number;
  total_count: number;
  repeat_group_id: string;
  repeat_sequence: number;
  base_amount: number;
  add_on_amount: number;
  discount_amount: number;
  payment_status: string;
  member_id: string | null;
};

type PaymentAllocationRow = {
  payment_id: string;
  reservation_id: string;
  sequence: number;
  final_amount: number;
  deposit_amount: number;
  payable_amount: number;
};

type PaymentWithSourceRow = PaymentRow & {
  reservation_source: string;
};

type TerminalRow = {
  connected: number;
  payment_ready: number;
  response_code: string;
  response_message: string;
  model: string;
  firmware: string;
  integrity: string;
  raw_return_code: number | null;
  error_code: string;
  elapsed_ms: number;
  checked_at: string;
  updated_at: string;
};

export type PaymentAttempt = ReturnType<typeof toPaymentAttempt>;
export type PaymentExecutionContext = {
  payment: ReturnType<typeof toPayment> | null;
  attempt: PaymentAttempt | null;
  firstUnfinishedAttemptId: string | null;
  hasUnknown: boolean;
  otherActiveAttemptId: string | null;
};

function toPaymentAttempt(row: PaymentAttemptRow) {
  return {
    id: row.id,
    transactionUuid: row.id,
    reservationId: row.reservation_id,
    paymentId: row.payment_id,
    memberId: row.member_id,
    memberPassId: row.member_pass_id,
    memberCouponId: row.member_coupon_id,
    splitIndex: row.split_index,
    attemptType: row.attempt_type,
    attemptNumber: row.attempt_number,
    amount: row.amount,
    saleAmount: row.sale_amount,
    addOnAmount: row.add_on_amount,
    discountAmount: row.discount_amount,
    paymentMethod: normalizePaymentMethod(row.payment_method),
    status: row.status,
    responseCode: row.response_code,
    responseMessage: row.response_message,
    authNo: row.auth_no,
    authDate: row.auth_date,
    issuerName: row.issuer_name,
    acquirerName: row.acquirer_name,
    maskedCardNo: row.masked_card_no,
    rawReturnCode: row.raw_return_code,
    errorCode: row.error_code,
    elapsedMs: row.elapsed_ms,
    mposTransactionId: row.mpos_transaction_id,
    originalAttemptId: row.original_attempt_id,
    originalMposTransactionId: row.original_mpos_transaction_id,
    commandId: row.command_id,
    activeKey: row.active_key,
    traceId: row.trace_id,
    transactionSource: row.transaction_source,
    verificationStatus: row.verification_status,
    approvalTime: row.approval_time,
    terminalId: row.terminal_id,
    externalTransactionId: row.external_transaction_id,
    operatorNote: row.operator_note,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function toPayment(row: PaymentRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    reservationId: row.reservation_id,
    paymentType: row.payment_type,
    memberId: row.member_id,
    memberPassId: row.member_pass_id,
    mode: row.mode,
    splitCount: row.split_count,
    finalAmount: row.final_amount,
    depositAmount: row.deposit_amount,
    payableAmount: row.payable_amount,
    status: row.status,
    fullCancelRequested: row.full_cancel_requested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function terminalPayload(row?: TerminalRow | null) {
  return {
    connected: row?.connected === 1,
    paymentReady: row?.payment_ready === 1,
    responseCode: row?.response_code ?? "",
    responseMessage: row?.response_message ?? "단말 상태를 아직 확인하지 않았습니다.",
    model: row?.model ?? "",
    firmware: row?.firmware ?? "",
    integrity: row?.integrity ?? "",
    rawReturnCode: row?.raw_return_code ?? null,
    errorCode: row?.error_code ?? "DEVICE_OFFLINE",
    elapsedMs: row?.elapsed_ms ?? 0,
    checkedAt: row?.checked_at ?? "",
    updatedAt: row?.updated_at ?? "",
  };
}

let paymentSchemaReady: Promise<void> | null = null;

async function initializePaymentSchema() {
  const db = getD1();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL UNIQUE,
        payment_type TEXT NOT NULL DEFAULT 'RESERVATION',
        member_id TEXT,
        member_pass_id TEXT,
        mode TEXT NOT NULL DEFAULT 'single',
        split_count INTEGER NOT NULL DEFAULT 0,
        final_amount INTEGER NOT NULL DEFAULT 0,
        deposit_amount INTEGER NOT NULL DEFAULT 0,
        payable_amount INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'PENDING',
        full_cancel_requested INTEGER NOT NULL DEFAULT 0,
        plan_request_key TEXT,
        requested_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(reservation_id) REFERENCES reservations(id)
      )
    `),
    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS payments_plan_request_key_uidx
      ON payments(plan_request_key) WHERE plan_request_key IS NOT NULL
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS payment_attempts (
        id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL,
        payment_id TEXT,
        member_id TEXT,
        member_pass_id TEXT,
        member_coupon_id TEXT,
        split_index INTEGER NOT NULL DEFAULT 1,
        attempt_type TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        amount INTEGER NOT NULL CHECK(amount > 0),
        sale_amount INTEGER NOT NULL DEFAULT 0,
        add_on_amount INTEGER NOT NULL DEFAULT 0,
        discount_amount INTEGER NOT NULL DEFAULT 0,
        payment_method TEXT NOT NULL DEFAULT 'card',
        status TEXT NOT NULL DEFAULT 'PENDING',
        response_code TEXT NOT NULL DEFAULT '',
        response_message TEXT NOT NULL DEFAULT '',
        auth_no TEXT NOT NULL DEFAULT '',
        auth_date TEXT NOT NULL DEFAULT '',
        issuer_name TEXT NOT NULL DEFAULT '',
        acquirer_name TEXT NOT NULL DEFAULT '',
        masked_card_no TEXT NOT NULL DEFAULT '',
        raw_return_code INTEGER,
        error_code TEXT NOT NULL DEFAULT 'NONE',
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        mpos_transaction_id INTEGER,
        original_attempt_id TEXT,
        original_mpos_transaction_id INTEGER,
        command_id TEXT UNIQUE,
        request_key TEXT,
        active_key TEXT UNIQUE,
        trace_id TEXT NOT NULL DEFAULT '',
        transaction_source TEXT NOT NULL DEFAULT 'POS_BRIDGE',
        verification_status TEXT NOT NULL DEFAULT 'VERIFIED',
        approval_time TEXT NOT NULL DEFAULT '',
        terminal_id TEXT NOT NULL DEFAULT '',
        external_transaction_id TEXT NOT NULL DEFAULT '',
        external_transaction_key TEXT,
        operator_note TEXT NOT NULL DEFAULT '',
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(reservation_id) REFERENCES reservations(id),
        FOREIGN KEY(payment_id) REFERENCES payments(id),
        FOREIGN KEY(original_attempt_id) REFERENCES payment_attempts(id)
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS payment_attempts_reservation_idx
      ON payment_attempts(reservation_id, requested_at DESC)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS payment_attempts_payment_split_idx
      ON payment_attempts(payment_id, split_index, requested_at)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS payment_attempts_original_idx
      ON payment_attempts(original_attempt_id, status)
    `),
    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_request_key_uidx
      ON payment_attempts(request_key) WHERE request_key IS NOT NULL
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS payment_attempts_trace_idx
      ON payment_attempts(trace_id, requested_at) WHERE trace_id <> ''
    `),
    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_external_key_uidx
      ON payment_attempts(external_transaction_key) WHERE external_transaction_key IS NOT NULL
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS payment_attempts_source_idx
      ON payment_attempts(transaction_source, requested_at)
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS payment_terminal_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        connected INTEGER NOT NULL DEFAULT 0,
        payment_ready INTEGER NOT NULL DEFAULT 0,
        response_code TEXT NOT NULL DEFAULT '',
        response_message TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        firmware TEXT NOT NULL DEFAULT '',
        integrity TEXT NOT NULL DEFAULT '',
        raw_return_code INTEGER,
        error_code TEXT NOT NULL DEFAULT 'DEVICE_OFFLINE',
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        checked_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS payment_allocations (
        payment_id TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 1,
        final_amount INTEGER NOT NULL DEFAULT 0,
        deposit_amount INTEGER NOT NULL DEFAULT 0,
        payable_amount INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (payment_id, reservation_id)
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS payment_allocations_reservation_idx
      ON payment_allocations(reservation_id, payment_id)`),
  ]);
}

export async function ensurePaymentSchema() {
  if (!paymentSchemaReady) {
    paymentSchemaReady = initializePaymentSchema().catch((error) => {
      paymentSchemaReady = null;
      throw error;
    });
  }
  await paymentSchemaReady;
}

const PAYMENT_SELECT = `
  SELECT id, reservation_id, payment_type, member_id, member_pass_id,
    mode, split_count, final_amount, deposit_amount,
    payable_amount, status, full_cancel_requested, plan_request_key,
    requested_by, created_at, updated_at FROM payments
`;

const ATTEMPT_SELECT = `
  SELECT id, reservation_id, payment_id, member_id, member_pass_id, member_coupon_id,
    split_index, attempt_type,
    attempt_number, amount, sale_amount, add_on_amount, discount_amount,
    payment_method, status, response_code, response_message, auth_no,
    auth_date, issuer_name, acquirer_name, masked_card_no, raw_return_code,
    error_code, elapsed_ms, mpos_transaction_id, original_attempt_id,
    original_mpos_transaction_id, command_id, request_key, active_key,
    trace_id, transaction_source, verification_status, approval_time,
    terminal_id, external_transaction_id, external_transaction_key, operator_note,
    requested_by, requested_at, completed_at, updated_at
  FROM payment_attempts
`;

const RESERVATION_PAYMENT_SELECT = `
  SELECT id, booking_code, source, status, scheduled_date, scheduled_time,
    room_code, team_name, adult_count, youth_count, total_count,
    repeat_group_id, repeat_sequence, base_amount, add_on_amount, discount_amount,
    payment_status, member_id FROM reservations
`;

const PAYMENT_ALLOCATION_SELECT = `
  SELECT payment_id, reservation_id, sequence,
    final_amount, deposit_amount, payable_amount FROM payment_allocations
`;

function safeText(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safeInteger(value: unknown, minimum: number, maximum: number) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : minimum;
}

function paymentStatus(value: unknown): PaymentStatus {
  const normalized = String(value ?? "") as PaymentStatus;
  return PAYMENT_STATUSES.includes(normalized) ? normalized : "ERROR";
}

async function reservationForPayment(
  reservationId: string,
  trace?: PaymentDbTrace,
  query = "reservation_for_payment",
) {
  return measurePaymentFirst(trace, query, () => getD1()
    .prepare(`${RESERVATION_PAYMENT_SELECT} WHERE id = ? LIMIT 1`)
    .bind(reservationId)
    .all<ReservationPaymentRow>());
}

async function paymentRow(reservationId: string, trace?: PaymentDbTrace) {
  return measurePaymentFirst(trace, "payment_lookup", () => getD1()
    .prepare(`WITH allocated AS (
      SELECT payment_id FROM payment_allocations WHERE reservation_id = ?
      ORDER BY updated_at DESC LIMIT 1
    )
    ${PAYMENT_SELECT} WHERE id = (SELECT payment_id FROM allocated)
      OR reservation_id = ?
    ORDER BY CASE WHEN id = (SELECT payment_id FROM allocated) THEN 0 ELSE 1 END
    LIMIT 1`)
    .bind(reservationId, reservationId)
    .all<PaymentRow>());
}

async function paymentRows(reservationId: string, paymentId?: string | null, trace?: PaymentDbTrace) {
  const result = await measurePaymentDb(trace, "payment_attempt_rows", () => getD1()
    .prepare(`
      ${ATTEMPT_SELECT} WHERE ${paymentId ? "payment_id = ?" : "reservation_id = ?"}
      ORDER BY attempt_number DESC, requested_at DESC
    `)
    .bind(paymentId || reservationId)
    .all<PaymentAttemptRow>());
  return result.results;
}

async function paymentAllocationRows(paymentId: string, trace?: PaymentDbTrace) {
  const result = await measurePaymentDb(trace, "payment_allocation_rows", () => getD1().prepare(`${PAYMENT_ALLOCATION_SELECT}
    WHERE payment_id = ? ORDER BY sequence, reservation_id`)
    .bind(paymentId).all<PaymentAllocationRow>());
  return result.results;
}

async function repeatGroupReservations(
  reservationId: string,
  trace?: PaymentDbTrace,
  loadedReservation?: ReservationPaymentRow,
) {
  const reservation = loadedReservation ?? await reservationForPayment(
    reservationId,
    trace,
    "repeat_group_anchor",
  );
  if (!reservation?.repeat_group_id) return reservation ? [reservation] : [];
  const result = await measurePaymentDb(trace, "repeat_group_reservations", () => getD1().prepare(`SELECT id, booking_code, source, status,
      scheduled_date, scheduled_time, room_code, team_name, adult_count, youth_count,
      total_count, repeat_group_id, repeat_sequence, base_amount, add_on_amount,
      discount_amount, payment_status, member_id
    FROM reservations WHERE repeat_group_id = ? ORDER BY repeat_sequence, scheduled_date,
      scheduled_time, created_at`)
    .bind(reservation.repeat_group_id).all<ReservationPaymentRow>());
  return result.results;
}

async function nextAttemptNumber(reservationId: string, attemptType: PaymentAttemptType, trace?: PaymentDbTrace) {
  const row = await measurePaymentFirst(trace, "next_attempt_number", () => getD1()
    .prepare(`
      SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_number
      FROM payment_attempts WHERE reservation_id = ? AND attempt_type = ?
    `)
    .bind(reservationId, attemptType)
    .all<{ next_number: number }>());
  return Math.max(1, Number(row?.next_number) || 1);
}

async function paymentContext(
  reservationId: string,
  trace?: PaymentDbTrace,
  loadedPricing?: Awaited<ReturnType<typeof getPricingSettings>>,
) {
  const [requestedReservation, payment] = await Promise.all([
    reservationForPayment(reservationId, trace),
    paymentRow(reservationId, trace),
  ]);
  if (!requestedReservation) throw new Error("RESERVATION_NOT_FOUND");
  const reservation = payment && payment.reservation_id !== requestedReservation.id
    ? await reservationForPayment(payment.reservation_id, trace, "payment_anchor_reservation")
    : requestedReservation;
  if (!reservation) throw new Error("RESERVATION_NOT_FOUND");
  const [rows, pricing, allocations] = await Promise.all([
    paymentRows(reservation.id, payment?.id, trace),
    loadedPricing
      ? Promise.resolve(loadedPricing)
      : measurePaymentDb(trace, "pricing_settings", () => getPricingSettings()),
    payment ? paymentAllocationRows(payment.id, trace) : Promise.resolve([]),
  ]);
  const attempts = rows.map(toPaymentAttempt);
  const allocatedReservations = allocations.length > 1
    ? await Promise.all(allocations.map((item, index) => reservationForPayment(
        item.reservation_id,
        trace,
        `allocated_reservation_${index + 1}`,
      )))
    : [];
  const authoritativeReservations = allocatedReservations.filter((item): item is ReservationPaymentRow => Boolean(item));
  const finalAmount = authoritativeReservations.length > 1
    ? authoritativeReservations.reduce((sum, item) => sum + Math.max(0, item.base_amount + item.add_on_amount - item.discount_amount), 0)
    : Math.max(0, reservation.base_amount + reservation.add_on_amount - reservation.discount_amount);
  const depositAmount = authoritativeReservations.length > 1
    ? authoritativeReservations.reduce((sum, item) => {
        const itemFinal = Math.max(0, item.base_amount + item.add_on_amount - item.discount_amount);
        return sum + (item.source === "naver" ? Math.min(pricing.naverDepositAmount, itemFinal) : 0);
      }, 0)
    : reservation.source === "naver"
      ? Math.min(pricing.naverDepositAmount, finalAmount)
      : 0;
  const ledger = calculatePaymentLedger({ finalAmount, depositAmount, attempts });
  return { requestedReservation, reservation, payment, rows, attempts, pricing, ledger, allocations };
}

async function participantTopUpPaymentContext(reservationId: string) {
  return paymentContext(reservationId);
}

async function preparedPaymentContext(
  reservationId: string,
  paymentId: string,
  pricing: Awaited<ReturnType<typeof getPricingSettings>>,
  trace?: PaymentDbTrace,
) {
  const db = getD1();
  const results = await measurePaymentDb(trace, "prepare_plan_readback_batch", () => db.batch([
    db.prepare(`${RESERVATION_PAYMENT_SELECT} WHERE id = ? LIMIT 1`).bind(reservationId),
    db.prepare(`${PAYMENT_SELECT} WHERE id = ? LIMIT 1`).bind(paymentId),
    db.prepare(`${ATTEMPT_SELECT} WHERE payment_id = ?
      ORDER BY attempt_number DESC, requested_at DESC`).bind(paymentId),
    db.prepare(`${PAYMENT_ALLOCATION_SELECT} WHERE payment_id = ?
      ORDER BY sequence, reservation_id`).bind(paymentId),
    db.prepare(`${RESERVATION_PAYMENT_SELECT}
      WHERE id = (SELECT reservation_id FROM payments WHERE id = ?) LIMIT 1`).bind(paymentId),
    db.prepare(`SELECT * FROM payment_terminal_state WHERE id = 1 LIMIT 1`),
  ]), { statementCount: 6 });
  const requestedReservation = results[0]?.results?.[0] as ReservationPaymentRow | undefined;
  const payment = results[1]?.results?.[0] as PaymentRow | undefined;
  const rows = (results[2]?.results ?? []) as PaymentAttemptRow[];
  const allocations = (results[3]?.results ?? []) as PaymentAllocationRow[];
  const anchorReservation = results[4]?.results?.[0] as ReservationPaymentRow | undefined;
  const terminal = results[5]?.results?.[0] as TerminalRow | undefined;
  if (!requestedReservation || !payment || !anchorReservation) {
    throw new Error("PAYMENT_PLAN_STALE");
  }
  const attempts = rows.map(toPaymentAttempt);
  const ledger = calculatePaymentLedger({
    finalAmount: payment.final_amount,
    depositAmount: payment.deposit_amount,
    attempts,
  });
  return {
    requestedReservation,
    reservation: anchorReservation,
    payment,
    rows,
    attempts,
    pricing,
    ledger,
    allocations,
    terminal,
  };
}

async function attemptByRequestKey(requestKey: string, trace?: PaymentDbTrace) {
  const row = await measurePaymentFirst(trace, "attempt_by_request_key", () => getD1()
    .prepare(`${ATTEMPT_SELECT} WHERE request_key = ? LIMIT 1`)
    .bind(requestKey)
    .all<PaymentAttemptRow>());
  return row ? toPaymentAttempt(row) : null;
}

async function attemptById(id: string, trace?: PaymentDbTrace) {
  return measurePaymentFirst(trace, "attempt_by_id", () => getD1()
    .prepare(`${ATTEMPT_SELECT} WHERE id = ? LIMIT 1`)
    .bind(id)
    .all<PaymentAttemptRow>());
}

async function activeTerminalAttempt(trace?: PaymentDbTrace) {
  return measurePaymentFirst(trace, "active_terminal_attempt", () => getD1()
    .prepare(`
      ${ATTEMPT_SELECT}
      WHERE active_key IS NOT NULL
        AND status IN ('PROCESSING', 'PENDING', 'BUSY', 'UNKNOWN')
      ORDER BY requested_at DESC LIMIT 1
    `)
    .all<PaymentAttemptRow>());
}

function latestPayRowsBySplit(rows: PaymentAttemptRow[], splitCount: number) {
  const latest = new Map<number, PaymentAttemptRow>();
  for (const row of rows) {
    if (
      row.attempt_type === "PAY" &&
      row.split_index >= 1 &&
      row.split_index <= splitCount &&
      !latest.has(row.split_index)
    ) {
      latest.set(row.split_index, row);
    }
  }
  return Array.from({ length: splitCount }, (_, index) => latest.get(index + 1) ?? null);
}

function successfulPay(row: PaymentAttemptRow | null) {
  return Boolean(row && ["APPROVED", "COMPLETED"].includes(row.status));
}

function paymentLedgerRevision(payment: PaymentRow, rows: PaymentAttemptRow[]) {
  return [
    payment.id,
    payment.status,
    payment.updated_at,
    ...rows
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => [
        row.id,
        row.status,
        row.active_key ?? "",
        row.updated_at,
      ].join(":")),
  ].join("|");
}

function buildMinimalNextSplitResult(input: {
  payment: PaymentWithSourceRow;
  rows: PaymentAttemptRow[];
  currentAttemptId: string;
  finalizationReady: boolean;
}): MinimalNextSplitResult {
  const attempts = input.rows.map(toPaymentAttempt);
  const ledger = calculatePaymentLedger({
    finalAmount: input.payment.final_amount,
    depositAmount: input.payment.deposit_amount,
    attempts,
  });
  const plan = latestPayRowsBySplit(input.rows, input.payment.split_count)
    .filter((row): row is PaymentAttemptRow => Boolean(row))
    .map(toPaymentAttempt);
  const currentAttempt = attempts.find((attempt) => attempt.id === input.currentAttemptId);
  if (!currentAttempt) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
  const nextAttempt = plan.find(
    (attempt) => !["APPROVED", "COMPLETED"].includes(attempt.status),
  ) ?? null;
  const paymentStatus = input.payment.status;
  const finalizationRequired =
    input.payment.reservation_source === "member_pass_purchase" &&
    paymentStatus === "PAID";
  return {
    reservationId: input.payment.reservation_id,
    paymentId: input.payment.id,
    ledgerRevision: paymentLedgerRevision(input.payment, input.rows),
    payment: toPayment(input.payment)!,
    summary: {
      finalAmount: ledger.finalAmount,
      depositAmount: ledger.depositAmount,
      payableAmount: ledger.payableAmount,
      approvedAmount: ledger.approvedAmount,
      completedAmount: ledger.completedAmount,
      splitApprovedAmount: ledger.splitApprovedAmount,
      remainingAmount: ledger.remainingAmount,
      approvedByMethod: ledger.approvedByMethod,
      hasUnknown: ledger.hasUnknown,
      hasBusy: ledger.hasBusy,
      amountLocked: ledger.amountLocked,
      paymentStatus,
      orderStatus: paymentStatus,
      currentSplitIndex: nextAttempt?.splitIndex ?? null,
    },
    currentAttempt,
    nextAttempt,
    plan,
    canUseNextSplit: Boolean(
      nextAttempt &&
      nextAttempt.id !== currentAttempt.id &&
      nextAttempt.status === "PENDING" &&
      !nextAttempt.commandId &&
      !nextAttempt.activeKey &&
      !ledger.hasUnknown &&
      !ledger.hasBusy &&
      ["PENDING", "PARTIALLY_PAID"].includes(paymentStatus)
    ),
    finalizationRequired,
    finalizationReady: !finalizationRequired || input.finalizationReady,
  };
}

export async function getMinimalNextSplitResult(input: {
  attemptId: string;
  dbTrace?: PaymentDbTrace;
}) {
  await measurePaymentDb(input.dbTrace, "minimal_result_ensure_payment_schema", () => ensurePaymentSchema());
  const db = getD1();
  const results = await measurePaymentDb(input.dbTrace, "minimal_next_split_batch", () => db.batch([
    db.prepare(`SELECT payment_row.*, r.source AS reservation_source FROM (
      ${PAYMENT_SELECT} WHERE id = (
        SELECT payment_id FROM payment_attempts WHERE id = ? LIMIT 1
      ) LIMIT 1
    ) payment_row JOIN reservations r ON r.id = payment_row.reservation_id`).bind(input.attemptId),
    db.prepare(`${ATTEMPT_SELECT} WHERE payment_id = (
        SELECT payment_id FROM payment_attempts WHERE id = ? LIMIT 1
      ) ORDER BY attempt_number DESC, requested_at DESC`).bind(input.attemptId),
    db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM pass_purchase_orders po
        JOIN payment_attempts pa ON pa.reservation_id = po.reservation_id
        WHERE pa.id = ? AND po.status = 'PAID' AND po.member_pass_id IS NOT NULL
      ) THEN 1 ELSE 0 END AS finalization_ready`).bind(input.attemptId),
  ]), { statementCount: 3 });
  const payment = (results[0]?.results?.[0] ?? null) as PaymentWithSourceRow | null;
  const rows = (results[1]?.results ?? []) as PaymentAttemptRow[];
  const finalization = (results[2]?.results?.[0] ?? null) as { finalization_ready?: number } | null;
  if (!payment) throw new Error("PAYMENT_PLAN_NOT_FOUND");
  return buildMinimalNextSplitResult({
    payment,
    rows,
    currentAttemptId: input.attemptId,
    finalizationReady: finalization?.finalization_ready === 1,
  });
}

export async function getPaymentExecutionContext(
  reservationId: string,
  attemptId: string,
  trace?: PaymentDbTrace,
): Promise<PaymentExecutionContext> {
  await measurePaymentDb(trace, "execution_ensure_payment_schema", () => ensurePaymentSchema());
  const payment = await paymentRow(reservationId, trace);
  if (!payment) {
    return {
      payment: null,
      attempt: null,
      firstUnfinishedAttemptId: null,
      hasUnknown: false,
      otherActiveAttemptId: null,
    };
  }
  const rows = await paymentRows(payment.reservation_id, payment.id, trace);
  const guard = evaluatePaymentExecutionGuard({
    attempts: rows,
    splitCount: payment.split_count,
    attemptId,
  });
  return {
    payment: toPayment(payment),
    attempt: guard.attempt ? toPaymentAttempt(guard.attempt) : null,
    firstUnfinishedAttemptId: guard.firstUnfinishedAttemptId,
    hasUnknown: guard.hasUnknown,
    otherActiveAttemptId: guard.otherActiveAttemptId,
  };
}

async function syncReservationPaymentSummary(
  reservationId: string,
  trace?: PaymentDbTrace,
  loadedContext?: Awaited<ReturnType<typeof paymentContext>>,
) {
  const context = loadedContext ?? await paymentContext(reservationId, trace);
  const { ledger, payment, attempts, allocations } = context;
  const failedFullCancel = Boolean(
    payment?.full_cancel_requested &&
    attempts.some(
      (attempt) =>
        attempt.attemptType === "CANCEL" &&
        ["DECLINED", "USER_CANCELLED", "ERROR"].includes(attempt.status),
    ),
  );
  const wholeStatus: PaymentWholeStatus =
    failedFullCancel && ledger.paymentStatus === "PAID"
      ? "PARTIALLY_CANCELLED"
      : ledger.paymentStatus;
  const activeMethods = ["card", "cash", "account", "coupon"].filter(
    (method) => (ledger.completedByMethod[method as PaymentMethod] ?? 0) > 0,
  );
  const method = activeMethods.length > 1 ? "mixed" : activeMethods[0] ?? "";
  const db = getD1();
  if (payment && allocations.length > 1) {
    const completedRows = context.rows
      .filter(
        (row) =>
          row.attempt_type === "PAY" &&
          ["APPROVED", "COMPLETED"].includes(row.status) &&
          !ledger.cancelledOriginals.has(row.id),
      )
      .sort(
        (left, right) =>
          left.split_index - right.split_index || left.attempt_number - right.attempt_number,
      )
      .map((row) => ({
        method: normalizePaymentMethod(row.payment_method),
        amount: Math.max(0, Number(row.amount) || 0),
      }));
    const reservationSummaries = allocateGroupPaymentMethods({
      allocations: allocations.map((allocation) => ({
        reservationId: allocation.reservation_id,
        finalAmount: allocation.final_amount,
        payableAmount: allocation.payable_amount,
      })),
      completedPayments: completedRows,
      wholeStatus,
    });
    const statements = reservationSummaries.map((summary) =>
      db.prepare(`UPDATE reservations SET payment_amount = ?,
          payment_card_amount = ?, payment_cash_amount = ?, payment_account_amount = ?,
          payment_method = ?, payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(
          summary.finalAmount,
          summary.cardAmount,
          summary.cashAmount,
          summary.accountAmount,
          summary.paymentMethod,
          summary.paymentStatus,
          summary.reservationId,
        ));
    statements.push(db.prepare(`UPDATE payments SET final_amount = ?, deposit_amount = ?,
        payable_amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(ledger.finalAmount, ledger.depositAmount, ledger.payableAmount, wholeStatus, payment.id));
    await measurePaymentDb(trace, "sync_group_summary_batch", () => db.batch(statements));
    if (["PAID", "CANCELLED"].includes(wholeStatus)) {
      await Promise.all(reservationSummaries.map((summary) =>
        measurePaymentDb(trace, "sync_attached_add_on_sale", () => syncAddOnSalePayment(
          summary.reservationId,
          wholeStatus,
          {
            card: summary.cardAmount,
            cash: summary.cashAmount,
            account: summary.accountAmount,
          },
          payment.id,
        ), { reservationId: summary.reservationId })));
    }
    return { ...ledger, paymentStatus: wholeStatus, orderStatus: wholeStatus };
  }
  await measurePaymentDb(trace, "sync_summary_batch", () => db.batch([
    db
      .prepare(`
        UPDATE reservations SET payment_amount = ?, payment_card_amount = ?,
          payment_cash_amount = ?, payment_account_amount = ?, payment_method = ?,
          payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `)
      .bind(
        ledger.finalAmount,
        ledger.completedByMethod.card,
        ledger.completedByMethod.cash,
        ledger.completedByMethod.account,
        method,
        wholeStatus.toLowerCase(),
        reservationId,
      ),
    ...(payment
      ? [db
          .prepare(`
            UPDATE payments SET final_amount = ?, deposit_amount = ?, payable_amount = ?,
              status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `)
          .bind(
            ledger.finalAmount,
            ledger.depositAmount,
            ledger.payableAmount,
            wholeStatus,
            payment.id,
          )]
      : []),
  ]));
  if (context.reservation.source === "member_pass_purchase" && ["PAID", "CANCELLED"].includes(wholeStatus)) {
    await measurePaymentDb(trace, "sync_pass_purchase", () => syncPassPurchasePayment(
      reservationId,
      wholeStatus,
      ledger.completedByMethod,
      payment?.id ?? "",
    ));
  } else if (context.reservation.source === "add_on_sale_purchase" && ["PAID", "CANCELLED"].includes(wholeStatus)) {
    await measurePaymentDb(trace, "sync_add_on_sale", () => syncAddOnSalePayment(
      reservationId,
      wholeStatus,
      ledger.completedByMethod,
      payment?.id ?? "",
    ));
  } else if (["PAID", "CANCELLED"].includes(wholeStatus) && context.reservation.add_on_amount > 0) {
    await measurePaymentDb(trace, "sync_attached_add_on_sale", () => syncAddOnSalePayment(
      reservationId,
      wholeStatus,
      ledger.completedByMethod,
      payment?.id ?? "",
    ));
  }
  return { ...ledger, paymentStatus: wholeStatus, orderStatus: wholeStatus };
}

async function validateCouponAttemptAmount(
  row: PaymentAttemptRow,
  trace?: PaymentDbTrace,
) {
  const context = await paymentContext(row.reservation_id, trace);
  if (!context.payment || context.payment.id !== row.payment_id) {
    throw new Error("PAYMENT_PLAN_NOT_FOUND");
  }
  const couponRows: PaymentAttemptRow[] = latestPayRowsBySplit(context.rows, context.payment.split_count)
    .filter((candidate): candidate is PaymentAttemptRow =>
      candidate !== null && normalizePaymentMethod(candidate.payment_method) === "coupon");
  const gameAmount = Math.max(
    0,
    context.requestedReservation.base_amount - context.requestedReservation.discount_amount,
  );
  const gameDeposit = context.requestedReservation.source === "naver"
    ? Math.min(context.pricing.naverDepositAmount, gameAmount)
    : 0;
  const validAmounts = memberCouponAmountsFitParticipantSlots({
    couponAmounts: couponRows.map((candidate) => candidate.amount),
    adultCount: context.requestedReservation.adult_count,
    youthCount: context.requestedReservation.youth_count,
    adultPrice: context.pricing.adultPrice,
    youthPrice: context.pricing.youthPrice,
    maximumCouponAmount: Math.max(0, gameAmount - gameDeposit),
  });
  if (!validAmounts) throw new Error("MEMBER_COUPON_AMOUNT_MISMATCH");
}

export async function preparePaymentPlan(input: {
  reservationId: string;
  reservationIds?: string[];
  addOnAmount: number;
  discountAmount: number;
  mode: PaymentPlanMode;
  count?: number;
  paymentMethod?: string;
  items?: Array<{ amount: unknown; paymentMethod: unknown; memberCouponId?: unknown }>;
  addOnSale?: AddOnSaleSelectionInput;
  requestKey: string;
  requestedBy: string;
  traceId?: string;
  dbTrace?: PaymentDbTrace;
  stageTrace?: PaymentStageTrace;
}) {
  const paymentDbTrace = input.dbTrace;
  await measurePaymentDb(paymentDbTrace, "ensure_payment_schema", () => ensurePaymentSchema());
  if (input.addOnSale !== undefined) {
    await measurePaymentDb(paymentDbTrace, "ensure_add_on_sale_schema", () => ensureAddOnSaleSchema());
  }
  const db = getD1();
  const requestKey = safeText(input.requestKey, 100);
  const traceId = normalizePaymentTraceId(input.traceId);
  if (!requestKey) throw new Error("PAYMENT_REQUEST_KEY_REQUIRED");
  input.stageTrace?.("READ_WAVE_START", { phase: "INITIAL", strategy: "safe_sequential" });
  const readWaveStarted = performance.now();
  const repeated = await measurePaymentStage(
    input.stageTrace,
    "PLAN_IDEMPOTENCY_START",
    "PLAN_IDEMPOTENCY_DONE",
    () => measurePaymentFirst(paymentDbTrace, "plan_idempotency_lookup", () => db
      .prepare(`${PAYMENT_SELECT} WHERE plan_request_key = ? LIMIT 1`)
      .bind(requestKey)
      .all<PaymentRow>()),
  );
  if (repeated) {
    input.stageTrace?.("READ_WAVE_DONE", {
      phase: "INITIAL",
      strategy: "idempotent_reuse",
      sequentialWaves: 1,
    }, performance.now() - readWaveStarted);
    return getPaymentOverview(input.reservationId, paymentDbTrace);
  }

  const context = await measurePaymentStage(
    input.stageTrace,
    "PAYMENT_CONTEXT_START",
    "PAYMENT_CONTEXT_DONE",
    () => paymentContext(input.reservationId, paymentDbTrace),
    { phase: "INITIAL" },
  );
  input.stageTrace?.("READ_WAVE_DONE", {
    phase: "INITIAL",
    strategy: "safe_sequential",
    sequentialWaves: 3,
  }, performance.now() - readWaveStarted);
  if (context.reservation.status === "cancelled") throw new Error("CANCELLED_RESERVATION");
  if (context.ledger.hasUnknown) throw new Error("PAYMENT_UNKNOWN");
  if (context.ledger.amountLocked) throw new Error("PAYMENT_PLAN_LOCKED");

  const addOnAmount = safeInteger(input.addOnAmount, 0, 10_000_000);
  const discountAmount = safeInteger(input.discountAmount, 0, 10_000_000);
  const attachedAddOnSale = input.addOnSale === undefined
    ? null
    : quoteAddOnSale(input.addOnSale, context.pricing);
  if (
    attachedAddOnSale &&
    ["member_pass_purchase", "add_on_sale_purchase"].includes(context.requestedReservation.source)
  ) throw new Error("ADD_ON_SALE_RESERVATION_ONLY");
  if (attachedAddOnSale && attachedAddOnSale.amount > addOnAmount) {
    throw new Error("ADD_ON_SALE_AMOUNT_MISMATCH");
  }
  const requestedIds = Array.from(new Set(
    (input.reservationIds ?? [input.reservationId]).map((value) => safeText(value, 100)).filter(Boolean),
  ));
  if (!requestedIds.includes(input.reservationId)) requestedIds.unshift(input.reservationId);
  if (requestedIds.length > 10) throw new Error("PAYMENT_GROUP_SIZE_INVALID");

  let reservationItems = [context.requestedReservation];
  if (requestedIds.length > 1) {
    const linked = await repeatGroupReservations(input.reservationId, paymentDbTrace);
    const linkedIds = new Set(linked.map((item) => item.id));
    if (!context.requestedReservation.repeat_group_id || requestedIds.some((id) => !linkedIds.has(id))) {
      throw new Error("PAYMENT_GROUP_RESERVATION_MISMATCH");
    }
    reservationItems = linked
      .filter((item) => requestedIds.includes(item.id))
      .sort((left, right) => left.repeat_sequence - right.repeat_sequence);
    if (reservationItems.length !== requestedIds.length) throw new Error("PAYMENT_GROUP_RESERVATION_MISMATCH");
    if (reservationItems.some((item) => item.status === "cancelled")) throw new Error("PAYMENT_GROUP_CANCELLED_RESERVATION");
    if (reservationItems.some((item) => ["member_pass_purchase", "add_on_sale_purchase"].includes(item.source))) {
      throw new Error("PAYMENT_GROUP_RESERVATION_ONLY");
    }
    if (reservationItems.some((item) => item.payment_status === "paid")) throw new Error("PAYMENT_GROUP_ITEM_ALREADY_PAID");
  }

  const allocationItems = reservationItems.map((item, index) => {
    const itemAddOn = item.id === input.reservationId ? addOnAmount : item.add_on_amount;
    const itemDiscount = item.id === input.reservationId ? discountAmount : item.discount_amount;
    const itemCatalogAddOn = item.id === input.reservationId
      ? attachedAddOnSale?.amount ?? 0
      : 0;
    const itemFinal = Math.max(0, item.base_amount + itemAddOn - itemDiscount);
    const itemGameFinal = Math.max(0, itemFinal - itemCatalogAddOn);
    const itemDeposit = item.source === "naver"
      ? Math.min(context.pricing.naverDepositAmount, itemGameFinal)
      : 0;
    return {
      reservation: item,
      sequence: index + 1,
      finalAmount: itemFinal,
      depositAmount: itemDeposit,
      payableAmount: Math.max(0, itemFinal - itemDeposit),
    };
  });
  const finalAmount = allocationItems.reduce((sum, item) => sum + item.finalAmount, 0);
  const depositAmount = allocationItems.reduce((sum, item) => sum + item.depositAmount, 0);
  const payableAmount = Math.max(0, finalAmount - depositAmount);
  const plan = buildPaymentPlan({
    payableAmount,
    mode: input.mode,
    count: input.count,
    paymentMethod: input.paymentMethod,
    items: input.items,
  });
  const requestedGameAmount = Math.max(
    0,
    context.requestedReservation.base_amount - discountAmount,
  );
  const requestedGameDeposit = context.requestedReservation.source === "naver"
    ? Math.min(context.pricing.naverDepositAmount, requestedGameAmount)
    : 0;
  const maximumGameCoupon = Math.max(0, requestedGameAmount - requestedGameDeposit);
  const couponTotal = plan
    .filter((item) => item.paymentMethod === "coupon")
    .reduce((sum, item) => sum + item.amount, 0);
  if (couponTotal > maximumGameCoupon) throw new Error("ADD_ON_SALE_COUPON_EXCEEDS_GAME_FEE");
  const paymentId = context.payment?.id ?? crypto.randomUUID();
  const paymentReservationId = context.payment?.reservation_id ?? input.reservationId;
  if (allocationItems.length > 1) {
    const placeholders = allocationItems.map(() => "?").join(",");
    const ids = allocationItems.map((item) => item.reservation.id);
    const conflict = await measurePaymentFirst(paymentDbTrace, "group_payment_conflict", () => db.prepare(`SELECT p.id FROM payments p
      WHERE p.id <> ? AND p.status <> 'CANCELLED' AND (
        p.reservation_id IN (${placeholders}) OR EXISTS (
          SELECT 1 FROM payment_allocations pa
          WHERE pa.payment_id = p.id AND pa.reservation_id IN (${placeholders})
        )
      ) LIMIT 1`).bind(paymentId, ...ids, ...ids).all<{ id: string }>());
    if (conflict) throw new Error("PAYMENT_GROUP_ITEM_HAS_PAYMENT");
    if (plan.some((item) => item.paymentMethod === "coupon")) {
      throw new Error("PAYMENT_GROUP_COUPON_NOT_SUPPORTED");
    }
  }
  const couponPlanItems = plan.filter((item) => item.paymentMethod === "coupon");
  const couponPlanIds = couponPlanItems.map((item) =>
    safeText(input.items?.[item.splitIndex - 1]?.memberCouponId, 100));
  const couponAllocations = allocateMemberCoupons({
    couponIds: couponPlanIds,
    adultCount: context.requestedReservation.adult_count,
    youthCount: context.requestedReservation.youth_count,
    adultPrice: context.pricing.adultPrice,
    youthPrice: context.pricing.youthPrice,
    maximumCouponAmount: maximumGameCoupon,
  });
  couponPlanItems.forEach((item, index) => {
    if (item.amount !== couponAllocations[index]?.amount) {
      throw new Error("MEMBER_COUPON_AMOUNT_MISMATCH");
    }
  });
  const couponIds = new Set<string>();
  const couponsBySplit = new Map<number, string>();
  for (const item of plan) {
    if (item.paymentMethod !== "coupon") continue;
    const couponId = safeText(input.items?.[item.splitIndex - 1]?.memberCouponId, 100);
    if (!couponId) throw new Error("MEMBER_COUPON_REQUIRED");
    if (couponIds.has(couponId)) throw new Error("MEMBER_COUPON_DUPLICATE_IN_PLAN");
    await measurePaymentDb(paymentDbTrace, "validate_member_coupon", () => validateMemberCouponForPayment({
      couponId,
      reservationId: input.reservationId,
      memberId: context.requestedReservation.member_id,
    }));
    couponIds.add(couponId);
    couponsBySplit.set(item.splitIndex, couponId);
  }
  input.stageTrace?.("PLAN_VALIDATION_DONE", {
    paymentId,
    splitCount: plan.length,
    allocationCount: allocationItems.length,
    payableAmount,
  });
  let attemptNumber = await nextAttemptNumber(paymentReservationId, "PAY", paymentDbTrace);
  const statements = [
    db
      .prepare(`
        UPDATE reservations SET add_on_amount = ?, discount_amount = ?,
          payment_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `)
      .bind(addOnAmount, discountAmount, allocationItems.find((item) => item.reservation.id === input.reservationId)?.finalAmount ?? 0, input.reservationId),
    context.payment
      ? db.prepare(`UPDATE payments SET payment_type = 'RESERVATION', member_id = ?,
          mode = ?, split_count = ?, final_amount = ?, deposit_amount = ?,
          payable_amount = ?, status = ?, full_cancel_requested = 0,
          plan_request_key = ?, requested_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).bind(
          context.requestedReservation.member_id,
          input.mode,
          plan.length,
          finalAmount,
          depositAmount,
          payableAmount,
          payableAmount === 0 ? "PAID" : "PENDING",
          requestKey,
          input.requestedBy,
          paymentId,
        )
      : db.prepare(`
        INSERT INTO payments (
          id, reservation_id, payment_type, member_id, mode, split_count,
          final_amount, deposit_amount, payable_amount, status,
          full_cancel_requested, plan_request_key, requested_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(reservation_id) DO UPDATE SET
          payment_type = excluded.payment_type,
          member_id = excluded.member_id,
          mode = excluded.mode,
          split_count = excluded.split_count,
          final_amount = excluded.final_amount,
          deposit_amount = excluded.deposit_amount,
          payable_amount = excluded.payable_amount,
          status = excluded.status,
          full_cancel_requested = 0,
          plan_request_key = excluded.plan_request_key,
          requested_by = excluded.requested_by,
          updated_at = CURRENT_TIMESTAMP
      `)
      .bind(
        paymentId,
        paymentReservationId,
        context.requestedReservation.source === "member_pass_purchase"
          ? "PASS_PURCHASE"
          : context.reservation.source === "add_on_sale_purchase"
            ? "ADD_ON_SALE"
            : "RESERVATION",
        context.requestedReservation.member_id,
        input.mode,
        plan.length,
        finalAmount,
        depositAmount,
        payableAmount,
        payableAmount === 0 ? "PAID" : "PENDING",
        requestKey,
        input.requestedBy,
      ),
    db
      .prepare(`
        UPDATE payment_attempts SET status = 'USER_CANCELLED', active_key = NULL,
          response_message = '결제 계획 변경', error_code = 'PLAN_REPLACED',
          completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE payment_id = ? AND attempt_type = 'PAY'
          AND status IN ('PENDING', 'DECLINED', 'USER_CANCELLED', 'ERROR')
      `)
      .bind(paymentId),
    db.prepare(`DELETE FROM payment_allocations WHERE payment_id = ?`).bind(paymentId),
  ];
  if (attachedAddOnSale) {
    if (attachedAddOnSale.amount > 0) {
      statements.push(db.prepare(`
        INSERT INTO add_on_sale_orders (
          id, reservation_id, sales_date, item_summary,
          slush_count, beverage_count, other_count,
          slush_unit_price, beverage_unit_price, other_unit_price,
          items_json, amount, status, payment_status, payment_id,
          payment_card_amount, payment_cash_amount, payment_account_amount,
          requested_by, paid_at, cancelled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'PAYMENT_PENDING', 'PENDING', ?, 0, 0, 0, ?, NULL, NULL)
        ON CONFLICT(reservation_id) DO UPDATE SET
          sales_date = excluded.sales_date,
          item_summary = excluded.item_summary,
          slush_count = excluded.slush_count,
          beverage_count = excluded.beverage_count,
          other_count = excluded.other_count,
          slush_unit_price = excluded.slush_unit_price,
          beverage_unit_price = excluded.beverage_unit_price,
          other_unit_price = excluded.other_unit_price,
          items_json = excluded.items_json,
          amount = excluded.amount,
          status = 'PAYMENT_PENDING', payment_status = 'PENDING',
          payment_id = excluded.payment_id,
          payment_card_amount = 0, payment_cash_amount = 0,
          payment_account_amount = 0, requested_by = excluded.requested_by,
          paid_at = NULL, cancelled_at = NULL, updated_at = CURRENT_TIMESTAMP
      `).bind(
        crypto.randomUUID(),
        input.reservationId,
        context.requestedReservation.scheduled_date,
        attachedAddOnSale.summary,
        attachedAddOnSale.counts.slush,
        attachedAddOnSale.counts.beverage,
        attachedAddOnSale.counts.other,
        context.pricing.slushPrice,
        context.pricing.beveragePrice,
        context.pricing.otherPrice,
        JSON.stringify(attachedAddOnSale.extraItems),
        attachedAddOnSale.amount,
        paymentId,
        input.requestedBy,
      ));
    } else {
      statements.push(db.prepare(`
        DELETE FROM add_on_sale_orders
        WHERE reservation_id = ? AND status IN ('PAYMENT_PENDING', 'CANCELLED')
      `).bind(input.reservationId));
    }
  }
  for (const item of allocationItems) {
    statements.push(db.prepare(`INSERT INTO payment_allocations (
        payment_id, reservation_id, sequence, final_amount, deposit_amount, payable_amount
      ) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(paymentId, item.reservation.id, item.sequence, item.finalAmount, item.depositAmount, item.payableAmount));
  }
  for (const item of plan) {
    statements.push(
      db
        .prepare(`
          INSERT INTO payment_attempts (
            id, reservation_id, payment_id, member_id, member_coupon_id, split_index, attempt_type,
            attempt_number, amount, sale_amount, add_on_amount, discount_amount,
            payment_method, status, trace_id, requested_by
          ) VALUES (?, ?, ?, ?, ?, ?, 'PAY', ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
        `)
        .bind(
          crypto.randomUUID(),
          paymentReservationId,
          paymentId,
          context.requestedReservation.member_id,
          couponsBySplit.get(item.splitIndex) ?? null,
          item.splitIndex,
          attemptNumber++,
          item.amount,
          finalAmount,
          addOnAmount,
          discountAmount,
          item.paymentMethod,
          traceId,
          input.requestedBy,
        ),
    );
  }
  await measurePaymentStage(
    input.stageTrace,
    "PLAN_WRITE_START",
    "PLAN_WRITE_DONE",
    () => measurePaymentDb(paymentDbTrace, "prepare_plan_write_batch", () => db.batch(statements), {
      statementCount: statements.length,
    }),
    { paymentId, statementCount: statements.length },
  );
  const preparedContext = await measurePaymentStage(
    input.stageTrace,
    "PLAN_READBACK_START",
    "PLAN_READBACK_DONE",
    () => preparedPaymentContext(
      input.reservationId,
      paymentId,
      context.pricing,
      paymentDbTrace,
    ),
    { paymentId },
  );
  const latestPreparedRows = latestPayRowsBySplit(
    preparedContext.rows,
    preparedContext.payment.split_count,
  );
  const planMatches = preparedContext.payment.id === paymentId
    && preparedContext.payment.plan_request_key === requestKey
    && preparedContext.payment.final_amount === finalAmount
    && preparedContext.payment.deposit_amount === depositAmount
    && preparedContext.payment.payable_amount === payableAmount
    && preparedContext.payment.split_count === plan.length
    && latestPreparedRows.length === plan.length
    && latestPreparedRows.every((row, index) => Boolean(
      row
      && row.split_index === plan[index].splitIndex
      && row.amount === plan[index].amount
      && normalizePaymentMethod(row.payment_method) === plan[index].paymentMethod,
    ));
  if (!planMatches) throw new Error("PAYMENT_PLAN_STALE");
  await syncReservationPaymentSummary(input.reservationId, paymentDbTrace, preparedContext);
  return getPaymentOverview(
    input.reservationId,
    paymentDbTrace,
    preparedContext,
    preparedContext.terminal,
  );
}

export async function prepareParticipantTopUpPlan(input: {
  reservationId: string;
  expectedAdultCount: number;
  expectedYouthCount: number;
  additionalAdultCount: number;
  additionalYouthCount: number;
  mode: PaymentPlanMode;
  count?: number;
  paymentMethod?: string;
  items?: Array<{ amount: unknown; paymentMethod: unknown }>;
  requestKey: string;
  requestedBy: string;
  traceId?: string;
}) {
  await ensurePaymentSchema();
  const requestKey = safeText(input.requestKey, 80);
  if (!requestKey) throw new Error("PAYMENT_REQUEST_KEY_REQUIRED");

  const expectedAdultCount = safeInteger(input.expectedAdultCount, 0, 10);
  const expectedYouthCount = safeInteger(input.expectedYouthCount, 0, 10);
  const additionalAdultCount = safeInteger(input.additionalAdultCount, 0, 10);
  const additionalYouthCount = safeInteger(input.additionalYouthCount, 0, 10);
  const additionalCount = additionalAdultCount + additionalYouthCount;
  const targetAdultCount = expectedAdultCount + additionalAdultCount;
  const targetYouthCount = expectedYouthCount + additionalYouthCount;
  const targetTotalCount = targetAdultCount + targetYouthCount;
  if (additionalCount < 1) throw new Error("KIOSK_PARTICIPANT_TOP_UP_EMPTY");
  if (targetTotalCount > 10) throw new Error("KIOSK_PARTY_INVALID");

  const context = await participantTopUpPaymentContext(input.reservationId);
  const topUpAmount = additionalAdultCount * context.pricing.adultPrice +
    additionalYouthCount * context.pricing.youthPrice;
  if (topUpAmount <= 0) throw new Error("KIOSK_PARTICIPANT_TOP_UP_EMPTY");
  const plan = buildPaymentPlan({
    payableAmount: topUpAmount,
    mode: input.mode,
    count: input.count,
    paymentMethod: input.paymentMethod,
    items: input.items,
  });
  if (plan.some((item) => !["card", "cash", "account"].includes(item.paymentMethod))) {
    throw new Error("KIOSK_PAYMENT_ITEMS_INVALID");
  }

  const markerPrefix = `KIOSK_PARTICIPANT_TOP_UP:${requestKey}:`;
  const repeatedRows = context.rows
    .filter((row) => row.attempt_type === "PAY" && row.operator_note.startsWith(markerPrefix))
    .sort((left, right) => left.split_index - right.split_index);
  if (repeatedRows.length) {
    const repeatedAmount = repeatedRows.reduce((sum, row) => sum + row.amount, 0);
    const repeatedPlanMatches = repeatedRows.length === plan.length && repeatedRows.every((row, index) => (
      row.amount === plan[index]?.amount &&
      normalizePaymentMethod(row.payment_method) === plan[index]?.paymentMethod
    ));
    if (!repeatedPlanMatches || repeatedAmount !== topUpAmount) {
      throw new Error("PAYMENT_REQUEST_KEY_CONFLICT");
    }
    return getPaymentOverview(input.reservationId);
  }

  if (!context.payment || context.payment.status !== "PAID") {
    throw new Error("KIOSK_PARTICIPANT_TOP_UP_PAYMENT_REQUIRED");
  }
  if (context.reservation.status === "cancelled" || context.reservation.status === "completed") {
    throw new Error("KIOSK_PARTICIPANT_TOP_UP_NOT_ACTIVE");
  }
  if (context.ledger.hasUnknown || context.ledger.hasBusy) throw new Error("PAYMENT_UNKNOWN");
  if (context.ledger.remainingAmount !== 0 || context.ledger.cancelledOriginals.size > 0) {
    throw new Error("KIOSK_PARTICIPANT_TOP_UP_PAYMENT_REQUIRED");
  }
  if (context.allocations.length > 1) throw new Error("KIOSK_PARTICIPANT_TOP_UP_GROUPED");
  if (
    context.reservation.adult_count !== expectedAdultCount ||
    context.reservation.youth_count !== expectedYouthCount ||
    context.reservation.total_count !== expectedAdultCount + expectedYouthCount
  ) {
    throw new Error("KIOSK_PARTICIPANT_TOP_UP_STALE");
  }
  const latestPlan = latestPayRowsBySplit(context.rows, context.payment.split_count);
  if (latestPlan.length !== context.payment.split_count || !latestPlan.every(successfulPay)) {
    throw new Error("KIOSK_PARTICIPANT_TOP_UP_PAYMENT_REQUIRED");
  }

  const firstSplitIndex = context.payment.split_count + 1;
  const targetSplitCount = context.payment.split_count + plan.length;
  const targetBaseAmount = context.reservation.base_amount + topUpAmount;
  const targetFinalAmount = context.ledger.finalAmount + topUpAmount;
  const targetPayableAmount = context.ledger.payableAmount + topUpAmount;
  const traceId = normalizePaymentTraceId(input.traceId);
  const db = getD1();
  const attemptIds = plan.map(() => crypto.randomUUID());
  let attemptNumber = await nextAttemptNumber(context.reservation.id, "PAY");
  const statements: D1PreparedStatement[] = [];

  for (const [index, item] of plan.entries()) {
    const splitIndex = firstSplitIndex + index;
    statements.push(db.prepare(`INSERT INTO payment_attempts (
        id, reservation_id, payment_id, member_id, split_index, attempt_type,
        attempt_number, amount, sale_amount, add_on_amount, discount_amount,
        payment_method, status, trace_id, operator_note, requested_by
      )
      SELECT ?, r.id, p.id, r.member_id, ?, 'PAY', ?, ?, ?, r.add_on_amount,
        r.discount_amount, ?, 'PENDING', ?, ?, ?
      FROM payments p
      JOIN reservations r ON r.id = p.reservation_id
      WHERE p.id = ? AND p.reservation_id = ? AND p.status = 'PAID'
        AND p.split_count = ? AND p.final_amount = ? AND p.deposit_amount = ?
        AND p.payable_amount = ?
        AND r.adult_count = ? AND r.youth_count = ? AND r.total_count = ?
        AND r.base_amount = ? AND r.status NOT IN ('cancelled', 'completed')
        AND NOT EXISTS (
          SELECT 1 FROM payment_attempts active
          WHERE active.payment_id = p.id AND active.attempt_type = 'PAY'
            AND (active.active_key IS NOT NULL OR active.status IN ('PROCESSING', 'BUSY', 'UNKNOWN'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM payment_attempts duplicate
          WHERE duplicate.payment_id = p.id AND duplicate.operator_note = ?
        )`)
      .bind(
        attemptIds[index], splitIndex, attemptNumber++, item.amount, targetFinalAmount,
        item.paymentMethod, traceId, `${markerPrefix}${splitIndex}`, input.requestedBy,
        context.payment.id, context.reservation.id, context.payment.split_count,
        context.payment.final_amount, context.payment.deposit_amount,
        context.payment.payable_amount, expectedAdultCount, expectedYouthCount,
        expectedAdultCount + expectedYouthCount, context.reservation.base_amount,
        `${markerPrefix}${splitIndex}`,
      ));
  }

  const attemptPlaceholders = attemptIds.map(() => "?").join(", ");
  statements.push(
    db.prepare(`UPDATE reservations SET adult_count = ?, youth_count = ?, total_count = ?,
        base_amount = ?, payment_amount = ?, payment_status = 'pending',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND adult_count = ? AND youth_count = ? AND total_count = ?
        AND base_amount = ? AND status NOT IN ('cancelled', 'completed')
        AND (SELECT COUNT(*) FROM payment_attempts
          WHERE id IN (${attemptPlaceholders}) AND payment_id = ?) = ?`)
      .bind(
        targetAdultCount, targetYouthCount, targetTotalCount, targetBaseAmount,
        targetFinalAmount, context.reservation.id, expectedAdultCount,
        expectedYouthCount, expectedAdultCount + expectedYouthCount,
        context.reservation.base_amount, ...attemptIds, context.payment.id, plan.length,
      ),
    db.prepare(`UPDATE payments SET mode = 'custom', split_count = ?, final_amount = ?,
        payable_amount = ?, status = 'PENDING', requested_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'PAID' AND split_count = ? AND final_amount = ?
        AND deposit_amount = ? AND payable_amount = ?
        AND (SELECT COUNT(*) FROM payment_attempts
          WHERE id IN (${attemptPlaceholders}) AND payment_id = ?) = ?`)
      .bind(
        targetSplitCount, targetFinalAmount, targetPayableAmount, input.requestedBy,
        context.payment.id, context.payment.split_count, context.payment.final_amount,
        context.payment.deposit_amount, context.payment.payable_amount,
        ...attemptIds, context.payment.id, plan.length,
      ),
    db.prepare(`INSERT INTO payment_allocations (
        payment_id, reservation_id, sequence, final_amount, deposit_amount, payable_amount
      ) SELECT ?, ?, 1, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM payment_attempts
        WHERE id IN (${attemptPlaceholders}) AND payment_id = ?) = ?
      ON CONFLICT(payment_id, reservation_id) DO UPDATE SET
        final_amount = excluded.final_amount,
        deposit_amount = excluded.deposit_amount,
        payable_amount = excluded.payable_amount,
        updated_at = CURRENT_TIMESTAMP`)
      .bind(
        context.payment.id, context.reservation.id, targetFinalAmount,
        context.payment.deposit_amount, targetPayableAmount,
        ...attemptIds, context.payment.id, plan.length,
      ),
    db.prepare(`INSERT INTO reservation_events
        (id, reservation_id, event_type, details_json, created_by)
      SELECT ?, ?, 'participant_top_up_started', ?, ?
      WHERE (SELECT COUNT(*) FROM payment_attempts
        WHERE id IN (${attemptPlaceholders}) AND payment_id = ?) = ?`)
      .bind(
        crypto.randomUUID(), context.reservation.id,
        JSON.stringify({
          expectedAdultCount,
          expectedYouthCount,
          additionalAdultCount,
          additionalYouthCount,
          targetAdultCount,
          targetYouthCount,
          amount: topUpAmount,
          requestKey,
        }),
        input.requestedBy, ...attemptIds, context.payment.id, plan.length,
      ),
  );

  const results = await db.batch(statements);
  const reservationWrite = results[plan.length];
  const paymentWrite = results[plan.length + 1];
  if (
    Number(reservationWrite?.meta.changes ?? 0) !== 1 ||
    Number(paymentWrite?.meta.changes ?? 0) !== 1
  ) {
    throw new Error("KIOSK_PARTICIPANT_TOP_UP_STALE");
  }

  await syncReservationPaymentSummary(context.reservation.id);
  const overview = await getPaymentOverview(context.reservation.id);
  const appended = overview.plan.filter((item) => item.splitIndex >= firstSplitIndex);
  if (
    appended.length !== plan.length ||
    appended.reduce((sum, item) => sum + item.amount, 0) !== topUpAmount
  ) {
    throw new Error("KIOSK_PARTICIPANT_TOP_UP_STALE");
  }
  return overview;
}

async function executePaymentAttempt(input: {
  row: PaymentAttemptRow;
  requestKey: string;
  requestedBy: string;
  traceId?: string;
  dbTrace?: PaymentDbTrace;
}) {
  const { row } = input;
  const db = getD1();
  const requestKey = safeText(input.requestKey, 100);
  const traceId = normalizePaymentTraceId(input.traceId || row.trace_id);
  if (!requestKey) throw new Error("PAYMENT_REQUEST_KEY_REQUIRED");
  const repeated = await attemptByRequestKey(requestKey, input.dbTrace);
  if (repeated) return repeated;
  if (row.status !== "PENDING") throw new Error("PAYMENT_TRANSACTION_NOT_PENDING");
  const active = await activeTerminalAttempt(input.dbTrace);
  if (active && active.id !== row.id) throw new Error("PAYMENT_TERMINAL_BUSY");

  const method = normalizePaymentMethod(row.payment_method);
  const isCard = method === "card";
  const commandId = isCard ? crypto.randomUUID() : null;
  if (isCard) {
    if (!row.payment_id) throw new Error("PAYMENT_PLAN_NOT_FOUND");
    let results: D1Result<unknown>[];
    try {
      results = await measurePaymentDb(input.dbTrace, "queue_card_payment_batch", () => db.batch([
        db
          .prepare(`
            UPDATE payment_attempts SET status = 'PROCESSING', command_id = ?,
              request_key = ?, active_key = 'MPOS:ACTIVE', requested_by = ?,
              transaction_source = 'CLOUD_FAST_LANE',
              response_message = '', error_code = 'NONE', trace_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND payment_id = ? AND reservation_id = ?
              AND attempt_type = 'PAY' AND payment_method = 'card'
              AND status = 'PENDING' AND command_id IS NULL AND active_key IS NULL
              AND EXISTS (
                SELECT 1 FROM payments parent
                WHERE parent.id = payment_attempts.payment_id
                  AND parent.status IN ('PENDING', 'PARTIALLY_PAID')
                  AND COALESCE(parent.full_cancel_requested, 0) = 0
              )
          `)
          .bind(commandId, requestKey, input.requestedBy, traceId, row.id, row.payment_id, row.reservation_id),
        db
          .prepare(`
            INSERT INTO commands
              (id, room_id, action, payload_json, status, requested_by, target_agent_id, expires_at)
            SELECT ?, 'PAYMENT', 'payment_pay', ?, 'pending', ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM payment_attempts attempt
              JOIN payments parent ON parent.id = attempt.payment_id
              WHERE attempt.id = ? AND attempt.payment_id = ? AND attempt.reservation_id = ?
                AND attempt.attempt_type = 'PAY' AND attempt.payment_method = 'card'
                AND attempt.status = 'PROCESSING' AND attempt.command_id = ?
                AND attempt.request_key = ? AND attempt.active_key = 'MPOS:ACTIVE'
                AND parent.status IN ('PENDING', 'PARTIALLY_PAID')
                AND COALESCE(parent.full_cancel_requested, 0) = 0
            )
          `)
          .bind(
            commandId,
            JSON.stringify({
              reservationId: row.reservation_id,
              transactionUuid: row.id,
              amount: row.amount,
              traceId,
            }),
            input.requestedBy,
            getControlAgentId(),
            new Date(Date.now() + 120_000).toISOString(),
            row.id,
            row.payment_id,
            row.reservation_id,
            commandId,
            requestKey,
          ),
      ]), { statementCount: 2 });
    } catch (error) {
      const [current, terminal] = await Promise.all([
        attemptById(row.id, input.dbTrace),
        activeTerminalAttempt(input.dbTrace),
      ]);
      if (current?.request_key === requestKey && current.command_id) return toPaymentAttempt(current);
      if (terminal && terminal.id !== row.id) throw new Error("PAYMENT_TERMINAL_BUSY");
      if (!current || current.status !== "PENDING") throw new Error("PAYMENT_TRANSACTION_NOT_PENDING");
      throw error;
    }
    const claimChanges = Number(results[0]?.meta.changes ?? 0);
    const commandChanges = Number(results[1]?.meta.changes ?? 0);
    if (claimChanges !== 1 || commandChanges !== 1) {
      const [current, terminal] = await Promise.all([
        attemptById(row.id, input.dbTrace),
        activeTerminalAttempt(input.dbTrace),
      ]);
      if (
        current?.request_key === requestKey &&
        current.command_id === commandId &&
        current.status === "PROCESSING"
      ) return toPaymentAttempt(current);
      if (terminal && terminal.id !== row.id) throw new Error("PAYMENT_TERMINAL_BUSY");
      if (!current || current.status !== "PENDING") throw new Error("PAYMENT_TRANSACTION_NOT_PENDING");
      throw new Error("PAYMENT_COMMAND_QUEUE_CONFLICT");
    }
  } else if (method === "coupon") {
    if (!row.member_coupon_id) throw new Error("MEMBER_COUPON_REQUIRED");
    await validateCouponAttemptAmount(row, input.dbTrace);
    await validateMemberCouponForPayment({
      couponId: row.member_coupon_id,
      reservationId: row.reservation_id,
      memberId: row.member_id,
    });
    const results = await measurePaymentDb(
      input.dbTrace,
      "complete_coupon_payment_batch",
      () => db.batch([
      db.prepare(`UPDATE member_coupons SET status = 'USED', used_at = CURRENT_TIMESTAMP,
          used_reservation_id = ?, used_payment_attempt_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND member_id = ? AND status = 'ACTIVE'
          AND datetime(expires_at) > CURRENT_TIMESTAMP`)
        .bind(row.reservation_id, row.id, row.member_coupon_id, row.member_id),
      db.prepare(`UPDATE payment_attempts SET status = 'COMPLETED', request_key = ?,
          requested_by = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'PENDING'
          AND EXISTS (SELECT 1 FROM member_coupons WHERE id = ? AND status = 'USED' AND used_payment_attempt_id = ?)`)
        .bind(requestKey, input.requestedBy, row.id, row.member_coupon_id, row.id),
      ]),
      { statementCount: 2 },
    );
    if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error("MEMBER_COUPON_NOT_ACTIVE");
    }
    await syncReservationPaymentSummary(row.reservation_id, input.dbTrace);
  } else {
    await measurePaymentDb(input.dbTrace, "complete_manual_payment", () => db.prepare(`
        UPDATE payment_attempts SET status = 'COMPLETED', request_key = ?,
          requested_by = ?, completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PENDING'
      `)
      .bind(requestKey, input.requestedBy, row.id)
      .run());
    await syncReservationPaymentSummary(row.reservation_id, input.dbTrace);
  }
  const updated = await attemptById(row.id, input.dbTrace);
  if (!updated) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
  return toPaymentAttempt(updated);
}

export async function processPaymentTransaction(input: {
  reservationId: string;
  transactionId: string;
  requestKey: string;
  requestedBy: string;
  traceId?: string;
  dbTrace?: PaymentDbTrace;
}) {
  const dbTrace = input.dbTrace;
  await measurePaymentDb(dbTrace, "ensure_payment_schema", () => ensurePaymentSchema());
  const context = await paymentContext(input.reservationId, dbTrace);
  if (!context.payment) throw new Error("PAYMENT_PLAN_NOT_FOUND");
  if (context.ledger.hasUnknown) throw new Error("PAYMENT_UNKNOWN");
  const row = context.rows.find(
    (candidate) =>
      candidate.id === input.transactionId &&
      candidate.payment_id === context.payment?.id &&
      candidate.attempt_type === "PAY",
  );
  if (!row) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
  if (successfulPay(row)) return toPaymentAttempt(row);
  const splitRows = latestPayRowsBySplit(context.rows, context.payment.split_count);
  const next = splitRows.find((candidate) => !successfulPay(candidate));
  if (!next || next.id !== row.id) throw new Error("PAYMENT_TRANSACTION_OUT_OF_ORDER");
  return executePaymentAttempt({
    row,
    requestKey: input.requestKey,
    requestedBy: input.requestedBy,
    traceId: input.traceId,
    dbTrace,
  });
}

export async function cancelUnstartedKioskPaymentPlan(input: {
  reservationId: string;
  reservationIds?: string[];
  visitId: string;
  requestedBy: string;
}) {
  await ensurePaymentSchema();
  const reservationId = safeText(input.reservationId, 100);
  const visitId = safeText(input.visitId, 100);
  if (!reservationId || !visitId) throw new Error("KIOSK_PAYMENT_CANCEL_NOT_ALLOWED");
  const expectedReservationIds = Array.from(new Set(
    (input.reservationIds ?? [reservationId]).map((value) => safeText(value, 100)).filter(Boolean),
  ));
  if (!expectedReservationIds.length) throw new Error("KIOSK_PAYMENT_CANCEL_NOT_ALLOWED");

  const context = await paymentContext(reservationId);
  if (!context.payment) {
    const placeholders = expectedReservationIds.map(() => "?").join(",");
    const visit = await getD1().prepare(`SELECT status FROM customer_visits WHERE id = ? LIMIT 1`)
      .bind(visitId).first<{ status: string }>();
    const unsafeAttempt = await getD1().prepare(`SELECT id FROM payment_attempts
      WHERE reservation_id IN (${placeholders}) AND attempt_type IN ('PAY', 'CANCEL') LIMIT 1`)
      .bind(...expectedReservationIds).first<{ id: string }>();
    if (visit?.status !== "PAYMENT_PENDING" || unsafeAttempt) {
      throw new Error("KIOSK_PAYMENT_CANCEL_NOT_ALLOWED");
    }
    return {
      ok: true,
      paymentId: "",
      reservationIds: expectedReservationIds,
      alreadyCancelled: true,
    };
  }
  const paymentId = context.payment.id;
  const reservationIds = Array.from(new Set(context.allocations.length
    ? context.allocations.map((item) => item.reservation_id)
    : [context.payment.reservation_id]));
  if (
    reservationIds.length !== expectedReservationIds.length ||
    reservationIds.some((value) => !expectedReservationIds.includes(value))
  ) {
    throw new Error("KIOSK_PAYMENT_CANCEL_NOT_ALLOWED");
  }
  const payRows = context.rows.filter((row) => row.attempt_type === "PAY");
  const unsafeRow = payRows.some((row) =>
    !["PENDING", "USER_CANCELLED"].includes(row.status) ||
    Boolean(row.command_id || row.active_key || row.auth_no || row.mpos_transaction_id),
  );
  const hasCancelAttempt = context.rows.some((row) => row.attempt_type === "CANCEL");
  const currentPlan = latestPayRowsBySplit(context.rows, context.payment.split_count);
  const pendingPlanIsSafe = currentPlan.length === context.payment.split_count && currentPlan.every((row) =>
    Boolean(row) && row!.status === "PENDING" && row!.payment_method !== "coupon" &&
    !row!.member_coupon_id && !row!.command_id && !row!.active_key && !row!.auth_no &&
    !row!.request_key && row!.mpos_transaction_id === null,
  );

  if (
    context.payment.status !== "PENDING" || context.payment.full_cancel_requested !== 0 ||
    context.ledger.hasUnknown || context.ledger.hasBusy || context.ledger.completedPayments.length > 0 ||
    unsafeRow || hasCancelAttempt || !pendingPlanIsSafe
  ) {
    throw new Error("KIOSK_PAYMENT_CANCEL_NOT_ALLOWED");
  }

  const db = getD1();
  const results = await db.batch([
    db.prepare(`UPDATE payments SET status = 'CANCELLED', requested_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'PENDING' AND COALESCE(full_cancel_requested, 0) = 0
        AND EXISTS (
          SELECT 1 FROM customer_visits visit
          WHERE visit.id = ? AND visit.status = 'PAYMENT_PENDING'
        )
        AND (SELECT COUNT(*) FROM payment_attempts pending
          WHERE pending.payment_id = payments.id AND pending.attempt_type = 'PAY'
            AND pending.status = 'PENDING' AND pending.payment_method <> 'coupon'
            AND pending.member_coupon_id IS NULL AND pending.command_id IS NULL
            AND pending.active_key IS NULL AND COALESCE(pending.auth_no, '') = ''
            AND pending.mpos_transaction_id IS NULL) = payments.split_count
        AND NOT EXISTS (
          SELECT 1 FROM payment_attempts unsafe
          WHERE unsafe.payment_id = payments.id
            AND (unsafe.attempt_type <> 'PAY'
              OR unsafe.status NOT IN ('PENDING', 'USER_CANCELLED')
              OR unsafe.command_id IS NOT NULL OR unsafe.active_key IS NOT NULL
              OR COALESCE(unsafe.auth_no, '') <> '' OR unsafe.mpos_transaction_id IS NOT NULL)
        )
        AND NOT EXISTS (
          SELECT 1 FROM kiosk_bank_transfer_sessions transfer
          WHERE transfer.visit_id = ? AND transfer.status = 'ACTIVE'
        )`)
      .bind(safeText(input.requestedBy, 120), paymentId, visitId, visitId),
    db.prepare(`DELETE FROM payment_attempts
      WHERE payment_id = ? AND attempt_type = 'PAY' AND status IN ('PENDING', 'USER_CANCELLED')
        AND command_id IS NULL AND active_key IS NULL AND COALESCE(auth_no, '') = ''
        AND mpos_transaction_id IS NULL
        AND EXISTS (SELECT 1 FROM payments parent WHERE parent.id = payment_attempts.payment_id
          AND parent.status = 'CANCELLED')`).bind(paymentId),
    db.prepare(`DELETE FROM payment_allocations
      WHERE payment_id = ?
        AND EXISTS (SELECT 1 FROM payments parent WHERE parent.id = payment_allocations.payment_id
          AND parent.status = 'CANCELLED')
        AND NOT EXISTS (SELECT 1 FROM payment_attempts attempt WHERE attempt.payment_id = ?)`)
      .bind(paymentId, paymentId),
    db.prepare(`DELETE FROM payments WHERE id = ? AND status = 'CANCELLED'
      AND NOT EXISTS (SELECT 1 FROM payment_attempts attempt WHERE attempt.payment_id = payments.id)
      AND NOT EXISTS (SELECT 1 FROM payment_allocations allocation WHERE allocation.payment_id = payments.id)`)
      .bind(paymentId),
  ]);
  const paymentChanges = Number(results[0]?.meta.changes ?? 0);
  const attemptChanges = Number(results[1]?.meta.changes ?? 0);
  const allocationChanges = Number(results[2]?.meta.changes ?? 0);
  const deleteChanges = Number(results[3]?.meta.changes ?? 0);
  if (
    paymentChanges !== 1 || attemptChanges !== payRows.length ||
    allocationChanges !== context.allocations.length || deleteChanges !== 1
  ) {
    throw new Error("KIOSK_PAYMENT_CANCEL_NOT_ALLOWED");
  }
  return { ok: true, paymentId, reservationIds, alreadyCancelled: false };
}

export async function changePendingPaymentTransactionMethod(input: {
  reservationId: string;
  transactionId: string;
  paymentMethod: string;
  requestedBy: string;
}) {
  await ensurePaymentSchema();
  const paymentMethod = String(input.paymentMethod).trim().toLowerCase();
  if (!["card", "cash", "account"].includes(paymentMethod)) {
    throw new Error("PAYMENT_METHOD_CHANGE_INVALID");
  }
  const context = await paymentContext(input.reservationId);
  if (!context.payment) throw new Error("PAYMENT_PLAN_NOT_FOUND");
  if (context.ledger.hasUnknown) throw new Error("PAYMENT_UNKNOWN");
  const row = context.rows.find(
    (candidate) =>
      candidate.id === input.transactionId &&
      candidate.payment_id === context.payment?.id &&
      candidate.attempt_type === "PAY",
  );
  if (!row) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
  if (row.status !== "PENDING" || row.command_id || row.active_key) {
    throw new Error("PAYMENT_METHOD_CHANGE_NOT_ALLOWED");
  }
  const splitRows = latestPayRowsBySplit(context.rows, context.payment.split_count);
  const next = splitRows.find((candidate) => !successfulPay(candidate));
  if (!next || next.id !== row.id) throw new Error("PAYMENT_TRANSACTION_OUT_OF_ORDER");

  const result = await getD1()
    .prepare(`
      UPDATE payment_attempts
      SET payment_method = ?, member_coupon_id = NULL, requested_by = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'PENDING'
        AND command_id IS NULL AND active_key IS NULL
    `)
    .bind(paymentMethod, input.requestedBy, row.id)
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new Error("PAYMENT_METHOD_CHANGE_NOT_ALLOWED");
  }
  const updated = await attemptById(row.id);
  if (!updated) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
  return toPaymentAttempt(updated);
}

/**
 * Starts the first transaction from an overview that was created in the same
 * request. The normal process endpoint intentionally reloads the full payment
 * context because it receives a client-selected transaction. The integrated
 * start endpoint selects the transaction from the freshly prepared server
 * overview, so reloading every reservation, allocation and attempt here only
 * adds a second D1 round trip to the critical path.
 */
export async function processPreparedPaymentTransaction(input: {
  reservationId: string;
  paymentId: string;
  transactionId: string;
  expectedSplitIndex: number;
  requestKey: string;
  requestedBy: string;
  traceId?: string;
  dbTrace?: PaymentDbTrace;
}) {
  await measurePaymentDb(input.dbTrace, "ensure_payment_schema", () => ensurePaymentSchema());
  const requestKey = safeText(input.requestKey, 100);
  if (!requestKey) throw new Error("PAYMENT_REQUEST_KEY_REQUIRED");

  const repeated = await attemptByRequestKey(requestKey, input.dbTrace);
  if (repeated) {
    if (repeated.paymentId !== input.paymentId || repeated.attemptType !== "PAY") {
      throw new Error("PAYMENT_REQUEST_KEY_CONFLICT");
    }
    return repeated;
  }

  const row = await attemptById(input.transactionId, input.dbTrace);
  if (
    !row ||
    row.payment_id !== input.paymentId ||
    row.attempt_type !== "PAY" ||
    row.split_index !== input.expectedSplitIndex
  ) {
    throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
  }
  if (input.expectedSplitIndex !== 1) throw new Error("PAYMENT_TRANSACTION_OUT_OF_ORDER");
  if (successfulPay(row)) return toPaymentAttempt(row);

  return executePaymentAttempt({
    row,
    requestKey,
    requestedBy: input.requestedBy,
    traceId: input.traceId,
    dbTrace: input.dbTrace,
  });
}

export async function retryPaymentTransaction(input: {
  reservationId: string;
  transactionId: string;
  requestKey: string;
  requestedBy: string;
  traceId?: string;
  paymentMethod?: string;
}) {
  await ensurePaymentSchema();
  const repeated = await attemptByRequestKey(safeText(input.requestKey, 100));
  if (repeated) return repeated;
  const context = await paymentContext(input.reservationId);
  if (!context.payment) throw new Error("PAYMENT_PLAN_NOT_FOUND");
  if (context.ledger.hasUnknown) throw new Error("PAYMENT_UNKNOWN");
  const original = context.rows.find(
    (row) => row.id === input.transactionId && row.attempt_type === "PAY",
  );
  if (!original || !["DECLINED", "USER_CANCELLED", "ERROR", "BUSY", "UNLINKED"].includes(original.status)) {
    throw new Error("PAYMENT_TRANSACTION_NOT_RETRYABLE");
  }
  const splitRows = latestPayRowsBySplit(context.rows, context.payment.split_count);
  const next = splitRows.find((candidate) => !successfulPay(candidate));
  if (!next || next.id !== original.id) throw new Error("PAYMENT_TRANSACTION_OUT_OF_ORDER");
  const hasPaymentMethodOverride = input.paymentMethod != null;
  const requestedPaymentMethod = hasPaymentMethodOverride
    ? String(input.paymentMethod).trim().toLowerCase()
    : normalizePaymentMethod(original.payment_method);
  if (hasPaymentMethodOverride && !["card", "cash", "account"].includes(requestedPaymentMethod)) {
    throw new Error("PAYMENT_RETRY_METHOD_INVALID");
  }
  const attemptNumber = await nextAttemptNumber(original.reservation_id, "PAY");
  const rowId = crypto.randomUUID();
  await getD1()
    .prepare(`
      INSERT INTO payment_attempts (
        id, reservation_id, payment_id, split_index, attempt_type, attempt_number,
        amount, sale_amount, add_on_amount, discount_amount, payment_method, member_coupon_id,
        status, trace_id, requested_by
      ) VALUES (?, ?, ?, ?, 'PAY', ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `)
    .bind(
      rowId,
      original.reservation_id,
      original.payment_id,
      original.split_index,
      attemptNumber,
      original.amount,
      original.sale_amount,
      original.add_on_amount,
      original.discount_amount,
      requestedPaymentMethod,
      requestedPaymentMethod === "coupon" ? original.member_coupon_id : null,
      normalizePaymentTraceId(input.traceId),
      input.requestedBy,
    )
    .run();
  const row = await attemptById(rowId);
  if (!row) throw new Error("PAYMENT_ATTEMPT_NOT_CREATED");
  return executePaymentAttempt({
    row,
    requestKey: input.requestKey,
    requestedBy: input.requestedBy,
    traceId: input.traceId,
  });
}

export async function preparePaymentTransactionRetry(input: {
  reservationId: string;
  transactionId: string;
  requestKey: string;
  requestedBy: string;
  traceId?: string;
  paymentMethod?: string;
}) {
  await ensurePaymentSchema();
  const requestKey = safeText(input.requestKey, 100);
  if (!requestKey) throw new Error("PAYMENT_REQUEST_KEY_REQUIRED");
  const repeated = await attemptByRequestKey(requestKey);
  if (repeated) return repeated;
  const context = await paymentContext(input.reservationId);
  if (!context.payment) throw new Error("PAYMENT_PLAN_NOT_FOUND");
  if (context.ledger.hasUnknown) throw new Error("PAYMENT_UNKNOWN");
  const original = context.rows.find(
    (row) => row.id === input.transactionId && row.attempt_type === "PAY",
  );
  if (!original || !["DECLINED", "USER_CANCELLED", "ERROR", "BUSY", "UNLINKED"].includes(original.status)) {
    throw new Error("PAYMENT_TRANSACTION_NOT_RETRYABLE");
  }
  const splitRows = latestPayRowsBySplit(context.rows, context.payment.split_count);
  const next = splitRows.find((candidate) => !successfulPay(candidate));
  if (!next || next.id !== original.id) throw new Error("PAYMENT_TRANSACTION_OUT_OF_ORDER");
  const requestedPaymentMethod = input.paymentMethod == null
    ? normalizePaymentMethod(original.payment_method)
    : String(input.paymentMethod).trim().toLowerCase();
  if (!["card", "cash", "account"].includes(requestedPaymentMethod)) {
    throw new Error("PAYMENT_RETRY_METHOD_INVALID");
  }
  const attemptNumber = await nextAttemptNumber(original.reservation_id, "PAY");
  const rowId = crypto.randomUUID();
  await getD1()
    .prepare(`
      INSERT INTO payment_attempts (
        id, reservation_id, payment_id, split_index, attempt_type, attempt_number,
        amount, sale_amount, add_on_amount, discount_amount, payment_method, member_coupon_id,
        status, request_key, trace_id, requested_by
      ) VALUES (?, ?, ?, ?, 'PAY', ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
    `)
    .bind(
      rowId,
      original.reservation_id,
      original.payment_id,
      original.split_index,
      attemptNumber,
      original.amount,
      original.sale_amount,
      original.add_on_amount,
      original.discount_amount,
      requestedPaymentMethod,
      null,
      requestKey,
      normalizePaymentTraceId(input.traceId),
      input.requestedBy,
    )
    .run();
  const row = await attemptById(rowId);
  if (!row) throw new Error("PAYMENT_ATTEMPT_NOT_CREATED");
  return toPaymentAttempt(row);
}

async function createCancellation(input: {
  original: PaymentAttemptRow;
  requestKey: string;
  requestedBy: string;
  traceId?: string;
}) {
  const db = getD1();
  if (input.original.transaction_source === "TERMINAL_DIRECT") {
    throw new Error("PAYMENT_TERMINAL_DIRECT_CANCEL_UNVERIFIED");
  }
  const requestKey = safeText(input.requestKey, 100);
  const traceId = normalizePaymentTraceId(input.traceId);
  const repeated = await attemptByRequestKey(requestKey);
  if (repeated) return repeated;
  const existing = await db
    .prepare(`
      ${ATTEMPT_SELECT} WHERE original_attempt_id = ? AND attempt_type = 'CANCEL'
        AND status IN ('PROCESSING', 'PENDING', 'UNKNOWN', 'BUSY', 'CANCELLED')
      ORDER BY attempt_number DESC LIMIT 1
    `)
    .bind(input.original.id)
    .first<PaymentAttemptRow>();
  if (existing) return toPaymentAttempt(existing);

  const isCard = normalizePaymentMethod(input.original.payment_method) === "card";
  if (isCard && (!input.original.auth_no || !input.original.auth_date)) {
    throw new Error("ORIGINAL_AUTH_MISSING");
  }
  const active = await activeTerminalAttempt();
  if (isCard && active) throw new Error("PAYMENT_TERMINAL_BUSY");
  const attemptNumber = await nextAttemptNumber(input.original.reservation_id, "CANCEL");
  const transactionUuid = crypto.randomUUID();
  const commandId = isCard ? crypto.randomUUID() : null;
  const status: PaymentStatus = isCard ? "PROCESSING" : "CANCELLED";
  const payload = {
    reservationId: input.original.reservation_id,
    transactionUuid,
    amount: input.original.amount,
    originalAttemptId: input.original.id,
    originalMposTransactionId: input.original.mpos_transaction_id,
    authNo: input.original.auth_no,
    authDate: input.original.auth_date,
    traceId,
  };
  await db.batch([
    db
      .prepare(`
        INSERT INTO payment_attempts (
          id, reservation_id, payment_id, member_id, member_coupon_id, split_index, attempt_type,
          attempt_number, amount, sale_amount, add_on_amount, discount_amount,
          payment_method, status, auth_no, auth_date, original_attempt_id,
          original_mpos_transaction_id, command_id, request_key, active_key,
          trace_id, requested_by, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'CANCEL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, CASE WHEN ? = 'CANCELLED' THEN CURRENT_TIMESTAMP ELSE NULL END)
      `)
      .bind(
        transactionUuid,
        input.original.reservation_id,
        input.original.payment_id,
        input.original.member_id,
        input.original.member_coupon_id,
        input.original.split_index,
        attemptNumber,
        input.original.amount,
        input.original.sale_amount,
        input.original.add_on_amount,
        input.original.discount_amount,
        input.original.payment_method,
        status,
        input.original.auth_no,
        input.original.auth_date,
        input.original.id,
        input.original.mpos_transaction_id,
        commandId,
        requestKey,
        isCard ? "MPOS:ACTIVE" : null,
        traceId,
        input.requestedBy,
        status,
      ),
    ...(isCard
      ? [db
          .prepare(`
            INSERT INTO commands
              (id, room_id, action, payload_json, status, requested_by, target_agent_id, expires_at)
            VALUES (?, 'PAYMENT', 'payment_cancel', ?, 'pending', ?, ?, ?)
          `)
          .bind(
            commandId,
            JSON.stringify(payload),
            input.requestedBy,
            getControlAgentId(),
            new Date(Date.now() + 120_000).toISOString(),
          )]
      : []),
    ...(normalizePaymentMethod(input.original.payment_method) === "coupon" && input.original.member_coupon_id
      ? [db.prepare(`UPDATE member_coupons SET
          status = CASE WHEN datetime(expires_at) <= CURRENT_TIMESTAMP THEN 'EXPIRED' ELSE 'ACTIVE' END,
          used_at = NULL, used_reservation_id = NULL, used_payment_attempt_id = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'USED' AND used_payment_attempt_id = ?`)
          .bind(input.original.member_coupon_id, input.original.id)]
      : []),
  ]);
  if (!isCard) await syncReservationPaymentSummary(input.original.reservation_id);
  const created = await attemptById(transactionUuid);
  if (!created) throw new Error("CANCEL_ATTEMPT_NOT_CREATED");
  return toPaymentAttempt(created);
}

export async function requestPaymentCancellation(input: {
  reservationId: string;
  paymentId: string;
  requestKey: string;
  requestedBy: string;
  traceId?: string;
}) {
  await ensurePaymentSchema();
  await assertPassPurchaseRefundable(input.reservationId);
  const context = await paymentContext(input.reservationId);
  if (context.ledger.hasUnknown) throw new Error("PAYMENT_UNKNOWN");
  const original = context.rows.find(
    (row) =>
      row.id === input.paymentId &&
      row.attempt_type === "PAY" &&
      ["APPROVED", "COMPLETED"].includes(row.status) &&
      !context.ledger.cancelledOriginals.has(row.id),
  );
  if (!original) throw new Error("APPROVED_PAYMENT_NOT_FOUND");
  return createCancellation({
    original,
    requestKey: input.requestKey,
    requestedBy: input.requestedBy,
    traceId: input.traceId,
  });
}

async function advanceFullCancellation(
  reservationId: string,
  requestedBy: string,
  requestKeyPrefix: string,
  traceId = "",
) {
  for (let guard = 0; guard < 25; guard += 1) {
    await assertPassPurchaseRefundable(reservationId);
    const context = await paymentContext(reservationId);
    if (!context.payment) throw new Error("PAYMENT_PLAN_NOT_FOUND");
    if (context.ledger.hasUnknown) throw new Error("PAYMENT_UNKNOWN");
    const active = await activeTerminalAttempt();
    if (active) return toPaymentAttempt(active);
    const originals = context.rows
      .filter(
        (row) =>
          row.attempt_type === "PAY" &&
          ["APPROVED", "COMPLETED"].includes(row.status) &&
          !context.ledger.cancelledOriginals.has(row.id),
      )
      .sort((left, right) => {
        const time = String(right.completed_at ?? right.updated_at).localeCompare(
          String(left.completed_at ?? left.updated_at),
        );
        return time || right.attempt_number - left.attempt_number;
      });
    const original = originals[0];
    if (!original) {
      await getD1()
        .prepare(`
          UPDATE payments SET full_cancel_requested = 0,
            status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .bind(context.payment.id)
        .run();
      await syncReservationPaymentSummary(reservationId);
      return null;
    }
    const failedCount = context.rows.filter(
      (row) => row.attempt_type === "CANCEL" && row.original_attempt_id === original.id,
    ).length;
    const result = await createCancellation({
      original,
      requestKey: `${requestKeyPrefix}:${original.id}:${failedCount + 1}`.slice(0, 100),
      requestedBy,
      traceId,
    });
    if (normalizePaymentMethod(original.payment_method) === "card") return result;
  }
  throw new Error("FULL_CANCELLATION_GUARD_EXCEEDED");
}

export async function requestFullPaymentCancellation(input: {
  reservationId: string;
  requestKey: string;
  requestedBy: string;
  traceId?: string;
}) {
  await ensurePaymentSchema();
  await assertPassPurchaseRefundable(input.reservationId);
  const requestKey = safeText(input.requestKey, 60);
  if (!requestKey) throw new Error("PAYMENT_REQUEST_KEY_REQUIRED");
  const context = await paymentContext(input.reservationId);
  if (!context.payment) throw new Error("PAYMENT_PLAN_NOT_FOUND");
  const active = await activeTerminalAttempt();
  if (active) throw new Error("PAYMENT_TERMINAL_BUSY");
  await getD1()
    .prepare(`
      UPDATE payments SET full_cancel_requested = 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `)
    .bind(context.payment.id)
    .run();
  const attempt = await advanceFullCancellation(
    input.reservationId,
    input.requestedBy,
    `full:${requestKey}`,
    normalizePaymentTraceId(input.traceId),
  );
  return { attempt, overview: await getPaymentOverview(input.reservationId) };
}

export async function requestTerminalStatus(requestedBy: string, traceId?: string) {
  await ensurePaymentSchema();
  const db = getD1();
  const existing = await db
    .prepare(`
      SELECT id FROM commands WHERE action = 'payment_status'
        AND status IN ('pending', 'claimed') ORDER BY created_at DESC LIMIT 1
    `)
    .first<{ id: string }>();
  if (!existing) {
    await db
      .prepare(`
        INSERT INTO commands
          (id, room_id, action, payload_json, status, requested_by, target_agent_id, expires_at)
        VALUES (?, 'PAYMENT', 'payment_status', ?, 'pending', ?, ?, ?)
      `)
      .bind(
        crypto.randomUUID(),
        JSON.stringify({ traceId: normalizePaymentTraceId(traceId) }),
        requestedBy,
        getControlAgentId(),
        new Date(Date.now() + 45_000).toISOString(),
      )
      .run();
  }
  return getPaymentOverview("");
}

export async function reconcileUnknownPayment(input: {
  reservationId: string;
  transactionId: string;
  authNo: unknown;
  authDate: unknown;
  requestedBy: string;
}) {
  await ensurePaymentSchema();
  const authNo = normalizeAuthorizationNumber(input.authNo);
  const authDate = normalizeAuthorizationDate(input.authDate);
  const context = await paymentContext(input.reservationId);
  const row = await attemptById(input.transactionId);
  if (
    !row ||
    !context.payment ||
    row.payment_id !== context.payment.id ||
    row.attempt_type !== "PAY" ||
    normalizePaymentMethod(row.payment_method) !== "card"
  ) {
    throw new Error("PAYMENT_RECONCILIATION_ATTEMPT_NOT_FOUND");
  }

  if (row.status === "APPROVED") {
    if (row.auth_no === authNo && row.auth_date.replace(/\D/g, "") === authDate) {
      return getPaymentOverview(input.reservationId);
    }
    throw new Error("PAYMENT_RECONCILIATION_CONFLICT");
  }
  if (row.status !== "UNKNOWN") {
    throw new Error("PAYMENT_RECONCILIATION_NOT_UNKNOWN");
  }

  const duplicate = await getD1()
    .prepare(`
      SELECT id FROM payment_attempts
      WHERE id != ? AND attempt_type = 'PAY' AND amount = ? AND auth_no = ?
        AND substr(replace(replace(auth_date, '-', ''), ':', ''), 1, 8) = ?
        AND status IN ('APPROVED', 'COMPLETED', 'UNKNOWN')
      LIMIT 1
    `)
    .bind(row.id, row.amount, authNo, authDate.slice(0, 8))
    .first<{ id: string }>();
  if (duplicate) throw new Error("PAYMENT_RECONCILIATION_DUPLICATE");

  await getD1()
    .prepare(`
      UPDATE payment_attempts SET status = 'APPROVED', response_code = 'MANUAL',
        response_message = '운영자 확인으로 실승인 대조 완료', auth_no = ?,
        auth_date = ?, error_code = 'MANUAL_RECONCILED', active_key = NULL,
        requested_by = ?, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND reservation_id = ? AND attempt_type = 'PAY'
        AND payment_method = 'card' AND status = 'UNKNOWN'
    `)
    .bind(authNo, authDate, input.requestedBy, row.id, row.reservation_id)
    .run();

  const updated = await attemptById(row.id);
  if (updated?.status !== "APPROVED" || updated.auth_no !== authNo) {
    throw new Error("PAYMENT_RECONCILIATION_CONFLICT");
  }
  await syncReservationPaymentSummary(input.reservationId);
  return getPaymentOverview(input.reservationId);
}

export async function recordExternalApprovedPayment(input: {
  reservationId: string;
  amount: unknown;
  authNo: unknown;
  authDate: unknown;
  approvalTime?: unknown;
  cardName?: unknown;
  cardLast4?: unknown;
  terminalId?: unknown;
  externalTransactionId?: unknown;
  reason: unknown;
  requestedBy: string;
}) {
  await ensurePaymentSchema();
  const authNo = normalizeAuthorizationNumber(input.authNo);
  const authDate = normalizeAuthorizationDate(input.authDate);
  const approvalTime = normalizeApprovalTime(input.approvalTime);
  const terminalId = normalizeTerminalId(input.terminalId);
  const maskedCardNo = normalizeMaskedCardLast4(input.cardLast4);
  const reason = normalizeManualPaymentReason(input.reason);
  const cardName = safeText(input.cardName, 100);
  const externalTransactionId = safeText(input.externalTransactionId, 100);
  const context = await paymentContext(input.reservationId);
  if (context.reservation.status === "cancelled") throw new Error("CANCELLED_RESERVATION");
  if (context.ledger.hasUnknown || context.ledger.hasBusy) {
    throw new Error("PAYMENT_EXTERNAL_IMPORT_BLOCKED");
  }

  const requestedAmount = safeInteger(input.amount, 0, 10_000_000);
  if (requestedAmount <= 0) throw new Error("PAYMENT_EXTERNAL_IMPORT_AMOUNT_INVALID");
  const externalKey = externalTerminalTransactionKey({
    approvalNo: authNo,
    approvalDate: authDate,
    amount: requestedAmount,
    terminalId,
  });
  const duplicate = await getD1()
    .prepare(`
      SELECT id, reservation_id, status FROM payment_attempts
      WHERE attempt_type = 'PAY'
        AND (
          external_transaction_key = ?
          OR (
            amount = ? AND auth_no = ?
            AND substr(replace(replace(auth_date, '-', ''), ':', ''), 1, 8) = ?
            AND transaction_source = 'TERMINAL_DIRECT'
          )
        )
        AND status IN ('APPROVED', 'COMPLETED', 'UNKNOWN')
      LIMIT 1
    `)
    .bind(externalKey, requestedAmount, authNo, authDate.slice(0, 8))
    .first<{ id: string; reservation_id: string; status: string }>();
  if (duplicate) {
    if (
      duplicate.reservation_id === input.reservationId &&
      ["APPROVED", "COMPLETED"].includes(duplicate.status)
    ) {
      return getPaymentOverview(input.reservationId);
    }
    throw new Error("PAYMENT_RECONCILIATION_DUPLICATE");
  }

  const db = getD1();
  const auditId = crypto.randomUUID();
  let paymentId = context.payment?.id ?? crypto.randomUUID();
  let attemptId = crypto.randomUUID();
  const requestKey = `external-approved:${externalKey}`;

  if (context.payment) {
    const latestPlan = latestPayRowsBySplit(context.rows, context.payment.split_count);
    const next = latestPlan.find((row) => !successfulPay(row));
    if (!next) {
      const nextSplitIndex = context.payment.split_count + 1;
      const topUpAllowed = !["member_pass_purchase", "add_on_sale_purchase"].includes(
        context.reservation.source,
      ) && canAppendExternalApprovalTopUp({
        requestedAmount,
        remainingAmount: context.ledger.remainingAmount,
        storedPayableAmount: context.payment.payable_amount,
        authoritativePayableAmount: context.ledger.payableAmount,
        paymentStatus: context.payment.status,
        splitCount: context.payment.split_count,
        plannedSplitCount: latestPlan.length,
        allPlannedSplitsSuccessful: latestPlan.every(successfulPay),
        hasCancelledPayments: context.ledger.cancelledOriginals.size > 0,
        hasGroupAllocations: context.allocations.length > 1,
      });
      if (!topUpAllowed) throw new Error("PAYMENT_EXTERNAL_IMPORT_PLAN_CONFLICT");

      const amount = matchExternalApprovalAmount(
        requestedAmount,
        context.ledger.remainingAmount,
      );
      const attemptNumber = await nextAttemptNumber(context.reservation.id, "PAY");
      const topUpRequestKey = externalApprovalTopUpRequestKey({
        paymentId,
        authoritativePayableAmount: context.ledger.payableAmount,
        splitIndex: nextSplitIndex,
      });
      const auditDetails = JSON.stringify({
        paymentId,
        attemptId,
        splitIndex: nextSplitIndex,
        amount,
        authNo,
        authDate: authDate.slice(0, 8),
        approvalTime,
        terminalId,
        verificationStatus: "MANUAL",
        reason,
        adjustment: "AUTHORITATIVE_AMOUNT_INCREASE",
      });
      await db.batch([
        db.prepare(`INSERT INTO payment_attempts (
            id, reservation_id, payment_id, split_index, attempt_type, attempt_number,
            amount, sale_amount, add_on_amount, discount_amount, payment_method, status,
            response_code, response_message, auth_no, auth_date, issuer_name,
            masked_card_no, error_code, request_key, transaction_source,
            verification_status, approval_time, terminal_id, external_transaction_id,
            external_transaction_key, operator_note, requested_by, completed_at
          ) SELECT ?, ?, p.id, ?, 'PAY', ?, ?, ?, ?, ?, 'card', 'APPROVED',
            'MANUAL_EXTERNAL', '인원·금액 정정 후 단말 직접 승인건을 운영자가 수동 연결',
            ?, ?, ?, ?, 'MANUAL_RECORDED', ?, 'TERMINAL_DIRECT', 'MANUAL', ?, ?, ?, ?, ?, ?,
            CURRENT_TIMESTAMP
          FROM payments p
          WHERE p.id = ? AND p.status = 'PAID' AND p.split_count = ?
            AND p.payable_amount = ?
            AND NOT EXISTS (
              SELECT 1 FROM payment_attempts active
              WHERE active.payment_id = p.id AND active.attempt_type = 'PAY'
                AND (active.active_key IS NOT NULL OR active.status IN ('PENDING', 'PROCESSING', 'BUSY', 'UNKNOWN'))
            )
            AND NOT EXISTS (
              SELECT 1 FROM payment_attempts extra
              WHERE extra.payment_id = p.id AND extra.attempt_type = 'PAY'
                AND extra.split_index > p.split_count AND extra.status <> 'UNLINKED'
            )`)
          .bind(attemptId, context.reservation.id, nextSplitIndex, attemptNumber, amount,
            context.ledger.finalAmount, context.reservation.add_on_amount,
            context.reservation.discount_amount, authNo, authDate, cardName, maskedCardNo,
            topUpRequestKey, approvalTime, terminalId, externalTransactionId, externalKey,
            reason, input.requestedBy, paymentId, context.payment.split_count,
            context.payment.payable_amount),
        db.prepare(`UPDATE payments SET mode = 'custom', split_count = ?, final_amount = ?,
            deposit_amount = ?, payable_amount = ?, status = 'PAID',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND EXISTS (
            SELECT 1 FROM payment_attempts WHERE id = ? AND payment_id = ?
              AND status = 'APPROVED' AND external_transaction_key = ?
          )`)
          .bind(nextSplitIndex, context.ledger.finalAmount, context.ledger.depositAmount,
            context.ledger.payableAmount, paymentId, attemptId, paymentId, externalKey),
        db.prepare(`INSERT INTO reservation_events
            (id, reservation_id, event_type, details_json, created_by)
          SELECT ?, ?, 'terminal_direct_payment_linked', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM payment_attempts WHERE id = ? AND payment_id = ?
              AND status = 'APPROVED' AND external_transaction_key = ?
          )`)
          .bind(auditId, input.reservationId, auditDetails, input.requestedBy,
            attemptId, paymentId, externalKey),
      ]);
      const appended = await attemptById(attemptId);
      if (
        appended?.status !== "APPROVED" ||
        appended.external_transaction_key !== externalKey ||
        appended.split_index !== nextSplitIndex
      ) {
        throw new Error("PAYMENT_EXTERNAL_IMPORT_PLAN_CONFLICT");
      }
    } else if (normalizePaymentMethod(next.payment_method) !== "card") {
      throw new Error("PAYMENT_EXTERNAL_IMPORT_PLAN_CONFLICT");
    } else {
    let amount: number;
    try {
      amount = matchExternalApprovalAmount(requestedAmount, next.amount);
    } catch (error) {
      if (error instanceof Error && error.message === "PAYMENT_EXTERNAL_IMPORT_AMOUNT_MISMATCH") {
        throw new Error("PAYMENT_EXTERNAL_IMPORT_SPLIT_MISMATCH");
      }
      throw error;
    }
    const auditDetails = JSON.stringify({
      paymentId,
      attemptId: next.id,
      amount,
      authNo,
      authDate: authDate.slice(0, 8),
      approvalTime,
      terminalId,
      verificationStatus: "MANUAL",
      reason,
    });
    if (next.status === "PENDING" && !next.command_id && !next.active_key) {
      attemptId = next.id;
      await db.batch([
        db.prepare(`UPDATE payment_attempts SET
            status = 'APPROVED', response_code = 'MANUAL_EXTERNAL',
            response_message = '단말 직접 승인건을 운영자가 수동 연결',
            auth_no = ?, auth_date = ?, issuer_name = ?, masked_card_no = ?,
            error_code = 'MANUAL_RECORDED', transaction_source = 'TERMINAL_DIRECT',
            verification_status = 'MANUAL', approval_time = ?, terminal_id = ?,
            external_transaction_id = ?, external_transaction_key = ?, operator_note = ?,
            requested_by = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'PENDING' AND command_id IS NULL AND active_key IS NULL`)
          .bind(authNo, authDate, cardName, maskedCardNo, approvalTime, terminalId,
            externalTransactionId, externalKey, reason, input.requestedBy, next.id),
        db.prepare(`INSERT INTO reservation_events
            (id, reservation_id, event_type, details_json, created_by)
          VALUES (?, ?, 'terminal_direct_payment_linked', ?, ?)`)
          .bind(auditId, input.reservationId, auditDetails, input.requestedBy),
      ]);
    } else if (["DECLINED", "USER_CANCELLED", "ERROR", "BUSY", "UNLINKED"].includes(next.status)) {
      const attemptNumber = await nextAttemptNumber(context.reservation.id, "PAY");
      const auditDetailsWithAttempt = JSON.stringify({
        ...JSON.parse(auditDetails),
        attemptId,
      });
      await db.batch([
        db.prepare(`INSERT INTO payment_attempts (
            id, reservation_id, payment_id, split_index, attempt_type, attempt_number,
            amount, sale_amount, add_on_amount, discount_amount, payment_method, status,
            response_code, response_message, auth_no, auth_date, issuer_name,
            masked_card_no, error_code, request_key, transaction_source,
            verification_status, approval_time, terminal_id, external_transaction_id,
            external_transaction_key, operator_note, requested_by, completed_at
          ) VALUES (?, ?, ?, ?, 'PAY', ?, ?, ?, ?, ?, 'card', 'APPROVED',
            'MANUAL_EXTERNAL', '단말 직접 승인건을 운영자가 수동 연결', ?, ?, ?, ?,
            'MANUAL_RECORDED', ?, 'TERMINAL_DIRECT', 'MANUAL', ?, ?, ?, ?, ?, ?,
            CURRENT_TIMESTAMP)`)
          .bind(attemptId, context.reservation.id, paymentId, next.split_index,
            attemptNumber, amount, context.ledger.finalAmount,
            context.reservation.add_on_amount, context.reservation.discount_amount,
            authNo, authDate, cardName, maskedCardNo, requestKey, approvalTime,
            terminalId, externalTransactionId, externalKey, reason, input.requestedBy),
        db.prepare(`INSERT INTO reservation_events
            (id, reservation_id, event_type, details_json, created_by)
          VALUES (?, ?, 'terminal_direct_payment_linked', ?, ?)`)
          .bind(auditId, input.reservationId, auditDetailsWithAttempt, input.requestedBy),
      ]);
    } else {
      throw new Error("PAYMENT_EXTERNAL_IMPORT_PLAN_CONFLICT");
    }
    }
  } else {
    if (context.rows.length > 0) throw new Error("PAYMENT_EXTERNAL_IMPORT_CONFLICT");
    const amount = matchExternalApprovalAmount(
      requestedAmount,
      context.ledger.remainingAmount,
    );
    const auditDetails = JSON.stringify({
      paymentId,
      attemptId,
      amount,
      authNo,
      authDate: authDate.slice(0, 8),
      approvalTime,
      terminalId,
      verificationStatus: "MANUAL",
      reason,
    });
    await db.batch([
      db.prepare(`INSERT INTO payments (
          id, reservation_id, mode, split_count, final_amount, deposit_amount,
          payable_amount, status, full_cancel_requested, plan_request_key, requested_by
        ) VALUES (?, ?, 'single', 1, ?, ?, ?, 'PAID', 0, ?, ?)`)
        .bind(paymentId, context.reservation.id, context.ledger.finalAmount,
          context.ledger.depositAmount, context.ledger.payableAmount, requestKey,
          input.requestedBy),
      db.prepare(`INSERT INTO payment_attempts (
          id, reservation_id, payment_id, split_index, attempt_type, attempt_number,
          amount, sale_amount, add_on_amount, discount_amount, payment_method, status,
          response_code, response_message, auth_no, auth_date, issuer_name,
          masked_card_no, error_code, request_key, transaction_source,
          verification_status, approval_time, terminal_id, external_transaction_id,
          external_transaction_key, operator_note, requested_by, completed_at
        ) VALUES (?, ?, ?, 1, 'PAY', 1, ?, ?, ?, ?, 'card', 'APPROVED',
          'MANUAL_EXTERNAL', '단말 직접 승인건을 운영자가 수동 연결', ?, ?, ?, ?,
          'MANUAL_RECORDED', ?, 'TERMINAL_DIRECT', 'MANUAL', ?, ?, ?, ?, ?, ?,
          CURRENT_TIMESTAMP)`)
        .bind(attemptId, context.reservation.id, paymentId, amount,
          context.ledger.finalAmount, context.reservation.add_on_amount,
          context.reservation.discount_amount, authNo, authDate, cardName,
          maskedCardNo, requestKey, approvalTime, terminalId, externalTransactionId,
          externalKey, reason, input.requestedBy),
      db.prepare(`INSERT INTO reservation_events
          (id, reservation_id, event_type, details_json, created_by)
        VALUES (?, ?, 'terminal_direct_payment_linked', ?, ?)`)
        .bind(auditId, input.reservationId, auditDetails, input.requestedBy),
    ]);
  }
  await syncReservationPaymentSummary(context.reservation.id);
  return getPaymentOverview(input.reservationId);
}

export async function unlinkExternalApprovedPayment(input: {
  reservationId: string;
  transactionId: string;
  reason: unknown;
  requestedBy: string;
}) {
  await ensurePaymentSchema();
  const reason = normalizeManualPaymentReason(input.reason);
  const context = await paymentContext(input.reservationId);
  const row = context.rows.find((candidate) => candidate.id === input.transactionId);
  if (
    !row || row.attempt_type !== "PAY" || row.transaction_source !== "TERMINAL_DIRECT" ||
    !["APPROVED", "COMPLETED"].includes(row.status) ||
    context.ledger.cancelledOriginals.has(row.id)
  ) {
    throw new Error("PAYMENT_EXTERNAL_UNLINK_NOT_ALLOWED");
  }
  const details = JSON.stringify({
    paymentId: row.payment_id,
    attemptId: row.id,
    amount: row.amount,
    authNo: row.auth_no,
    authDate: row.auth_date.slice(0, 8),
    reason,
    cardApprovalStillActive: true,
  });
  const db = getD1();
  await db.batch([
    db.prepare(`UPDATE payment_attempts SET status = 'UNLINKED',
        response_code = 'MANUAL_UNLINKED',
        response_message = '예약 연결만 해제됨 · 카드 승인은 유지',
        error_code = 'NONE', external_transaction_key = NULL, operator_note = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND transaction_source = 'TERMINAL_DIRECT'
        AND status IN ('APPROVED', 'COMPLETED')`)
      .bind(reason, row.id),
    db.prepare(`INSERT INTO reservation_events
        (id, reservation_id, event_type, details_json, created_by)
      VALUES (?, ?, 'terminal_direct_payment_unlinked', ?, ?)`)
      .bind(crypto.randomUUID(), input.reservationId, details, input.requestedBy),
  ]);
  await syncReservationPaymentSummary(context.reservation.id);
  return getPaymentOverview(input.reservationId);
}

async function paymentGroupOverview(
  reservationId: string,
  context: Awaited<ReturnType<typeof paymentContext>>,
  trace?: PaymentDbTrace,
) {
  const allocationMap = new Map(context.allocations.map((item) => [item.reservation_id, item]));
  const rows = context.allocations.length > 1
    ? (await Promise.all(context.allocations.map((item, index) => reservationForPayment(
        item.reservation_id,
        trace,
        `group_overview_reservation_${index + 1}`,
      ))))
        .filter((item): item is ReservationPaymentRow => Boolean(item))
    : await repeatGroupReservations(reservationId, trace, context.requestedReservation);
  if (rows.length < 2) return null;
  const ordered = rows.sort((left, right) => left.repeat_sequence - right.repeat_sequence || left.scheduled_time.localeCompare(right.scheduled_time));
  const items = ordered.map((row, index) => {
    const allocation = allocationMap.get(row.id);
    const finalAmount = allocation?.final_amount ?? Math.max(0, row.base_amount + row.add_on_amount - row.discount_amount);
    const depositAmount = allocation?.deposit_amount ?? (row.source === "naver"
      ? Math.min(context.pricing.naverDepositAmount, finalAmount)
      : 0);
    return {
      reservationId: row.id,
      bookingCode: row.booking_code,
      teamName: row.team_name,
      scheduledDate: row.scheduled_date,
      scheduledTime: row.scheduled_time,
      roomCode: row.room_code,
      adultCount: row.adult_count,
      youthCount: row.youth_count,
      totalCount: row.total_count,
      status: row.status,
      paymentStatus: row.payment_status,
      sequence: allocation?.sequence ?? (row.repeat_sequence || index + 1),
      finalAmount,
      depositAmount,
      payableAmount: allocation?.payable_amount ?? Math.max(0, finalAmount - depositAmount),
    };
  });
  const isPaymentGroup = context.allocations.length > 1;
  const eligible = isPaymentGroup || (
    !context.ledger.amountLocked &&
    items.every((item) => item.status !== "cancelled" && item.paymentStatus !== "paid")
  );
  return {
    id: ordered[0]?.repeat_group_id || `payment:${context.payment?.id ?? reservationId}`,
    isPaymentGroup,
    eligible,
    anchorReservationId: context.payment?.reservation_id ?? reservationId,
    totalFinalAmount: items.reduce((sum, item) => sum + item.finalAmount, 0),
    totalDepositAmount: items.reduce((sum, item) => sum + item.depositAmount, 0),
    totalPayableAmount: items.reduce((sum, item) => sum + item.payableAmount, 0),
    items,
  };
}

export async function getPaymentOverview(
  reservationId: string,
  trace?: PaymentDbTrace,
  loadedContext?: Awaited<ReturnType<typeof paymentContext>>,
  loadedTerminal?: TerminalRow | null,
) {
  await measurePaymentDb(trace, "overview_ensure_payment_schema", () => ensurePaymentSchema());
  const db = getD1();
  const [terminal, context] = await Promise.all([
    loadedTerminal !== undefined
      ? Promise.resolve(loadedTerminal)
      : measurePaymentDb(trace, "terminal_state", () => db
        .prepare(`SELECT * FROM payment_terminal_state WHERE id = 1 LIMIT 1`)
        .first<TerminalRow>()),
    reservationId
      ? loadedContext
        ? Promise.resolve(loadedContext)
        : paymentContext(reservationId, trace)
      : Promise.resolve(null),
  ]);
  const ledger = context?.ledger;
  const payment = context?.payment ?? null;
  const planRows = payment
    ? latestPayRowsBySplit(context?.rows ?? [], payment.split_count)
        .filter((row): row is PaymentAttemptRow => Boolean(row))
        .map(toPaymentAttempt)
    : [];
  const paymentStatusValue: PaymentWholeStatus = payment?.status ?? ledger?.paymentStatus ?? "PENDING";
  const group = context ? await paymentGroupOverview(reservationId, context, trace) : null;
  return {
    explicitExecutionV2Enabled: paymentExplicitExecutionV2Enabled(),
    terminal: terminalPayload(terminal),
    payment: toPayment(payment),
    summary: ledger
      ? {
          finalAmount: ledger.finalAmount,
          depositAmount: ledger.depositAmount,
          payableAmount: ledger.payableAmount,
          approvedAmount: ledger.approvedAmount,
          completedAmount: ledger.completedAmount,
          splitApprovedAmount: ledger.splitApprovedAmount,
          remainingAmount: ledger.remainingAmount,
          approvedByMethod: ledger.approvedByMethod,
          hasUnknown: ledger.hasUnknown,
          hasBusy: ledger.hasBusy,
          amountLocked: ledger.amountLocked,
          paymentStatus: paymentStatusValue,
          orderStatus: paymentStatusValue,
          currentSplitIndex:
            planRows.find((row) => !["APPROVED", "COMPLETED"].includes(row.status))
              ?.splitIndex ?? null,
        }
      : null,
    plan: planRows,
    attempts: context?.attempts ?? [],
    group,
    terminalImport: {
      automaticLookup: false,
      recentLookup: false,
      approvalNumberLookup: false,
      callback: false,
      manualRegistration: true,
      reason: "현재 FDK_Module_64bit.dll의 MPOS 신용 승인 업무에는 단말 직접 거래 조회 API가 확인되지 않았습니다.",
    },
  };
}

const PAYMENT_RESULT_WAIT_INTERVAL_MS = 200;
const PAYMENT_RESULT_WAIT_MAX_MS = 15_000;

type FullCancellationProgressRow = {
  full_cancel_requested: number;
  current_status: PaymentStatus | null;
  latest_cancel_id: string | null;
};

export async function waitForPaymentAttemptResult(input: {
  reservationId: string;
  attemptId: string;
  timeoutMs?: number;
  dbTrace?: PaymentDbTrace;
  minimal?: boolean;
}) {
  await measurePaymentDb(input.dbTrace, "ensure_payment_schema", () => ensurePaymentSchema());
  const timeoutMs = Math.max(
    1_000,
    Math.min(PAYMENT_RESULT_WAIT_MAX_MS, Math.trunc(input.timeoutMs ?? PAYMENT_RESULT_WAIT_MAX_MS)),
  );
  const deadline = performance.now() + timeoutMs;
  const db = getD1();
  let pollNumber = 0;
  while (true) {
    pollNumber += 1;
    const row = await measurePaymentFirst(input.dbTrace, "wait_result_status", () => db
      .prepare(`SELECT status, active_key FROM payment_attempts
        WHERE id = ? LIMIT 1`)
      .bind(input.attemptId)
      .all<{ status: PaymentStatus; active_key: string | null }>(), { pollNumber });
    if (!row) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
    if (!["PENDING", "PROCESSING"].includes(row.status)) {
      if (input.minimal) {
        const progress = await getMinimalNextSplitResult({
          attemptId: input.attemptId,
          dbTrace: input.dbTrace,
        });
        if (progress.finalizationRequired && !progress.finalizationReady) {
          if (performance.now() >= deadline) return { changed: false, overview: null, progress: null };
          await new Promise((resolve) => setTimeout(resolve, PAYMENT_RESULT_WAIT_INTERVAL_MS));
          continue;
        }
        return { changed: true, overview: null, progress };
      }
      return {
        changed: true,
        overview: await getPaymentOverview(input.reservationId, input.dbTrace),
      };
    }
    if (performance.now() >= deadline) return { changed: false, overview: null };
    await new Promise((resolve) => setTimeout(resolve, PAYMENT_RESULT_WAIT_INTERVAL_MS));
  }
}

export async function waitForFullCancellationProgress(input: {
  reservationId: string;
  afterAttemptId: string;
  timeoutMs?: number;
  dbTrace?: PaymentDbTrace;
}) {
  await measurePaymentDb(input.dbTrace, "ensure_payment_schema", () => ensurePaymentSchema());
  const timeoutMs = Math.max(
    1_000,
    Math.min(PAYMENT_RESULT_WAIT_MAX_MS, Math.trunc(input.timeoutMs ?? PAYMENT_RESULT_WAIT_MAX_MS)),
  );
  const deadline = performance.now() + timeoutMs;
  const db = getD1();
  let pollNumber = 0;
  while (true) {
    pollNumber += 1;
    const row = await measurePaymentFirst(input.dbTrace, "wait_full_cancel_progress", () => db
      .prepare(`WITH allocated AS (
          SELECT payment_id FROM payment_allocations WHERE reservation_id = ?
          ORDER BY updated_at DESC LIMIT 1
        ), target AS (
          SELECT id, full_cancel_requested FROM payments
          WHERE id = (SELECT payment_id FROM allocated) OR reservation_id = ?
          ORDER BY CASE WHEN id = (SELECT payment_id FROM allocated) THEN 0 ELSE 1 END
          LIMIT 1
        )
        SELECT target.full_cancel_requested,
          current_attempt.status AS current_status,
          (SELECT id FROM payment_attempts
            WHERE payment_id = target.id AND attempt_type = 'CANCEL'
            ORDER BY requested_at DESC, attempt_number DESC LIMIT 1) AS latest_cancel_id
        FROM target
        LEFT JOIN payment_attempts current_attempt ON current_attempt.id = ?
        LIMIT 1`)
      .bind(input.reservationId, input.reservationId, input.afterAttemptId)
      .all<FullCancellationProgressRow>(), { pollNumber });
    if (!row) throw new Error("PAYMENT_PLAN_NOT_FOUND");
    const currentFinishedWithError = Boolean(
      row.current_status && !["PENDING", "PROCESSING", "CANCELLED"].includes(row.current_status),
    );
    const nextAttemptQueued = Boolean(
      row.latest_cancel_id && row.latest_cancel_id !== input.afterAttemptId,
    );
    if (!row.full_cancel_requested || currentFinishedWithError || nextAttemptQueued) {
      return {
        changed: true,
        overview: await getPaymentOverview(input.reservationId, input.dbTrace),
      };
    }
    if (performance.now() >= deadline) return { changed: false, overview: null };
    await new Promise((resolve) => setTimeout(resolve, PAYMENT_RESULT_WAIT_INTERVAL_MS));
  }
}

export async function getPaymentTerminalState() {
  await ensurePaymentSchema();
  const terminal = await getD1()
    .prepare(`SELECT * FROM payment_terminal_state WHERE id = 1 LIMIT 1`)
    .first<TerminalRow>();
  return terminalPayload(terminal);
}

type PaymentHistoryRow = {
  payment_id: string;
  reservation_id: string;
  payment_type: string;
  payment_status: string;
  final_amount: number;
  deposit_amount: number;
  payable_amount: number;
  payment_created_at: string;
  payment_updated_at: string;
  source: string;
  booking_code: string;
  team_name: string;
  customer_name: string;
  member_name: string | null;
  product_name: string | null;
  item_summary: string | null;
  attempt_id: string | null;
  attempt_type: string | null;
  attempt_status: string | null;
  payment_method: string | null;
  attempt_amount: number | null;
  auth_no: string | null;
  auth_date: string | null;
  approval_time: string | null;
  transaction_source: string | null;
  verification_status: string | null;
  original_attempt_id: string | null;
  requested_at: string | null;
  completed_at: string | null;
};

export type PaymentHistoryItem = {
  paymentId: string;
  reservationId: string;
  paymentType: string;
  source: string;
  title: string;
  customerName: string;
  bookingCode: string;
  status: string;
  finalAmount: number;
  depositAmount: number;
  paidAmount: number;
  cardAmount: number;
  cashAmount: number;
  accountAmount: number;
  couponAmount: number;
  terminalDirectAmount: number;
  authNo: string;
  authDate: string;
  approvalTime: string;
  createdAt: string;
  paidAt: string;
  canCancel: boolean;
  canDelete: boolean;
  attempts: Array<{
    id: string;
    attemptType: string;
    status: string;
    paymentMethod: string;
    amount: number;
    authNo: string;
    authDate: string;
    approvalTime: string;
    transactionSource: string;
    verificationStatus: string;
    originalAttemptId: string;
    completedAt: string;
  }>;
};

export async function listPaymentHistory(input: {
  date: string;
  query?: string;
}) {
  await Promise.all([
    ensurePaymentSchema(),
    ensureMemberBenefitSchema(),
    ensureAddOnSaleSchema(),
  ]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error("PAYMENT_HISTORY_DATE_INVALID");
  }
  const result = await getD1().prepare(`
    SELECT
      p.id AS payment_id, p.reservation_id, p.payment_type,
      p.status AS payment_status, p.final_amount, p.deposit_amount,
      p.payable_amount, p.created_at AS payment_created_at,
      p.updated_at AS payment_updated_at,
      r.source, r.booking_code, r.team_name, r.customer_name,
      m.name AS member_name, po.product_name, ao.item_summary,
      pa.id AS attempt_id, pa.attempt_type, pa.status AS attempt_status,
      pa.payment_method, pa.amount AS attempt_amount, pa.auth_no, pa.auth_date,
      pa.approval_time, pa.transaction_source, pa.verification_status,
      pa.original_attempt_id, pa.requested_at, pa.completed_at
    FROM payments p
    JOIN reservations r ON r.id = p.reservation_id
    LEFT JOIN members m ON m.id = COALESCE(p.member_id, r.member_id)
    LEFT JOIN pass_purchase_orders po ON po.reservation_id = p.reservation_id
    LEFT JOIN add_on_sale_orders ao ON ao.reservation_id = p.reservation_id
    LEFT JOIN payment_attempts pa ON pa.payment_id = p.id
    WHERE date(p.created_at, '+9 hours') = ?
      AND EXISTS (
        SELECT 1 FROM payment_attempts seen
        WHERE seen.payment_id = p.id
          AND (
            seen.status IN ('APPROVED','COMPLETED','CANCELLED','UNKNOWN')
            OR seen.attempt_type = 'CANCEL'
          )
      )
    ORDER BY p.created_at DESC, pa.attempt_number, pa.requested_at
  `).bind(input.date).all<PaymentHistoryRow>();

  const grouped = new Map<string, PaymentHistoryItem>();
  for (const row of result.results) {
    let item = grouped.get(row.payment_id);
    if (!item) {
      const title = row.payment_type === "PASS_PURCHASE"
        ? row.product_name || row.team_name || "다회권 구매"
        : row.payment_type === "ADD_ON_SALE"
          ? row.item_summary || row.team_name || "부가매출"
          : row.team_name || row.customer_name || "예약 결제";
      item = {
        paymentId: row.payment_id,
        reservationId: row.reservation_id,
        paymentType: row.payment_type,
        source: row.source,
        title,
        customerName: row.member_name || row.customer_name || "",
        bookingCode: row.booking_code,
        status: row.payment_status,
        finalAmount: Number(row.final_amount) || 0,
        depositAmount: Number(row.deposit_amount) || 0,
        paidAmount: 0,
        cardAmount: 0,
        cashAmount: 0,
        accountAmount: 0,
        couponAmount: 0,
        terminalDirectAmount: 0,
        authNo: "",
        authDate: "",
        approvalTime: "",
        createdAt: row.payment_created_at,
        paidAt: "",
        canCancel: false,
        canDelete: false,
        attempts: [],
      };
      grouped.set(row.payment_id, item);
    }
    if (row.attempt_id) {
      item.attempts.push({
        id: row.attempt_id,
        attemptType: row.attempt_type ?? "",
        status: row.attempt_status ?? "",
        paymentMethod: normalizePaymentMethod(row.payment_method),
        amount: Number(row.attempt_amount) || 0,
        authNo: row.auth_no ?? "",
        authDate: row.auth_date ?? "",
        approvalTime: row.approval_time ?? "",
        transactionSource: row.transaction_source ?? "POS_BRIDGE",
        verificationStatus: row.verification_status ?? "VERIFIED",
        originalAttemptId: row.original_attempt_id ?? "",
        completedAt: row.completed_at ?? "",
      });
    }
  }

  const query = String(input.query ?? "").trim().toLocaleLowerCase("ko-KR");
  return Array.from(grouped.values()).map((item) => {
    const cancelledOriginals = new Set(
      item.attempts
        .filter((attempt) => attempt.attemptType === "CANCEL" && attempt.status === "CANCELLED")
        .map((attempt) => attempt.originalAttemptId)
        .filter(Boolean),
    );
    const activePayments = item.attempts.filter((attempt) =>
      attempt.attemptType === "PAY" &&
      ["APPROVED", "COMPLETED"].includes(attempt.status) &&
      !cancelledOriginals.has(attempt.id),
    );
    for (const attempt of activePayments) {
      item.paidAmount += attempt.amount;
      if (attempt.paymentMethod === "card") item.cardAmount += attempt.amount;
      else if (attempt.paymentMethod === "cash") item.cashAmount += attempt.amount;
      else if (attempt.paymentMethod === "account") item.accountAmount += attempt.amount;
      else item.couponAmount += attempt.amount;
      if (attempt.authNo) item.authNo = attempt.authNo;
      if (attempt.authDate) item.authDate = attempt.authDate;
      if (attempt.approvalTime) item.approvalTime = attempt.approvalTime;
      if (attempt.transactionSource === "TERMINAL_DIRECT") {
        item.terminalDirectAmount += attempt.amount;
      }
      if (attempt.completedAt > item.paidAt) item.paidAt = attempt.completedAt;
    }
    const hasBlockingAttempt = item.attempts.some((attempt) =>
      ["PROCESSING", "PENDING", "BUSY", "UNKNOWN"].includes(attempt.status),
    );
    const hasTerminalDirect = activePayments.some(
      (attempt) => attempt.transactionSource === "TERMINAL_DIRECT",
    );
    item.canCancel = activePayments.length > 0 && !hasBlockingAttempt && !hasTerminalDirect;
    item.canDelete = activePayments.length === 0 && item.status === "CANCELLED" && !hasBlockingAttempt;
    return item;
  }).filter((item) => !query || [
    item.title,
    item.customerName,
    item.bookingCode,
    item.authNo,
  ].some((value) => value.toLocaleLowerCase("ko-KR").includes(query)));
}

export async function deleteCancelledPaymentRecord(input: {
  reservationId: string;
  requestedBy: string;
}) {
  await Promise.all([
    ensurePaymentSchema(),
    ensureMemberBenefitSchema(),
    ensureAddOnSaleSchema(),
  ]);
  const context = await paymentContext(input.reservationId);
  if (!context.payment) throw new Error("PAYMENT_PLAN_NOT_FOUND");
  const paymentId = context.payment.id;
  if (context.ledger.hasUnknown || context.ledger.hasBusy) {
    throw new Error("PAYMENT_DELETE_BLOCKED");
  }
  if (context.ledger.completedPayments.length > 0 || context.payment.status !== "CANCELLED") {
    throw new Error("PAYMENT_DELETE_REQUIRES_CANCELLATION");
  }

  const db = getD1();
  const allocationReservationIds = context.allocations.map((item) => item.reservation_id);
  const affectedReservationIds = allocationReservationIds.length > 1
    ? allocationReservationIds
    : [input.reservationId];
  const synthetic = ["member_pass_purchase", "add_on_sale_purchase"].includes(
    context.reservation.source,
  );
  if (context.reservation.source === "member_pass_purchase") {
    const order = await db.prepare(`
      SELECT id, member_pass_id FROM pass_purchase_orders
      WHERE reservation_id = ? LIMIT 1
    `).bind(input.reservationId).first<{ id: string; member_pass_id: string | null }>();
    if (order?.member_pass_id) {
      const activeUse = await db.prepare(`
        SELECT u.id FROM pass_ledger u
        WHERE u.member_pass_id = ? AND u.type = 'USE'
          AND NOT EXISTS (
            SELECT 1 FROM pass_ledger restored
            WHERE restored.type = 'RESTORE' AND restored.reference_id = u.id
          )
        LIMIT 1
      `).bind(order.member_pass_id).first();
      if (activeUse) throw new Error("PASS_PURCHASE_PARTIALLY_USED");
      await db.prepare(`DELETE FROM pass_ledger WHERE member_pass_id = ?`).bind(order.member_pass_id).run();
      await db.prepare(`DELETE FROM member_passes WHERE id = ?`).bind(order.member_pass_id).run();
    }
    await db.prepare(`DELETE FROM pass_purchase_orders WHERE reservation_id = ?`).bind(input.reservationId).run();
  }
  if (context.reservation.source === "add_on_sale_purchase") {
    await deleteAddOnSaleOrder(input.reservationId);
  }

  await db.batch([
    db.prepare(`DELETE FROM payment_attempts WHERE payment_id = ?`).bind(paymentId),
    db.prepare(`DELETE FROM payment_allocations WHERE payment_id = ?`).bind(paymentId),
    db.prepare(`DELETE FROM payments WHERE id = ?`).bind(paymentId),
    ...(synthetic
      ? [
          db.prepare(`DELETE FROM reservation_events WHERE reservation_id = ?`).bind(input.reservationId),
          db.prepare(`DELETE FROM reservations WHERE id = ?`).bind(input.reservationId),
        ]
      : affectedReservationIds.map((reservationId) =>
          db.prepare(`
            UPDATE reservations SET payment_card_amount = 0,
              payment_cash_amount = 0, payment_account_amount = 0,
              payment_method = '', payment_status = 'unpaid',
              payment_amount = MAX(0, base_amount + add_on_amount - discount_amount),
              memo = CASE WHEN trim(memo) = '' THEN '' ELSE memo END,
              updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).bind(reservationId),
        )),
    ...affectedReservationIds.map((reservationId) =>
      db.prepare(`
        INSERT INTO reservation_events
          (id, reservation_id, event_type, details_json, created_by)
        SELECT ?, ?, 'payment_history_deleted', ?, ?
        WHERE EXISTS (SELECT 1 FROM reservations WHERE id = ?)
      `).bind(
        crypto.randomUUID(),
        reservationId,
        JSON.stringify({ paymentId }),
        input.requestedBy,
        reservationId,
      )),
  ]);
  return { deleted: true, reservationDeleted: synthetic };
}

export async function recordTerminalStatus(input: Record<string, unknown>) {
  await ensurePaymentSchema();
  const connected = input.success === true ? 1 : 0;
  const paymentReady = connected && input.payment_ready === true ? 1 : 0;
  await getD1()
    .prepare(`
      INSERT INTO payment_terminal_state
        (id, connected, payment_ready, response_code, response_message, model,
         firmware, integrity, raw_return_code, error_code, elapsed_ms, checked_at,
         updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        connected = excluded.connected,
        payment_ready = excluded.payment_ready,
        response_code = excluded.response_code,
        response_message = excluded.response_message,
        model = excluded.model,
        firmware = excluded.firmware,
        integrity = excluded.integrity,
        raw_return_code = excluded.raw_return_code,
        error_code = excluded.error_code,
        elapsed_ms = excluded.elapsed_ms,
        checked_at = excluded.checked_at,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(
      connected,
      paymentReady,
      safeText(input.response_code, 40),
      safeText(input.response_message, 500),
      safeText(input.model, 80),
      safeText(input.firmware, 80),
      safeText(input.integrity, 40),
      input.raw_return_code == null
        ? null
        : safeInteger(input.raw_return_code, -999_999, 999_999),
      safeText(input.error_code, 80) || (connected ? "NONE" : "DEVICE_OFFLINE"),
      safeInteger(input.elapsed_ms, 0, 300_000),
      safeText(input.checked_at, 80) || new Date().toISOString(),
    )
    .run();
}

export async function completePaymentCommand(
  commandId: string,
  commandStatus: "completed" | "failed",
  rawResult: string,
  trace?: PaymentDbTrace,
  options?: { deferDerived?: boolean },
) {
  await measurePaymentDb(trace, "ack_ensure_payment_schema", () => ensurePaymentSchema());
  const db = getD1();
  const coreSnapshot = await measurePaymentDb(trace, "ack_core_guard_batch", () => db.batch([
    db.prepare(`SELECT action FROM commands WHERE id = ? LIMIT 1`).bind(commandId),
    db.prepare(`${ATTEMPT_SELECT} WHERE command_id = ? LIMIT 1`).bind(commandId),
    db.prepare(`${PAYMENT_SELECT} WHERE id = (
        SELECT payment_id FROM payment_attempts WHERE command_id = ? LIMIT 1
      ) LIMIT 1`).bind(commandId),
    db.prepare(`${ATTEMPT_SELECT} WHERE payment_id = (
        SELECT payment_id FROM payment_attempts WHERE command_id = ? LIMIT 1
      ) ORDER BY attempt_number DESC, requested_at DESC`).bind(commandId),
    db.prepare(`${PAYMENT_ALLOCATION_SELECT} WHERE payment_id = (
        SELECT payment_id FROM payment_attempts WHERE command_id = ? LIMIT 1
      ) ORDER BY sequence, reservation_id`).bind(commandId),
  ]), { statementCount: 5, snapshot: "authoritative" });
  const command = (coreSnapshot[0]?.results?.[0] ?? null) as { action: string } | null;
  if (!command?.action.startsWith("payment_")) return;

  let parsed: Record<string, unknown> = {};
  try {
    const candidate = JSON.parse(rawResult) as unknown;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  if (command.action === "payment_status" || parsed.kind === "terminal_status") {
    await recordTerminalStatus(
      Object.keys(parsed).length
        ? parsed
        : {
            success: false,
            response_message: safeText(rawResult, 500) || "단말 상태 확인 실패",
            error_code: "PROTOCOL_ERROR",
          },
    );
    return;
  }

  const attempt = (coreSnapshot[1]?.results?.[0] ?? null) as PaymentAttemptRow | null;
  if (!attempt) return;
  const parsedError = safeText(parsed.error_code, 80) || "UNKNOWN";
  let status: PaymentStatus =
    commandStatus === "failed" && !Object.keys(parsed).length
      ? "UNKNOWN"
      : paymentStatus(parsed.status);
  if (parsedError === "USER_CANCELLED") status = "USER_CANCELLED";
  if (attempt.attempt_type === "PAY" && status === "CANCELLED") status = "USER_CANCELLED";
  const clearActive = [
    "APPROVED",
    "COMPLETED",
    "DECLINED",
    "USER_CANCELLED",
    "CANCELLED",
    "BUSY",
    "ERROR",
  ].includes(status);
  if (!attempt.payment_id) throw new Error("PAYMENT_PLAN_NOT_FOUND");
  const payment = (coreSnapshot[2]?.results?.[0] ?? null) as PaymentRow | null;
  const paymentAttemptRows = (coreSnapshot[3]?.results ?? []) as PaymentAttemptRow[];
  const allocations = (coreSnapshot[4]?.results ?? []) as PaymentAllocationRow[];
  if (!payment) throw new Error("PAYMENT_PLAN_NOT_FOUND");

  const projectedRows = paymentAttemptRows.map((row) => row.id === attempt.id
    ? {
        ...row,
        status,
        active_key: clearActive ? null : row.active_key,
      }
    : row);
  const projectedAttempts = projectedRows.map(toPaymentAttempt);
  const projectedLedger = calculatePaymentLedger({
    finalAmount: payment.final_amount,
    depositAmount: payment.deposit_amount,
    attempts: projectedAttempts,
  });
  const failedFullCancel = Boolean(
    payment.full_cancel_requested &&
    projectedAttempts.some((item) =>
      item.attemptType === "CANCEL" &&
      ["DECLINED", "USER_CANCELLED", "ERROR"].includes(item.status)),
  );
  const wholeStatus: PaymentWholeStatus =
    failedFullCancel && projectedLedger.paymentStatus === "PAID"
      ? "PARTIALLY_CANCELLED"
      : projectedLedger.paymentStatus;
  const activeMethods = ["card", "cash", "account", "coupon"].filter(
    (method) => (projectedLedger.completedByMethod[method as PaymentMethod] ?? 0) > 0,
  );
  const paymentMethod = activeMethods.length > 1 ? "mixed" : activeMethods[0] ?? "";
  const durableStatements = [db.prepare(`
      UPDATE payment_attempts SET
        status = ?, response_code = ?, response_message = ?, auth_no = ?,
        auth_date = ?, issuer_name = ?, acquirer_name = ?, masked_card_no = ?,
        raw_return_code = ?, error_code = ?, elapsed_ms = ?,
        mpos_transaction_id = ?, active_key = CASE WHEN ? THEN NULL ELSE active_key END,
        completed_at = CASE WHEN ? IN ('PROCESSING', 'PENDING', 'BUSY')
          THEN completed_at ELSE CURRENT_TIMESTAMP END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(
      status,
      safeText(parsed.response_code, 40),
      safeText(parsed.response_message, 500) || safeText(rawResult, 500),
      safeText(parsed.auth_no, 40),
      safeText(parsed.auth_date, 20),
      safeText(parsed.issuer_name, 100),
      safeText(parsed.acquirer_name, 100),
      safeText(parsed.masked_card_no, 80),
      parsed.raw_return_code == null
        ? null
        : safeInteger(parsed.raw_return_code, -999_999, 999_999),
      parsedError,
      safeInteger(parsed.elapsed_ms, 0, 300_000),
      parsed.mpos_transaction_id == null
        ? null
        : safeInteger(parsed.mpos_transaction_id, 1, 2_147_483_647),
      clearActive ? 1 : 0,
      status,
      attempt.id,
    )];
  if (allocations.length > 1) {
    const completedRows = projectedRows
      .filter((row) =>
        row.attempt_type === "PAY" &&
        ["APPROVED", "COMPLETED"].includes(row.status) &&
        !projectedLedger.cancelledOriginals.has(row.id))
      .sort((left, right) =>
        left.split_index - right.split_index || left.attempt_number - right.attempt_number)
      .map((row) => ({
        method: normalizePaymentMethod(row.payment_method),
        amount: Math.max(0, Number(row.amount) || 0),
      }));
    const reservationSummaries = allocateGroupPaymentMethods({
      allocations: allocations.map((allocation) => ({
        reservationId: allocation.reservation_id,
        finalAmount: allocation.final_amount,
        payableAmount: allocation.payable_amount,
      })),
      completedPayments: completedRows,
      wholeStatus,
    });
    durableStatements.push(...reservationSummaries.map((summary) => db.prepare(`
        UPDATE reservations SET payment_amount = ?, payment_card_amount = ?,
          payment_cash_amount = ?, payment_account_amount = ?, payment_method = ?,
          payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(
        summary.finalAmount,
        summary.cardAmount,
        summary.cashAmount,
        summary.accountAmount,
        summary.paymentMethod,
        summary.paymentStatus,
        summary.reservationId,
      )));
  } else {
    durableStatements.push(db.prepare(`
        UPDATE reservations SET payment_amount = ?, payment_card_amount = ?,
          payment_cash_amount = ?, payment_account_amount = ?, payment_method = ?,
          payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(
        projectedLedger.finalAmount,
        projectedLedger.completedByMethod.card,
        projectedLedger.completedByMethod.cash,
        projectedLedger.completedByMethod.account,
        paymentMethod,
        wholeStatus.toLowerCase(),
        attempt.reservation_id,
      ));
  }
  durableStatements.push(db.prepare(`
      UPDATE payments SET final_amount = ?, deposit_amount = ?, payable_amount = ?,
        status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(
      projectedLedger.finalAmount,
      projectedLedger.depositAmount,
      projectedLedger.payableAmount,
      wholeStatus,
      payment.id,
    ));
  await measurePaymentDb(trace, "ack_financial_durable_batch", () => db.batch(durableStatements), {
    statementCount: durableStatements.length,
  });

  if (options?.deferDerived) return;

  await completePaymentCommandDerived(commandId, trace);
}

export async function completePaymentCommandDerived(
  commandId: string,
  trace?: PaymentDbTrace,
) {
  await measurePaymentDb(trace, "ack_derived_ensure_payment_schema", () => ensurePaymentSchema());
  const db = getD1();
  const attempt = await measurePaymentFirst(trace, "ack_derived_attempt_lookup", () => db
    .prepare(`${ATTEMPT_SELECT} WHERE command_id = ? LIMIT 1`)
    .bind(commandId)
    .all<PaymentAttemptRow>());
  if (!attempt) return;

  // The attempt, payment and reservation ledger are already durable above.
  // This existing reconciliation path now handles derived sale/pass projections
  // and remains retryable when the bridge repeats an ACK after a transient error.
  await syncReservationPaymentSummary(attempt.reservation_id, trace);
  if (attempt.attempt_type === "CANCEL" && attempt.status === "CANCELLED") {
    const payment = await paymentRow(attempt.reservation_id, trace);
    if (payment?.full_cancel_requested) {
      await advanceFullCancellation(
        attempt.reservation_id,
        "full-cancel-resume",
        `resume:${payment.id}:${attempt.id}`,
      );
    }
  }
}
