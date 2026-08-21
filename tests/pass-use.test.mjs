import assert from "node:assert/strict";
import test from "node:test";
import { quotePassUse } from "../app/pass-use.ts";

test("여러 아이가 다회권을 사용하면 선택 횟수만큼 게임비가 차감된다", () => {
  assert.deepEqual(quotePassUse({
    baseAmount: 15_000,
    addOnAmount: 0,
    discountAmount: 0,
    regularUnitPrice: 5_000,
    uses: 3,
  }), {
    uses: 3,
    appliedDiscount: 15_000,
    nextDiscountAmount: 15_000,
    paymentAmount: 0,
  });
});

test("청소년 다회권을 성인이 함께 쓰면 인당 2천원 차액이 남는다", () => {
  const quote = quotePassUse({
    baseAmount: 12_000,
    addOnAmount: 0,
    discountAmount: 0,
    regularUnitPrice: 5_000,
    uses: 2,
  });
  assert.equal(quote.appliedDiscount, 10_000);
  assert.equal(quote.paymentAmount, 2_000);
});

test("다회권은 음료 등 부가금액을 할인하지 않는다", () => {
  const quote = quotePassUse({
    baseAmount: 5_000,
    addOnAmount: 3_000,
    discountAmount: 0,
    regularUnitPrice: 5_000,
    uses: 1,
  });
  assert.equal(quote.appliedDiscount, 5_000);
  assert.equal(quote.paymentAmount, 3_000);
});

test("청소년 다회권 3회 사용 시 성인 차액 2천원만 남는다", () => {
  const quote = quotePassUse({
    baseAmount: 17_000,
    addOnAmount: 0,
    discountAmount: 0,
    regularUnitPrice: 5_000,
    uses: 3,
  });
  assert.equal(quote.appliedDiscount, 15_000);
  assert.equal(quote.paymentAmount, 2_000);
});
