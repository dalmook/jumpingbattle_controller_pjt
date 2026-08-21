import { getOperator } from "@/app/operator";
import {
  adjustStamp,
  cancelMemberCoupon,
  cancelStampUse,
  createPassPurchaseOrder,
  getMemberBenefits,
  grantWeekdayCoupons,
  restorePassUse,
  redeemMemberPass,
  redeemStampBenefit,
} from "@/db/member-benefits";
import { getReservationById } from "@/db/reservations";

function benefitError(error: unknown) {
  const code = error instanceof Error ? error.message : "MEMBER_BENEFIT_ERROR";
  const messages: Record<string, string> = {
    MEMBER_NOT_FOUND: "회원을 찾지 못했습니다.",
    PASS_PRODUCT_NOT_FOUND: "판매 중인 다회권 상품을 찾지 못했습니다.",
    PASS_PRODUCT_PRICE_INVALID: "다회권 판매가를 설정에서 확인해주세요.",
    MEMBER_PASS_NOT_FOUND: "다회권을 찾지 못했습니다.",
    MEMBER_PASS_NOT_ACTIVE: "사용할 수 없는 다회권입니다.",
    MEMBER_PASS_EXPIRED: "유효기간이 지난 다회권입니다.",
    MEMBER_PASS_USES_INVALID: "차감할 다회권 횟수를 확인해주세요.",
    MEMBER_PASS_USES_EXCEED_PEOPLE: "예약 인원보다 많은 횟수를 차감할 수 없습니다.",
    RESERVATION_MEMBER_MISMATCH: "예약에 연결된 회원과 다회권 회원이 다릅니다.",
    CANCELLED_RESERVATION: "취소된 예약에는 다회권을 사용할 수 없습니다.",
    PASS_USE_NOT_FOUND: "되돌릴 다회권 사용내역을 찾지 못했습니다.",
    PASS_USE_PAYMENT_PLAN_EXISTS: "결제 계획이 이미 있어 다회권 금액을 변경할 수 없습니다. 기존 결제를 먼저 취소해주세요.",
    PASS_PURCHASE_CREDIT_MEMBER_MISMATCH: "게임비를 차감할 예약과 다회권 구매 회원이 다릅니다.",
    PASS_PURCHASE_CREDIT_RESERVATION_INVALID: "이 예약의 게임비는 다회권 구매에 사용할 수 없습니다.",
    PASS_PURCHASE_CREDIT_NOT_PAID: "결제 완료된 게임비만 다회권 구매금액에서 차감할 수 있습니다.",
    PASS_PURCHASE_CREDIT_ALREADY_USED: "이미 다회권 차감 또는 구매 전환에 사용된 예약입니다.",
    PASS_PURCHASE_CREDIT_INSUFFICIENT: "선택한 횟수만큼 차감할 결제 완료 게임비가 부족합니다.",
    STAMP_BALANCE_INSUFFICIENT: "스탬프가 부족합니다.",
    STAMP_ADJUST_AMOUNT_INVALID: "조정할 스탬프 수량을 확인해주세요.",
    STAMP_USE_NOT_FOUND: "취소할 스탬프 사용내역을 찾지 못했습니다.",
    MEMBER_COUPON_NOT_FOUND: "쿠폰을 찾지 못했습니다.",
    MEMBER_COUPON_ALREADY_USED: "이미 사용된 쿠폰은 회수할 수 없습니다.",
    MEMBER_COUPON_QUANTITY_INVALID: "쿠폰 수량은 1장부터 20장까지 입력해주세요.",
  };
  return Response.json({ error: messages[code] ?? code }, { status: code === "MEMBER_NOT_FOUND" ? 404 : 409 });
}

export async function GET(request: Request) {
  if (!(await getOperator())) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const memberId = new URL(request.url).searchParams.get("memberId") ?? "";
    if (!memberId) return Response.json({ error: "회원 번호가 필요합니다." }, { status: 400 });
    return Response.json({ benefits: await getMemberBenefits(memberId) });
  } catch (error) {
    return benefitError(error);
  }
}

export async function POST(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "");
    const memberId = String(body.memberId ?? "");
    if (action === "create_purchase") {
      const order = await createPassPurchaseOrder(
        memberId,
        String(body.productCode ?? ""),
        operator.email,
        body.creditReservationId ? String(body.creditReservationId) : null,
        Number(body.creditUses ?? 1),
      );
      const reservation = await getReservationById(order.reservationId);
      if (!reservation) throw new Error("PASS_PURCHASE_RESERVATION_NOT_FOUND");
      return Response.json({ order, reservation, benefits: await getMemberBenefits(memberId) }, { status: 201 });
    }
    if (action === "use_pass") {
      return Response.json({ benefits: await redeemMemberPass(
        String(body.memberPassId ?? ""),
        body.reservationId ? String(body.reservationId) : null,
        operator.email,
        Number(body.uses ?? 1),
      ) });
    }
    if (action === "restore_pass") {
      return Response.json({ benefits: await restorePassUse(String(body.ledgerId ?? ""), operator.email) });
    }
    if (action === "use_stamp") {
      return Response.json({ benefits: await redeemStampBenefit(memberId, body.reservationId ? String(body.reservationId) : null, operator.email) });
    }
    if (action === "cancel_stamp") {
      return Response.json({ benefits: await cancelStampUse(String(body.ledgerId ?? ""), operator.email) });
    }
    if (action === "adjust_stamp") {
      return Response.json({ benefits: await adjustStamp(memberId, Number(body.amount), String(body.reason ?? ""), operator.email) });
    }
    if (action === "grant_weekday_coupon") {
      return Response.json({ benefits: await grantWeekdayCoupons(memberId, Number(body.quantity ?? 1), operator.email) });
    }
    if (action === "cancel_coupon") {
      return Response.json({ benefits: await cancelMemberCoupon(String(body.couponId ?? ""), operator.email) });
    }
    return Response.json({ error: "지원하지 않는 회원 혜택 요청입니다." }, { status: 400 });
  } catch (error) {
    return benefitError(error);
  }
}
