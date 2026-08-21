import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  allocateMemberCoupons,
  buildMemberCouponSlots,
  memberCouponAmountsFitParticipantSlots,
} from "../app/member-coupon-allocation.ts";

test("stamp rewards, weekday grants, expiry, and coupon payments share one coupon ledger", async () => {
  const [benefits, payments, api, ui] = await Promise.all([
    readFile(new URL("../db/member-benefits.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/payments.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/member-benefits/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/ReservationsAdmin.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(benefits, /issueAutomaticStampCoupons/);
  assert.match(benefits, /datetime\('now', '\+1 month'\)/);
  assert.match(benefits, /'AUTO_COUPON'/);
  assert.match(benefits, /grantWeekdayCoupons/);
  assert.match(benefits, /WEEKDAY_COUPON_WEEKDAY_ONLY/);
  assert.match(benefits, /LEGACY_WEEKDAY/);
  assert.match(api, /grant_weekday_coupon/);
  assert.match(payments, /member_coupon_id/);
  assert.match(payments, /used_payment_attempt_id/);
  assert.match(payments, /used_at = NULL, used_reservation_id = NULL/);
  assert.match(ui, /eligibleCoupons/);
  assert.match(ui, /memberCouponId/);
  assert.match(ui, /예약에 회원을 연결하면 보유 쿠폰을 선택할 수 있습니다/);
});

test("쿠폰 1장마다 청소년 우선으로 정확히 이용자 1명분만 배정한다", () => {
  const slots = buildMemberCouponSlots({
    adultCount: 2,
    youthCount: 2,
    adultPrice: 7_000,
    youthPrice: 5_000,
    maximumCouponAmount: 24_000,
  });
  assert.deepEqual(slots, [
    { participantType: "youth", participantOrdinal: 1, amount: 5_000 },
    { participantType: "youth", participantOrdinal: 2, amount: 5_000 },
    { participantType: "adult", participantOrdinal: 1, amount: 7_000 },
    { participantType: "adult", participantOrdinal: 2, amount: 7_000 },
  ]);

  const allocations = allocateMemberCoupons({
    couponIds: ["coupon-1", "coupon-2", "coupon-3"],
    adultCount: 2,
    youthCount: 2,
    adultPrice: 7_000,
    youthPrice: 5_000,
    maximumCouponAmount: 24_000,
  });
  assert.deepEqual(allocations.map(({ couponId, participantType, amount }) => ({ couponId, participantType, amount })), [
    { couponId: "coupon-1", participantType: "youth", amount: 5_000 },
    { couponId: "coupon-2", participantType: "youth", amount: 5_000 },
    { couponId: "coupon-3", participantType: "adult", amount: 7_000 },
  ]);
});

test("쿠폰은 이용자 수 안에서 남은 현장 게임비만큼 배정한다", () => {
  const partial = allocateMemberCoupons({
    couponIds: ["coupon-1", "coupon-2", "coupon-3"],
    adultCount: 2,
    youthCount: 2,
    adultPrice: 7_000,
    youthPrice: 5_000,
    maximumCouponAmount: 14_000,
  });
  assert.deepEqual(partial.map(({ participantType, amount }) => ({ participantType, amount })), [
    { participantType: "youth", amount: 5_000 },
    { participantType: "youth", amount: 5_000 },
    { participantType: "adult", amount: 4_000 },
  ]);

  assert.throws(() => allocateMemberCoupons({
    couponIds: ["coupon-1", "coupon-2", "coupon-3", "coupon-4"],
    adultCount: 2,
    youthCount: 2,
    adultPrice: 7_000,
    youthPrice: 5_000,
    maximumCouponAmount: 14_000,
  }), /MEMBER_COUPON_PARTICIPANT_LIMIT/);

  assert.throws(() => allocateMemberCoupons({
    couponIds: ["coupon-1", "coupon-1"],
    adultCount: 2,
    youthCount: 0,
    adultPrice: 7_000,
    youthPrice: 5_000,
    maximumCouponAmount: 14_000,
  }), /MEMBER_COUPON_DUPLICATE_IN_PLAN/);
});

test("부가상품 금액은 쿠폰 배정 한도에 포함하지 않는다", () => {
  const allocations = allocateMemberCoupons({
    couponIds: ["coupon-1", "coupon-2"],
    adultCount: 2,
    youthCount: 0,
    adultPrice: 7_000,
    youthPrice: 5_000,
    maximumCouponAmount: 14_000,
  });
  assert.equal(allocations.reduce((sum, item) => sum + item.amount, 0), 14_000);
  assert.throws(() => allocateMemberCoupons({
    couponIds: ["coupon-1", "coupon-2", "coupon-for-addon"],
    adultCount: 3,
    youthCount: 0,
    adultPrice: 7_000,
    youthPrice: 5_000,
    maximumCouponAmount: 14_000,
  }), /MEMBER_COUPON_PARTICIPANT_LIMIT/);
});

test("앞선 쿠폰 회차를 다른 결제수단으로 바꿔도 남은 쿠폰의 인원별 금액을 검증한다", () => {
  const participantPricing = {
    adultCount: 1,
    youthCount: 1,
    adultPrice: 7_000,
    youthPrice: 5_000,
    maximumCouponAmount: 12_000,
  };
  assert.equal(memberCouponAmountsFitParticipantSlots({
    ...participantPricing,
    couponAmounts: [7_000],
  }), true);
  assert.equal(memberCouponAmountsFitParticipantSlots({
    ...participantPricing,
    couponAmounts: [7_000, 7_000],
  }), false);
});

test("관리자와 서버가 다중 쿠폰의 1인 1매 금액을 함께 강제한다", async () => {
  const [payments, api, ui] = await Promise.all([
    readFile(new URL("../db/payments.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/payments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/ReservationsAdmin.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(payments, /allocateMemberCoupons/);
  assert.match(payments, /MEMBER_COUPON_AMOUNT_MISMATCH/);
  assert.match(payments, /validateCouponAttemptAmount/);
  assert.match(api, /MEMBER_COUPON_PARTICIPANT_LIMIT/);
  assert.match(api, /MEMBER_COUPON_AMOUNT_MISMATCH/);
  assert.match(ui, /쿠폰 1장당 이용자 1명의 게임비만 적용됩니다/);
  assert.match(ui, /remainingCashAmount/);
  assert.match(ui, /couponAllocations/);
  assert.match(ui, /slot\.participantType/);
  assert.doesNotMatch(ui, /slot\.kind/);
  assert.match(ui, /setCouponSelection\(\(current\) => current\.contextKey === couponSelectionContextKey/);
});
