import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildPaymentPlan,
  calculatePaymentLedger,
  paymentPlanMatchesLedger,
} from "../db/payment-ledger.ts";

const pay = (
  id,
  amount,
  paymentMethod = "card",
  status = paymentMethod === "card" ? "APPROVED" : "COMPLETED",
  splitIndex = 1,
) => ({
  id,
  attemptType: "PAY",
  paymentMethod,
  amount,
  status,
  splitIndex,
});

const cancel = (id, originalAttemptId, status = "CANCELLED") => ({
  id,
  attemptType: "CANCEL",
  paymentMethod: "card",
  amount: 1,
  status,
  originalAttemptId,
});

test("네이버 예약금이 빠진 기존 결제 계획은 실행 전에 차단된다", () => {
  assert.equal(paymentPlanMatchesLedger({
    authoritativeFinalAmount: 14_000,
    authoritativeDepositAmount: 5_000,
    storedFinalAmount: 14_000,
    storedDepositAmount: 0,
    storedPayableAmount: 14_000,
    planAmounts: [14_000],
  }), false);
  assert.equal(paymentPlanMatchesLedger({
    authoritativeFinalAmount: 14_000,
    authoritativeDepositAmount: 5_000,
    storedFinalAmount: 14_000,
    storedDepositAmount: 5_000,
    storedPayableAmount: 9_000,
    planAmounts: [9_000],
  }), true);
});

test("1. 14,000원 한 번 카드 결제", () => {
  const plan = buildPaymentPlan({
    payableAmount: 14_000,
    mode: "single",
    paymentMethod: "card",
  });
  assert.deepEqual(plan.map(({ amount, paymentMethod }) => ({ amount, paymentMethod })), [
    { amount: 14_000, paymentMethod: "card" },
  ]);
  const ledger = calculatePaymentLedger({
    finalAmount: 14_000,
    attempts: [pay("p1", 14_000)],
  });
  assert.equal(ledger.completedAmount, 14_000);
  assert.equal(ledger.remainingAmount, 0);
  assert.equal(ledger.paymentStatus, "PAID");
});

test("2. 14,000원 카드 3분할은 4,667/4,667/4,666원", () => {
  const plan = buildPaymentPlan({
    payableAmount: 14_000,
    mode: "equal",
    count: 3,
    paymentMethod: "card",
    items: [
      { amount: 0, paymentMethod: "card" },
      { amount: 0, paymentMethod: "cash" },
      { amount: 0, paymentMethod: "account" },
    ],
  });
  assert.deepEqual(plan.map((item) => item.amount), [4_667, 4_667, 4_666]);
  assert.deepEqual(plan.map((item) => item.paymentMethod), ["card", "cash", "account"]);
  assert.equal(plan.reduce((sum, item) => sum + item.amount, 0), 14_000);
});

test("2-1. 부가매출 1,500원 카드 2분할은 750원씩이며 첫 승인만으로 완료되지 않는다", () => {
  const plan = buildPaymentPlan({
    payableAmount: 1_500,
    mode: "equal",
    count: 2,
    paymentMethod: "card",
  });
  assert.deepEqual(plan.map((item) => item.amount), [750, 750]);

  const afterFirst = calculatePaymentLedger({
    finalAmount: 1_500,
    attempts: [pay("add-on-1", 750, "card", "APPROVED", 1)],
  });
  assert.equal(afterFirst.completedAmount, 750);
  assert.equal(afterFirst.remainingAmount, 750);
  assert.equal(afterFirst.paymentStatus, "PARTIALLY_PAID");

  const afterSecond = calculatePaymentLedger({
    finalAmount: 1_500,
    attempts: [
      pay("add-on-1", 750, "card", "APPROVED", 1),
      pay("add-on-2", 750, "card", "APPROVED", 2),
    ],
  });
  assert.equal(afterSecond.completedAmount, 1_500);
  assert.equal(afterSecond.remainingAmount, 0);
  assert.equal(afterSecond.paymentStatus, "PAID");
});

test("3. 카드+현금+카드 복합결제", () => {
  const ledger = calculatePaymentLedger({
    finalAmount: 14_000,
    attempts: [
      pay("p1", 4_000, "card", "APPROVED", 1),
      pay("p2", 5_000, "cash", "COMPLETED", 2),
      pay("p3", 5_000, "card", "APPROVED", 3),
    ],
  });
  assert.equal(ledger.completedByMethod.card, 9_000);
  assert.equal(ledger.completedByMethod.cash, 5_000);
  assert.equal(ledger.paymentStatus, "PAID");
});

