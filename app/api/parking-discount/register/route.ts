import { getOperator } from "@/app/operator";
import { getParkingDiscountRequest } from "@/db/parking-discounts";
import {
  ParkingRegistrationError,
  queueParkingRegistration,
} from "@/db/parking-registration";
import { getReservationById } from "@/db/reservations";

function cleanIdempotencyKey(value: unknown) {
  const key = String(value ?? "").trim();
  return /^[A-Za-z0-9:_-]{12,120}$/.test(key) ? key : "";
}

export async function GET(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return Response.json({ error: "요청 ID가 필요합니다." }, { status: 400 });
  const parkingRequest = await getParkingDiscountRequest(id);
  if (!parkingRequest) return Response.json({ error: "주차등록 요청을 찾지 못했습니다." }, { status: 404 });
  const reservation = parkingRequest.reservationId
    ? await getReservationById(parkingRequest.reservationId)
    : null;
  return Response.json({ request: parkingRequest, reservation }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const reservationId = String(body.reservationId ?? "").trim();
    const carLast4 = String(body.carLast4 ?? "").trim();
    const idempotencyKey = cleanIdempotencyKey(body.idempotencyKey);
    if (!/^[0-9a-f-]{36}$/i.test(reservationId)) {
      return Response.json({ error: "예약을 먼저 저장해주세요." }, { status: 400 });
    }
    if (!/^\d{4}$/.test(carLast4)) {
      return Response.json({ error: "차량번호 뒤 4자리를 정확히 입력해주세요." }, { status: 400 });
    }
    if (!idempotencyKey) {
      return Response.json({ error: "올바른 중복방지 키가 필요합니다." }, { status: 400 });
    }
    const reservation = await getReservationById(reservationId);
    if (!reservation) return Response.json({ error: "예약을 찾지 못했습니다." }, { status: 404 });

    const parkingRequest = await queueParkingRegistration({
      reservation: { ...reservation, vehicleLast4: carLast4 },
      requestedBy: operator.email,
      triggerMode: "manual",
      idempotencyKey,
    });
    const updatedReservation = await getReservationById(reservationId);
    return Response.json(
      { enabled: true, request: parkingRequest, reservation: updatedReservation },
      { status: parkingRequest.status === "PENDING" ? 202 : 200 },
    );
  } catch (error) {
    if (error instanceof ParkingRegistrationError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "주차등록 요청을 만들지 못했습니다." },
      { status: 500 },
    );
  }
}
