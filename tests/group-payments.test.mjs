import assert from "node:assert/strict";
import test from "node:test";
import { allocateGroupPaymentMethods } from "../db/payment-group.ts";

const allocations = [
  { reservationId: "game-1", finalAmount: 19_000, payableAmount: 19_000 },
  { reservationId: "game-2", finalAmount: 10_000, payableAmount: 10_000 },
];

test("one terminal approval is allocated to both repeat-game reservations", () => {
  const result = allocateGroupPaymentMethods({
    allocations,
    completedPayments: [{ method: "card", amount: 29_000 }],
    wholeStatus: "PAID",
  });

  assert.deepEqual(result.map((item) => ({
    id: item.reservationId,
    final: item.finalAmount,
    card: item.cardAmount,
    status: item.paymentStatus,
  })), [
    { id: "game-1", final: 19_000, card: 19_000, status: "paid" },
    { id: "game-2", final: 10_000, card: 10_000, status: "paid" },
  ]);
});

test("mixed payment methods remain separated per reservation", () => {
  const result = allocateGroupPaymentMethods({
    allocations,
    completedPayments: [
      { method: "card", amount: 20_000 },
      { method: "cash", amount: 9_000 },
    ],
    wholeStatus: "PAID",
  });

  assert.equal(result[0].cardAmount, 19_000);
  assert.equal(result[0].cashAmount, 0);
  assert.equal(result[1].cardAmount, 1_000);
  assert.equal(result[1].cashAmount, 9_000);
  assert.equal(result[1].paymentMethod, "mixed");
});

test("cancelling the shared approval cancels both reservation summaries", () => {
  const result = allocateGroupPaymentMethods({
    allocations,
    completedPayments: [],
    wholeStatus: "CANCELLED",
  });

  assert.deepEqual(result.map((item) => item.paymentStatus), ["cancelled", "cancelled"]);
  assert.deepEqual(result.map((item) => item.cardAmount), [0, 0]);
});
