import assert from "node:assert/strict";
import test from "node:test";
import { buildPassCreditPlan, maxPassCreditUses } from "../app/pass-purchase-credit.ts";

const repeatGames = [
  { id: "first", adultCount: 1, youthCount: 2, totalCount: 3, paidGameAmount: 17_000 },
  { id: "repeat", adultCount: 0, youthCount: 2, totalCount: 2, paidGameAmount: 10_000 },
];

test("youth pass conversion credits both paid games in a repeat group", () => {
  assert.equal(maxPassCreditUses(repeatGames, "youth", 5_000), 4);
  assert.deepEqual(buildPassCreditPlan({
    candidates: repeatGames,
    ageGroup: "youth",
    regularUnitPrice: 5_000,
    requestedUses: 4,
    productUses: 10,
  }), {
    availableUses: 4,
    usedUses: 4,
    creditAmount: 20_000,
    allocations: [
      { reservationId: "first", uses: 2, amount: 10_000 },
      { reservationId: "repeat", uses: 2, amount: 10_000 },
    ],
  });
});

test("age group and actually paid game amount cap the immediate use", () => {
  assert.equal(maxPassCreditUses(repeatGames, "adult", 7_000), 1);
  const plan = buildPassCreditPlan({
    candidates: repeatGames,
    ageGroup: "adult",
    regularUnitPrice: 7_000,
    requestedUses: 4,
    productUses: 10,
  });
  assert.equal(plan.usedUses, 1);
  assert.equal(plan.creditAmount, 7_000);
  assert.deepEqual(plan.allocations.map((item) => item.reservationId), ["first"]);
});
