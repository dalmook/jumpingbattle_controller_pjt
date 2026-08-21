import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
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
} from "../db/payment-reconciliation.ts";

test("manual reconciliation accepts only valid approval identifiers", () => {
  assert.equal(normalizeAuthorizationNumber("30182638"), "30182638");
  assert.equal(normalizeAuthorizationDate("2026-08-10"), "20260810");
  assert.equal(normalizeAuthorizationDate("20260810171100"), "20260810171100");
  assert.throws(
    () => normalizeAuthorizationNumber("3018 2638"),
    /PAYMENT_RECONCILIATION_AUTH_NO_INVALID/,
  );
  assert.throws(
    () => normalizeAuthorizationDate("2026-08"),
    /PAYMENT_RECONCILIATION_AUTH_DATE_INVALID/,
  );
});

test("external terminal approval must exactly match the outstanding amount", () => {
  assert.equal(matchExternalApprovalAmount(14_000, 14_000), 14_000);
  assert.throws(
    () => matchExternalApprovalAmount(13_000, 14_000),
    /PAYMENT_EXTERNAL_IMPORT_AMOUNT_MISMATCH/,
  );
  assert.throws(
    () => matchExternalApprovalAmount(0, 14_000),
    /PAYMENT_EXTERNAL_IMPORT_AMOUNT_INVALID/,
  );
});

test("terminal-direct metadata is normalized without storing raw card data", () => {
  assert.equal(normalizeApprovalTime("20:17"), "201700");
  assert.equal(normalizeApprovalTime("20:17:31"), "201731");
  assert.equal(normalizeTerminalId(""), "MPOS-1700AE");
  assert.equal(normalizeMaskedCardLast4("1234"), "****1234");
  assert.equal(normalizeManualPaymentReason("단말 직접 결제"), "단말 직접 결제");
  assert.throws(() => normalizeApprovalTime("25:00"), /PAYMENT_EXTERNAL_IMPORT_TIME_INVALID/);
  assert.throws(() => normalizeMaskedCardLast4("12345"), /PAYMENT_EXTERNAL_IMPORT_CARD_LAST4_INVALID/);
  assert.throws(() => normalizeManualPaymentReason("x"), /PAYMENT_EXTERNAL_IMPORT_REASON_REQUIRED/);
});

test("terminal-direct duplicate key includes terminal, approval, date and amount", () => {
  assert.equal(externalTerminalTransactionKey({
    approvalNo: "00104911",
    approvalDate: "20260810123000",
    amount: 17_000,
    terminalId: "MPOS-1700AE",
  }), "TERMINAL_DIRECT:MPOS-1700AE:20260810:00104911:17000");
});

test("a terminal-direct top-up is allowed only for an exact authoritative amount increase", () => {
  const valid = {
    requestedAmount: 5_000,
    remainingAmount: 5_000,
    storedPayableAmount: 14_000,
    authoritativePayableAmount: 19_000,
    paymentStatus: "PAID",
    splitCount: 1,
    plannedSplitCount: 1,
    allPlannedSplitsSuccessful: true,
    hasCancelledPayments: false,
    hasGroupAllocations: false,
  };
  assert.equal(canAppendExternalApprovalTopUp(valid), true);
  assert.equal(canAppendExternalApprovalTopUp({ ...valid, requestedAmount: 4_000 }), false);
  assert.equal(canAppendExternalApprovalTopUp({ ...valid, storedPayableAmount: 19_000 }), false);
  assert.equal(canAppendExternalApprovalTopUp({ ...valid, allPlannedSplitsSuccessful: false }), false);
  assert.equal(canAppendExternalApprovalTopUp({ ...valid, hasCancelledPayments: true }), false);
  assert.equal(canAppendExternalApprovalTopUp({ ...valid, hasGroupAllocations: true }), false);
  assert.equal(externalApprovalTopUpRequestKey({
    paymentId: "payment-1",
    authoritativePayableAmount: 19_000,
    splitIndex: 2,
  }), "external-topup:payment-1:19000:2");
});

