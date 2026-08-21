import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  evaluatePaymentExecutionGuard,
  PAYMENT_GUARD_ATTEMPTS_SQL,
  PAYMENT_GUARD_PAYMENT_SQL,
  PAYMENT_INTENT_SCHEMA_CHECK_SQL,
  paymentIntentSchemaIsReady,
} from "../db/payment-wave-guards.ts";

function paymentDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL UNIQUE,
      split_count INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE payment_allocations (
      payment_id TEXT NOT NULL,
      reservation_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE payment_attempts (
      id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL,
      payment_id TEXT,
      split_index INTEGER NOT NULL,
      attempt_type TEXT NOT NULL DEFAULT 'PAY',
      attempt_number INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      status TEXT NOT NULL,
      command_id TEXT,
      active_key TEXT,
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function addPayment(db, input) {
  db.prepare(`INSERT INTO payments (id, reservation_id, split_count, status)
    VALUES (?, ?, ?, ?)`).run(input.id, input.reservationId, input.splitCount, input.status ?? "PENDING");
  for (const reservationId of input.allocations ?? []) {
    db.prepare(`INSERT INTO payment_allocations (payment_id, reservation_id)
      VALUES (?, ?)`).run(input.id, reservationId);
  }
  for (const attempt of input.attempts) {
    db.prepare(`INSERT INTO payment_attempts (
        id, reservation_id, payment_id, split_index, attempt_type, attempt_number,
        amount, payment_method, status, command_id, active_key, requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        attempt.id,
        input.reservationId,
        input.id,
        attempt.splitIndex,
        attempt.attemptType ?? "PAY",
        attempt.attemptNumber,
        attempt.amount,
        attempt.paymentMethod,
        attempt.status,
        attempt.commandId ?? null,
        attempt.activeKey ?? null,
        attempt.requestedAt ?? `2026-08-17 10:00:${String(attempt.attemptNumber).padStart(2, "0")}`,
      );
  }
}

function legacySnapshot(db, reservationId) {
  const payment = db.prepare(`WITH allocated AS (
      SELECT payment_id FROM payment_allocations WHERE reservation_id = ?
      ORDER BY updated_at DESC LIMIT 1
    )
    SELECT id, reservation_id, split_count, status FROM payments
    WHERE id = (SELECT payment_id FROM allocated) OR reservation_id = ?
    ORDER BY CASE WHEN id = (SELECT payment_id FROM allocated) THEN 0 ELSE 1 END
    LIMIT 1`).get(reservationId, reservationId) ?? null;
  const attempts = payment
    ? db.prepare(`SELECT id, reservation_id, payment_id, split_index, attempt_type,
        amount, payment_method, status, command_id, active_key
      FROM payment_attempts WHERE payment_id = ?
      ORDER BY attempt_number DESC, requested_at DESC`).all(payment.id)
    : [];
  return { payment, attempts };
}

function batchedSnapshot(db, reservationId) {
  db.exec("BEGIN");
  try {
    const payment = db.prepare(PAYMENT_GUARD_PAYMENT_SQL).get(reservationId, reservationId) ?? null;
    const attempts = db.prepare(PAYMENT_GUARD_ATTEMPTS_SQL).all(reservationId, reservationId);
    db.exec("COMMIT");
    return { payment, attempts };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const fixtures = [
  {
    name: "single card",
    reservationId: "r-single",
    payment: {
      id: "p-single", reservationId: "r-single", splitCount: 1,
      attempts: [
        { id: "a-single", splitIndex: 1, attemptNumber: 1, amount: 14_000, paymentMethod: "card", status: "PENDING" },
      ],
    },
    attemptId: "a-single",
    expected: { firstUnfinishedAttemptId: "a-single", hasUnknown: false, otherActiveAttemptId: null },
  },
  {
    name: "CARD CASH CARD with approved first split",
    reservationId: "r-mixed",
    payment: {
      id: "p-mixed", reservationId: "r-mixed", splitCount: 3,
      attempts: [
        { id: "a-mixed-1", splitIndex: 1, attemptNumber: 1, amount: 5_000, paymentMethod: "card", status: "APPROVED" },
        { id: "a-mixed-2", splitIndex: 2, attemptNumber: 2, amount: 5_000, paymentMethod: "cash", status: "PENDING" },
        { id: "a-mixed-3", splitIndex: 3, attemptNumber: 3, amount: 5_000, paymentMethod: "card", status: "PENDING" },
      ],
    },
    attemptId: "a-mixed-2",
    expected: { firstUnfinishedAttemptId: "a-mixed-2", hasUnknown: false, otherActiveAttemptId: null },
  },
  {
    name: "equal three-way card split",
    reservationId: "r-equal",
    payment: {
      id: "p-equal", reservationId: "r-equal", splitCount: 3,
      attempts: [
        { id: "a-equal-1", splitIndex: 1, attemptNumber: 1, amount: 4_667, paymentMethod: "card", status: "APPROVED" },
        { id: "a-equal-2", splitIndex: 2, attemptNumber: 2, amount: 4_667, paymentMethod: "card", status: "PENDING" },
        { id: "a-equal-3", splitIndex: 3, attemptNumber: 3, amount: 4_666, paymentMethod: "card", status: "PENDING" },
      ],
    },
    attemptId: "a-equal-2",
    expected: { firstUnfinishedAttemptId: "a-equal-2", hasUnknown: false, otherActiveAttemptId: null },
  },
  {
    name: "latest retry row wins",
    reservationId: "r-retry",
    payment: {
      id: "p-retry", reservationId: "r-retry", splitCount: 2,
      attempts: [
        { id: "a-retry-1", splitIndex: 1, attemptNumber: 1, amount: 7_000, paymentMethod: "card", status: "APPROVED" },
        { id: "a-retry-old", splitIndex: 2, attemptNumber: 2, amount: 7_000, paymentMethod: "card", status: "DECLINED" },
        { id: "a-retry-new", splitIndex: 2, attemptNumber: 3, amount: 7_000, paymentMethod: "cash", status: "PENDING" },
      ],
    },
    attemptId: "a-retry-new",
    expected: { firstUnfinishedAttemptId: "a-retry-new", hasUnknown: false, otherActiveAttemptId: null },
  },
  {
    name: "UNKNOWN blocks the snapshot",
    reservationId: "r-unknown",
    payment: {
      id: "p-unknown", reservationId: "r-unknown", splitCount: 2,
      attempts: [
        { id: "a-unknown-1", splitIndex: 1, attemptNumber: 1, amount: 7_000, paymentMethod: "card", status: "UNKNOWN" },
        { id: "a-unknown-2", splitIndex: 2, attemptNumber: 2, amount: 7_000, paymentMethod: "card", status: "PENDING" },
      ],
    },
    attemptId: "a-unknown-2",
    expected: { firstUnfinishedAttemptId: "a-unknown-1", hasUnknown: true, otherActiveAttemptId: null },
  },
  {
    name: "other active split reports BUSY",
    reservationId: "r-active",
    payment: {
      id: "p-active", reservationId: "r-active", splitCount: 2,
      attempts: [
        { id: "a-active-1", splitIndex: 1, attemptNumber: 1, amount: 7_000, paymentMethod: "card", status: "PROCESSING", activeKey: "MPOS:ACTIVE" },
        { id: "a-active-2", splitIndex: 2, attemptNumber: 2, amount: 7_000, paymentMethod: "card", status: "PENDING" },
      ],
    },
    attemptId: "a-active-2",
    expected: { firstUnfinishedAttemptId: "a-active-1", hasUnknown: false, otherActiveAttemptId: "a-active-1" },
  },
  {
    name: "grouped payment resolves from allocated reservation",
    reservationId: "r-group-2",
    payment: {
      id: "p-group", reservationId: "r-group-1", splitCount: 1,
      allocations: ["r-group-1", "r-group-2"],
      attempts: [
        { id: "a-group", splitIndex: 1, attemptNumber: 1, amount: 28_000, paymentMethod: "card", status: "PENDING" },
      ],
    },
    attemptId: "a-group",
    expected: { firstUnfinishedAttemptId: "a-group", hasUnknown: false, otherActiveAttemptId: null },
  },
  {
    name: "small add-on split remains pending",
    reservationId: "r-addon",
    payment: {
      id: "p-addon", reservationId: "r-addon", splitCount: 2,
      attempts: [
        { id: "a-addon-1", splitIndex: 1, attemptNumber: 1, amount: 750, paymentMethod: "card", status: "APPROVED" },
        { id: "a-addon-2", splitIndex: 2, attemptNumber: 2, amount: 750, paymentMethod: "card", status: "PENDING" },
      ],
    },
    attemptId: "a-addon-2",
    expected: { firstUnfinishedAttemptId: "a-addon-2", hasUnknown: false, otherActiveAttemptId: null },
  },
];

test("batched authoritative guard returns the same payment and attempts as legacy reads", () => {
  const db = paymentDb();
  for (const fixture of fixtures) addPayment(db, fixture.payment);
  for (const fixture of fixtures) {
    const legacy = legacySnapshot(db, fixture.reservationId);
    const batched = batchedSnapshot(db, fixture.reservationId);
    assert.deepEqual(batched, legacy, fixture.name);
    const evaluated = evaluatePaymentExecutionGuard({
      attempts: batched.attempts,
      splitCount: batched.payment?.split_count ?? 0,
      attemptId: fixture.attemptId,
    });
    assert.equal(evaluated.attempt?.id ?? null, fixture.attemptId, fixture.name);
    assert.equal(evaluated.firstUnfinishedAttemptId, fixture.expected.firstUnfinishedAttemptId, fixture.name);
    assert.equal(evaluated.hasUnknown, fixture.expected.hasUnknown, fixture.name);
    assert.equal(evaluated.otherActiveAttemptId, fixture.expected.otherActiveAttemptId, fixture.name);
  }
});

test("stale attempt id is not selected after a newer retry row exists", () => {
  const db = paymentDb();
  const fixture = fixtures.find((item) => item.name === "latest retry row wins");
  addPayment(db, fixture.payment);
  const snapshot = batchedSnapshot(db, fixture.reservationId);
  const evaluated = evaluatePaymentExecutionGuard({
    attempts: snapshot.attempts,
    splitCount: snapshot.payment.split_count,
    attemptId: "a-retry-old",
  });
  assert.equal(evaluated.attempt, null);
  assert.equal(evaluated.firstUnfinishedAttemptId, "a-retry-new");
});

test("migration 0042 schema check fails closed for a missing table or required index", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(paymentIntentSchemaIsReady(db.prepare(PAYMENT_INTENT_SCHEMA_CHECK_SQL).get()), false);
  const migration = fs.readFileSync(new URL("../drizzle/0042_local_direct_payment_intents.sql", import.meta.url), "utf8");
  db.exec(migration);
  assert.equal(paymentIntentSchemaIsReady(db.prepare(PAYMENT_INTENT_SCHEMA_CHECK_SQL).get()), true);
  db.exec("DROP INDEX payment_intents_status_expiry_idx");
  assert.equal(paymentIntentSchemaIsReady(db.prepare(PAYMENT_INTENT_SCHEMA_CHECK_SQL).get()), false);
});
