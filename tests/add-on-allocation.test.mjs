import assert from "node:assert/strict";
import test from "node:test";
import { allocateAddOnPaymentMethods } from "../app/add-on-allocation.ts";

test("single card approval assigns the add-on portion to card revenue", () => {
  assert.deepEqual(
    allocateAddOnPaymentMethods(3_000, { card: 17_000, cash: 0, account: 0 }),
    { card: 3_000, cash: 0, account: 0 },
  );
});

test("mixed settlement allocates the exact add-on total without using coupon value", () => {
  const allocation = allocateAddOnPaymentMethods(3_000, {
    card: 12_000,
    cash: 2_000,
    account: 1_000,
    coupon: 10_000,
  });
  assert.equal(allocation.card + allocation.cash + allocation.account, 3_000);
  assert.deepEqual(allocation, { card: 2_400, cash: 400, account: 200 });
});

test("add-on recognition never exceeds physical payment received", () => {
  assert.deepEqual(
    allocateAddOnPaymentMethods(3_000, { card: 1_000, cash: 0, account: 0 }),
    { card: 1_000, cash: 0, account: 0 },
  );
});