test("terminal-direct top-up SQL appends one split and advances the authoritative totals", async () => {
  const source = await readFile(new URL("../db/payments.ts", import.meta.url), "utf8");
  const branchStart = source.indexOf('adjustment: "AUTHORITATIVE_AMOUNT_INCREASE"');
  const segment = source.slice(branchStart, source.indexOf("} else if (normalizePaymentMethod", branchStart));
  const sqlFor = (marker) => {
    const start = segment.indexOf(`db.prepare(\`${marker}`);
    assert.ok(start >= 0, `missing SQL marker: ${marker}`);
    const sqlStart = start + "db.prepare(`".length;
    const end = segment.indexOf("`)", sqlStart);
    assert.ok(end > sqlStart);
    return segment.slice(sqlStart, end);
  };
  const insertSql = sqlFor("INSERT INTO payment_attempts (");
  const updateSql = sqlFor("UPDATE payments SET mode = 'custom'");
  const eventSql = sqlFor("INSERT INTO reservation_events");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE payments (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, split_count INTEGER NOT NULL,
      final_amount INTEGER NOT NULL, deposit_amount INTEGER NOT NULL,
      payable_amount INTEGER NOT NULL, status TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE payment_attempts (
      id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL, payment_id TEXT,
      split_index INTEGER NOT NULL, attempt_type TEXT NOT NULL,
      attempt_number INTEGER NOT NULL, amount INTEGER NOT NULL,
      sale_amount INTEGER NOT NULL DEFAULT 0, add_on_amount INTEGER NOT NULL DEFAULT 0,
      discount_amount INTEGER NOT NULL DEFAULT 0, payment_method TEXT NOT NULL,
      status TEXT NOT NULL, response_code TEXT NOT NULL DEFAULT '',
      response_message TEXT NOT NULL DEFAULT '', auth_no TEXT NOT NULL DEFAULT '',
      auth_date TEXT NOT NULL DEFAULT '', issuer_name TEXT NOT NULL DEFAULT '',
      masked_card_no TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT 'NONE',
      request_key TEXT, transaction_source TEXT NOT NULL DEFAULT 'POS_BRIDGE',
      verification_status TEXT NOT NULL DEFAULT 'VERIFIED',
      approval_time TEXT NOT NULL DEFAULT '', terminal_id TEXT NOT NULL DEFAULT '',
      external_transaction_id TEXT NOT NULL DEFAULT '', external_transaction_key TEXT,
      operator_note TEXT NOT NULL DEFAULT '', requested_by TEXT NOT NULL,
      active_key TEXT, command_id TEXT, completed_at TEXT,
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX payment_attempts_request_key_uidx
      ON payment_attempts(request_key) WHERE request_key IS NOT NULL;
    CREATE UNIQUE INDEX payment_attempts_external_key_uidx
      ON payment_attempts(external_transaction_key) WHERE external_transaction_key IS NOT NULL;
    CREATE TABLE reservation_events (
      id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL, event_type TEXT NOT NULL,
      details_json TEXT NOT NULL, created_by TEXT NOT NULL
    );
    INSERT INTO payments VALUES
      ('payment-1', 'single', 1, 19000, 5000, 14000, 'PAID', CURRENT_TIMESTAMP);
    INSERT INTO payment_attempts (
      id, reservation_id, payment_id, split_index, attempt_type, attempt_number,
      amount, payment_method, status, requested_by, completed_at
    ) VALUES (
      'approved-1', 'reservation-1', 'payment-1', 1, 'PAY', 1,
      14000, 'card', 'APPROVED', 'operator', CURRENT_TIMESTAMP
    );
  `);
  const externalKey = "TERMINAL_DIRECT:MPOS-1700AE:20260817:04001810:5000";
  const insertResult = db.prepare(insertSql).run(
    "top-up-2", "reservation-1", 2, 2, 5000, 24000, 0, 0,
    "04001810", "20260817", "", "", "external-topup:payment-1:19000:2",
    "", "MPOS-1700AE", "", externalKey, "인원 정정 후 승인 연결", "operator",
    "payment-1", 1, 14000,
  );
  assert.equal(insertResult.changes, 1);
  assert.equal(db.prepare(updateSql).run(
    2, 24000, 5000, 19000, "payment-1", "top-up-2", "payment-1", externalKey,
  ).changes, 1);
  assert.equal(db.prepare(eventSql).run(
    "event-1", "reservation-1", "{}", "operator", "top-up-2", "payment-1", externalKey,
  ).changes, 1);

  assert.deepEqual(
    { ...db.prepare("SELECT mode, split_count, final_amount, deposit_amount, payable_amount, status FROM payments").get() },
    {
      mode: "custom",
      split_count: 2,
      final_amount: 24000,
      deposit_amount: 5000,
      payable_amount: 19000,
      status: "PAID",
    },
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payment_attempts").get().count, 2);
  assert.equal(db.prepare(insertSql).run(
    "duplicate-2", "reservation-1", 2, 2, 5000, 24000, 0, 0,
    "04001810", "20260817", "", "", "external-topup:payment-1:19000:2",
    "", "MPOS-1700AE", "", externalKey, "중복 요청", "operator",
    "payment-1", 1, 14000,
  ).changes, 0);
});

test("manual reconciliation is restricted to an UNKNOWN card PAY attempt", async () => {
  const source = await readFile(new URL("../db/payments.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function reconcileUnknownPayment");
  const end = source.indexOf("export async function getPaymentOverview", start);
  const segment = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(segment, /row\.attempt_type !== "PAY"/);
  assert.match(segment, /normalizePaymentMethod\(row\.payment_method\) !== "card"/);
  assert.match(segment, /row\.status !== "UNKNOWN"/);
  assert.match(segment, /AND payment_method = 'card' AND status = 'UNKNOWN'/);
  assert.match(segment, /active_key = NULL/);
});

test("external approval import is guarded and produces an auditable approved card attempt", async () => {
  const source = await readFile(new URL("../db/payments.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function recordExternalApprovedPayment");
  const end = source.indexOf("export async function getPaymentOverview", start);
  const segment = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(segment, /PAYMENT_EXTERNAL_IMPORT_PLAN_CONFLICT/);
  assert.match(segment, /PAYMENT_EXTERNAL_IMPORT_SPLIT_MISMATCH/);
  assert.match(segment, /PAYMENT_EXTERNAL_IMPORT_CONFLICT/);
  assert.match(segment, /PAYMENT_RECONCILIATION_DUPLICATE/);
  assert.match(segment, /transaction_source = 'TERMINAL_DIRECT'/);
  assert.match(segment, /verification_status = 'MANUAL'/);
  assert.match(segment, /external_transaction_key/);
  assert.match(segment, /terminal_direct_payment_linked/);
  assert.match(segment, /'MANUAL_EXTERNAL'/);
  assert.match(segment, /'card', 'APPROVED'/);
  assert.match(segment, /AUTHORITATIVE_AMOUNT_INCREASE/);
  assert.match(segment, /externalApprovalTopUpRequestKey/);
  assert.match(segment, /p\.status = 'PAID' AND p\.split_count = \?/);
  assert.match(segment, /active\.active_key IS NOT NULL/);
  assert.match(segment, /UPDATE payments SET mode = 'custom', split_count = \?/);
  assert.match(segment, /syncReservationPaymentSummary/);
});

test("terminal-direct unlink removes only the reservation link and keeps an audit event", async () => {
  const source = await readFile(new URL("../db/payments.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function unlinkExternalApprovedPayment");
  const end = source.indexOf("async function paymentGroupOverview", start);
  const segment = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(segment, /transaction_source !== "TERMINAL_DIRECT"/);
  assert.match(segment, /status = 'UNLINKED'/);
  assert.match(segment, /external_transaction_key = NULL/);
  assert.match(segment, /cardApprovalStillActive: true/);
  assert.match(segment, /terminal_direct_payment_unlinked/);
});
