import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyReservationSales,
  classifySharedSales,
  unclassifiedReservationPaymentAmount,
} from "../app/admin/sales-classification.ts";
import { DEFAULT_PRICING_SETTINGS, sanitizePricingSettings } from "../app/pricing-config.ts";

function emptySharedSales() {
  return {
    slush_card: 0,
    slush_cash: 0,
    slush_account: 0,
    beverage_card: 0,
    beverage_cash: 0,
    beverage_account: 0,
    slush_card_count: 0,
    slush_cash_count: 0,
    slush_account_count: 0,
    beverage_card_count: 0,
    beverage_cash_count: 0,
    beverage_account_count: 0,
    other_card_count: 0,
    other_cash_count: 0,
    other_account_count: 0,
    youth_pass_10_card_count: 0,
    youth_pass_10_cash_count: 0,
    youth_pass_10_account_count: 0,
    youth_pass_20_card_count: 0,
    youth_pass_20_cash_count: 0,
    youth_pass_20_account_count: 0,
    adult_pass_10_card_count: 0,
    adult_pass_10_cash_count: 0,
    adult_pass_10_account_count: 0,
    adult_pass_20_card_count: 0,
    adult_pass_20_cash_count: 0,
    adult_pass_20_account_count: 0,
  };
}

test("Naver game fee separates deposit and on-site card payment", () => {
  const result = classifyReservationSales({
    source: "naver",
    base_amount: 21_000,
    add_on_amount: 0,
    discount_amount: 0,
    payment_amount: 21_000,
    payment_card_amount: 16_000,
    payment_cash_amount: 0,
    payment_account_amount: 0,
    payment_method: "card",
    payment_status: "paid",
    same_day_naver_cancel: 0,
  }, 5_000);

  assert.equal(result.gameDeposit, 5_000);
  assert.equal(result.gameCard, 16_000);
  assert.equal(result.gameRevenue, 21_000);
});

test("multi-use passes are game fees and shared products are add-on sales", () => {
  const result = classifySharedSales({
    ...emptySharedSales(),
    slush_card_count: 2,
    beverage_cash_count: 1,
    other_account_count: 1,
    adult_pass_10_card_count: 1,
  });

  assert.equal(result.gameCard, 60_000);
  assert.equal(result.gameRevenue, 60_000);
  assert.equal(result.addOnCard, 3_000);
  assert.equal(result.addOnCash, 1_000);
  assert.equal(result.addOnAccount, 1_000);
  assert.equal(result.addOnRevenue, 5_000);
});

test("same-day Naver cancellation is reported in the game deposit column", () => {
  const result = classifyReservationSales({
    source: "naver",
    base_amount: 0,
    add_on_amount: 0,
    discount_amount: 0,
    payment_amount: 0,
    payment_card_amount: 0,
    payment_cash_amount: 0,
    payment_account_amount: 0,
    payment_method: "",
    payment_status: "unpaid",
    same_day_naver_cancel: 1,
  }, 5_000);

  assert.equal(result.gameDeposit, 5_000);
  assert.equal(result.cancellationFee, 5_000);
  assert.equal(result.gameRevenue, 5_000);
});

test("configured prices are used for deposits and shared-sale quantities", () => {
  const pricing = {
    ...DEFAULT_PRICING_SETTINGS,
    naverDepositAmount: 7_000,
    slushPrice: 2_000,
    adultPass10Price: 65_000,
  };
  const reservation = classifyReservationSales({
    source: "naver",
    base_amount: 21_000,
    add_on_amount: 0,
    discount_amount: 0,
    payment_amount: 21_000,
    payment_card_amount: 14_000,
    payment_cash_amount: 0,
    payment_account_amount: 0,
    payment_method: "card",
    payment_status: "paid",
    same_day_naver_cancel: 0,
  }, 5_000, pricing.naverDepositAmount);
  const shared = classifySharedSales({
    ...emptySharedSales(),
    slush_card_count: 2,
    adult_pass_10_cash_count: 1,
  }, pricing);

  assert.equal(reservation.gameDeposit, 7_000);
  assert.equal(shared.addOnCard, 4_000);
  assert.equal(shared.gameCash, 65_000);
});

test("coupon settlement completes a reservation without increasing revenue", () => {
  const result = classifyReservationSales({
    source: "manual",
    base_amount: 14_000,
    add_on_amount: 0,
    discount_amount: 0,
    payment_amount: 14_000,
    payment_card_amount: 4_000,
    payment_cash_amount: 0,
    payment_account_amount: 0,
    payment_coupon_amount: 10_000,
    payment_method: "mixed",
    payment_status: "paid",
    same_day_naver_cancel: 0,
  }, 5_000);

  assert.equal(result.expected, 14_000);
  assert.equal(result.gameCard, 4_000);
  assert.equal(result.gameUnclassified, 0);
  assert.equal(result.gameRevenue, 4_000);
});

test("integrated admin KPI excludes coupon settlement from unclassified revenue", () => {
  const unclassified = unclassifiedReservationPaymentAmount({
    paymentAmount: 14_000,
    depositAmount: 0,
    cardAmount: 4_000,
    cashAmount: 0,
    accountAmount: 0,
    couponAmount: 10_000,
  });

  assert.equal(unclassified, 0);
  assert.equal(4_000 + unclassified, 4_000);
});

test("integrated admin KPI receives the active coupon amount from reservation records", () => {
  const reservationSource = readFileSync(
    new URL("../db/reservations.ts", import.meta.url),
    "utf8",
  );
  const adminSource = readFileSync(
    new URL("../app/admin/ReservationsAdmin.tsx", import.meta.url),
    "utf8",
  );

  assert.match(reservationSource, /pa\.payment_method = 'coupon'/);
  assert.match(reservationSource, /pc\.status = 'CANCELLED'/);
  assert.match(reservationSource, /paymentCouponAmount: row\.payment_coupon_amount/);
  assert.match(adminSource, /couponAmount: item\.paymentCouponAmount/);
});

test("one approval separates an attached add-on sale from game revenue", () => {
  const result = classifyReservationSales({
    source: "manual",
    base_amount: 14_000,
    add_on_amount: 3_000,
    discount_amount: 0,
    payment_amount: 17_000,
    payment_card_amount: 17_000,
    payment_cash_amount: 0,
    payment_account_amount: 0,
    payment_method: "card",
    payment_status: "paid",
    same_day_naver_cancel: 0,
    linked_add_on_amount: 3_000,
    linked_add_on_card_amount: 3_000,
    linked_add_on_cash_amount: 0,
    linked_add_on_account_amount: 0,
  }, 5_000);

  assert.equal(result.expected, 14_000);
  assert.equal(result.gameCard, 14_000);
  assert.equal(result.gameRevenue, 14_000);
});

test("operating price settings accept validated custom add-on products", () => {
  const result = sanitizePricingSettings({
    ...DEFAULT_PRICING_SETTINGS,
    extraAddOnItems: [{ code: "socks", name: "양말", price: 2_000, active: true }],
  });
  assert.deepEqual(result?.extraAddOnItems, [{ code: "socks", name: "양말", price: 2_000, active: true }]);
  assert.equal(sanitizePricingSettings({
    ...DEFAULT_PRICING_SETTINGS,
    extraAddOnItems: [{ code: "bad code", name: "오류", price: 1_000 }],
  }), null);
});
