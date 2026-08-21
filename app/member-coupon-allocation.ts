export type MemberCouponParticipantType = "youth" | "adult";

export type MemberCouponSlot = {
  participantType: MemberCouponParticipantType;
  participantOrdinal: number;
  amount: number;
};

export type MemberCouponAllocation = MemberCouponSlot & {
  couponId: string;
};

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

export function buildMemberCouponSlots(input: {
  adultCount: number;
  youthCount: number;
  adultPrice: number;
  youthPrice: number;
  maximumCouponAmount: number;
}): MemberCouponSlot[] {
  const remainingByType = [
    {
      participantType: "youth" as const,
      count: nonNegativeInteger(input.youthCount),
      price: nonNegativeInteger(input.youthPrice),
    },
    {
      participantType: "adult" as const,
      count: nonNegativeInteger(input.adultCount),
      price: nonNegativeInteger(input.adultPrice),
    },
  ];
  let remainingAmount = nonNegativeInteger(input.maximumCouponAmount);
  const slots: MemberCouponSlot[] = [];

  for (const group of remainingByType) {
    if (group.price < 1) continue;
    for (let index = 0; index < group.count; index += 1) {
      if (remainingAmount < 1) return slots;
      slots.push({
        participantType: group.participantType,
        participantOrdinal: index + 1,
        amount: Math.min(group.price, remainingAmount),
      });
      remainingAmount -= Math.min(group.price, remainingAmount);
    }
  }
  return slots;
}

export function allocateMemberCoupons(input: {
  couponIds: string[];
  adultCount: number;
  youthCount: number;
  adultPrice: number;
  youthPrice: number;
  maximumCouponAmount: number;
}): MemberCouponAllocation[] {
  const couponIds = input.couponIds.map((value) => String(value ?? "").trim());
  if (couponIds.some((couponId) => !couponId)) throw new Error("MEMBER_COUPON_REQUIRED");
  if (new Set(couponIds).size !== couponIds.length) {
    throw new Error("MEMBER_COUPON_DUPLICATE_IN_PLAN");
  }

  const slots = buildMemberCouponSlots(input);
  if (couponIds.length > slots.length) throw new Error("MEMBER_COUPON_PARTICIPANT_LIMIT");
  return couponIds.map((couponId, index) => ({ couponId, ...slots[index] }));
}

export function memberCouponAmountsFitParticipantSlots(input: {
  couponAmounts: number[];
  adultCount: number;
  youthCount: number;
  adultPrice: number;
  youthPrice: number;
  maximumCouponAmount: number;
}) {
  const remainingSlots = buildMemberCouponSlots(input);
  for (const value of input.couponAmounts) {
    const amount = nonNegativeInteger(value);
    const matchingIndex = remainingSlots.findIndex((slot) => slot.amount === amount);
    if (matchingIndex < 0) return false;
    remainingSlots.splice(matchingIndex, 1);
  }
  return true;
}