test("4. 30,000원 카드+현금+계좌 직접 분할", () => {
  const plan = buildPaymentPlan({
    payableAmount: 30_000,
    mode: "custom",
    items: [
      { amount: 10_000, paymentMethod: "card" },
      { amount: 8_000, paymentMethod: "cash" },
      { amount: 12_000, paymentMethod: "BANK_TRANSFER" },
    ],
  });
  assert.deepEqual(plan.map((item) => item.paymentMethod), ["card", "cash", "account"]);
  assert.equal(plan.reduce((sum, item) => sum + item.amount, 0), 30_000);
});

test("5. 직접 분할 합계 부족은 차단", () => {
  assert.throws(
    () => buildPaymentPlan({
      payableAmount: 14_000,
      mode: "custom",
      items: [
        { amount: 5_000, paymentMethod: "card" },
        { amount: 8_000, paymentMethod: "cash" },
      ],
    }),
    /PAYMENT_SPLIT_TOTAL_UNDER/,
  );
});

test("6. 직접 분할 합계 초과는 차단", () => {
  assert.throws(
    () => buildPaymentPlan({
      payableAmount: 14_000,
      mode: "custom",
      items: [
        { amount: 7_000, paymentMethod: "card" },
        { amount: 8_000, paymentMethod: "cash" },
      ],
    }),
    /PAYMENT_SPLIT_TOTAL_OVER/,
  );
});

test("7. 두 번째 카드 거절 시 첫 승인 유지, 두 번째 금액만 남음", () => {
  const ledger = calculatePaymentLedger({
    finalAmount: 14_000,
    attempts: [
      pay("p1", 5_000, "card", "APPROVED", 1),
      pay("p2", 9_000, "card", "DECLINED", 2),
    ],
  });
  assert.equal(ledger.completedAmount, 5_000);
  assert.equal(ledger.remainingAmount, 9_000);
  assert.equal(ledger.paymentStatus, "PARTIALLY_PAID");
});

test("7-1. 실패한 분할 회차만 현금으로 바꿔도 앞선 카드 승인은 유지된다", () => {
  const ledger = calculatePaymentLedger({
    finalAmount: 20_000,
    attempts: [
      pay("p1", 5_000, "card", "APPROVED", 1),
      pay("p2", 5_000, "card", "APPROVED", 2),
      pay("p3", 5_000, "card", "APPROVED", 3),
      pay("p4-failed", 5_000, "card", "USER_CANCELLED", 4),
      pay("p4-cash", 5_000, "cash", "COMPLETED", 4),
    ],
  });
  assert.equal(ledger.completedByMethod.card, 15_000);
  assert.equal(ledger.completedByMethod.cash, 5_000);
  assert.equal(ledger.completedAmount, 20_000);
  assert.equal(ledger.paymentStatus, "PAID");
});

test("8. 새로고침을 가정한 직렬화 후에도 결제 상태 복원", () => {
  const persisted = JSON.parse(JSON.stringify([
    pay("p1", 5_000, "card", "APPROVED", 1),
    pay("p2", 9_000, "cash", "PENDING", 2),
  ]));
  const ledger = calculatePaymentLedger({ finalAmount: 14_000, attempts: persisted });
  assert.equal(ledger.completedAmount, 5_000);
  assert.equal(ledger.remainingAmount, 9_000);
});

test("9. 카드+현금 전체취소 후 CANCELLED", () => {
  const ledger = calculatePaymentLedger({
    finalAmount: 14_000,
    attempts: [
      pay("p1", 7_000, "card", "APPROVED", 1),
      pay("p2", 7_000, "cash", "COMPLETED", 2),
      cancel("c2", "p2"),
      cancel("c1", "p1"),
    ],
  });
  assert.equal(ledger.completedAmount, 0);
  assert.equal(ledger.paymentStatus, "CANCELLED");
});

test("10. 전체취소 중 한 건 실패 시 PARTIALLY_CANCELLED", () => {
  const ledger = calculatePaymentLedger({
    finalAmount: 2_000,
    attempts: [
      pay("p1", 1_000, "card", "APPROVED", 1),
      pay("p2", 1_000, "card", "APPROVED", 2),
      cancel("c2", "p2", "CANCELLED"),
      cancel("c1", "p1", "ERROR"),
    ],
  });
  assert.equal(ledger.completedAmount, 1_000);
  assert.equal(ledger.paymentStatus, "PARTIALLY_CANCELLED");
});

test("민감 카드 원문 필드는 웹 스키마와 서비스에 저장하지 않음", async () => {
  const [schema, service] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/payments.ts", import.meta.url), "utf8"),
  ]);
  for (const unsafe of ["card_number", "track1", "track2", "ic_data", "pin_data"]) {
    assert.equal(schema.includes(unsafe), false);
    assert.equal(service.includes(unsafe), false);
  }
  assert.match(schema, /maskedCardNo/);
});
