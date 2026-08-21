import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateKioskVisitCleanup } from "../app/kiosk/admin-cleanup-policy.ts";

const base = {
  status: "EXPIRED",
  flowType: "KIOSK_TEST",
  reservationId: "",
  startedAt: "",
  completedAt: "",
  activeHoldCount: 0,
  approvedPaymentCount: 0,
  paidPaymentCount: 0,
  paidReservationCount: 0,
  gameRecordCount: 0,
  salesCount: 0,
  passLedgerCount: 0,
  couponLedgerCount: 0,
  stampLedgerCount: 0,
  visitStampAllocationCount: 0,
  bankTransferSessionCount: 0,
};

test("unpaid test visit can be deleted", () => {
  assert.equal(evaluateKioskVisitCleanup(base).canHardDelete, true);
});

test("closed unlinked temporary visit can be deleted without being labelled test", () => {
  const result = evaluateKioskVisitCleanup({ ...base, flowType: "WALK_IN" });
  assert.equal(result.canHardDelete, true);
  assert.equal(result.isTest, false);
  assert.equal(result.isTemporary, true);
});

test("real reservation is protected", () => {
  assert.match(evaluateKioskVisitCleanup({ ...base, reservationId: "booking-1" }).deleteBlockReason, /실제 예약/);
});

test("approved card payment is protected", () => {
  assert.match(evaluateKioskVisitCleanup({ ...base, approvedPaymentCount: 1 }).deleteBlockReason, /승인 또는 완료된 결제/);
});

test("completed cash or account payment is protected", () => {
  assert.equal(evaluateKioskVisitCleanup({ ...base, approvedPaymentCount: 2 }).canHardDelete, false);
});

test("paid payment ledger is protected", () => {
  assert.equal(evaluateKioskVisitCleanup({ ...base, paidPaymentCount: 1 }).canHardDelete, false);
});

test("paid reservation totals are protected", () => {
  assert.equal(evaluateKioskVisitCleanup({ ...base, paidReservationCount: 1 }).canHardDelete, false);
});

test("playing visit cannot terminate or delete", () => {
  const result = evaluateKioskVisitCleanup({ ...base, status: "PLAYING" });
  assert.equal(result.canTerminate, false);
  assert.equal(result.canHardDelete, false);
});

test("completed visit is protected", () => {
  const result = evaluateKioskVisitCleanup({ ...base, status: "COMPLETED", completedAt: "2026-08-16T01:00:00Z" });
  assert.equal(result.canTerminate, false);
  assert.equal(result.canHardDelete, false);
});

test("game and sales records are protected", () => {
  assert.equal(evaluateKioskVisitCleanup({ ...base, gameRecordCount: 1 }).canHardDelete, false);
  assert.equal(evaluateKioskVisitCleanup({ ...base, salesCount: 1 }).canHardDelete, false);
});

test("pass and coupon ledgers are protected", () => {
  assert.equal(evaluateKioskVisitCleanup({ ...base, passLedgerCount: 1 }).canHardDelete, false);
  assert.equal(evaluateKioskVisitCleanup({ ...base, couponLedgerCount: 1 }).canHardDelete, false);
});

test("stamp ledgers and pending allocations are protected", () => {
  assert.equal(evaluateKioskVisitCleanup({ ...base, stampLedgerCount: 1 }).canHardDelete, false);
  assert.equal(evaluateKioskVisitCleanup({ ...base, visitStampAllocationCount: 1 }).canHardDelete, false);
});

test("active owned hold can be released", () => {
  assert.equal(evaluateKioskVisitCleanup({ ...base, activeHoldCount: 1 }).canReleaseHold, true);
});

test("admin API revalidates destructive actions on the server and records audits", async () => {
  const [route, service] = await Promise.all([
    readFile(new URL("../app/api/admin/kiosk/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /getOperator/);
  assert.match(route, /deleteKioskTestVisit/);
  assert.match(route, /terminateKioskVisit/);
  assert.match(route, /previewKioskCleanup/);
  assert.match(service, /loadKioskCleanupFactRow/);
  assert.match(service, /evaluateKioskVisitCleanup/);
  assert.match(service, /kiosk_visit_admin_audit/);
  assert.doesNotMatch(service, /DELETE FROM payments|DELETE FROM payment_attempts|DELETE FROM reservations/);
});

