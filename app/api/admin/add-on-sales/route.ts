import { getOperator } from "@/app/operator";
import {
  cancelPendingAddOnSaleOrder,
  createAddOnSaleOrder,
  getAttachedAddOnSale,
} from "@/db/add-on-sales";

export async function GET(request: Request) {
  const operator = await getOperator();
  if (!operator) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const reservationId = new URL(request.url).searchParams.get("reservationId")?.trim() ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(reservationId)) {
    return Response.json({ error: "예약 번호가 올바르지 않습니다." }, { status: 400 });
  }
  return Response.json({ order: await getAttachedAddOnSale(reservationId) });
}

export async function POST(request: Request) {
  const operator = await getOperator();
  if (!operator) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return Response.json(await createAddOnSaleOrder({
      date: String(body.date ?? ""),
      slush: body.slush,
      beverage: body.beverage,
      other: body.other,
      items: Array.isArray(body.items) ? body.items as Array<{ code: string; quantity: unknown }> : [],
      requestedBy: operator.email,
    }), { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const messages: Record<string, string> = {
      ADD_ON_SALE_DATE_INVALID: "부가매출 날짜를 확인해주세요.",
      ADD_ON_SALE_ITEMS_REQUIRED: "결제할 상품 수량을 하나 이상 입력해주세요.",
      ADD_ON_SALE_AMOUNT_INVALID: "부가매출 결제금액을 확인해주세요.",
      ADD_ON_SALE_ITEMS_INVALID: "운영 가격 설정에 없는 부가상품이 포함되어 있습니다. 화면을 새로고침해주세요.",
      ADD_ON_SALE_RESERVATION_NOT_CREATED: "부가매출 결제건을 만들지 못했습니다.",
    };
    return Response.json(
      { error: messages[code] ?? (code || "부가매출 결제건을 만들지 못했습니다.") },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  const operator = await getOperator();
  if (!operator) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const reservationId = String(body.reservationId ?? "").trim();
    if (!reservationId) throw new Error("ADD_ON_SALE_NOT_FOUND");
    return Response.json(await cancelPendingAddOnSaleOrder(reservationId));
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const messages: Record<string, string> = {
      ADD_ON_SALE_NOT_FOUND: "취소할 부가매출 결제건을 찾지 못했습니다.",
      ADD_ON_SALE_ALREADY_PROCESSED: "이미 결제가 끝난 부가매출은 결제 내역에서 취소해주세요.",
      ADD_ON_SALE_PAYMENT_STARTED: "단말 승인 요청이 시작된 결제입니다. 결과를 확인한 뒤 결제 내역에서 취소해주세요.",
    };
    return Response.json(
      { error: messages[code] ?? (code || "부가매출 결제 준비를 취소하지 못했습니다.") },
      { status: 400 },
    );
  }
}
