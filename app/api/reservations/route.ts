import {
  OPERATING_SLOTS,
  calculateBaseAmount,
  dateInSeoul,
  getDifficulty,
  getRoom,
  nextBookableTime,
} from "@/app/reservation-config";
import {
  consumeReservationRateLimit,
  createWebReservation,
  getReservationById,
  listOccupiedSlots,
} from "@/db/reservations";
import { getPricingSettings } from "@/db/pricing-settings";
import { queueAutomaticParkingRegistration } from "@/db/parking-registration";

function clientAddress(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

async function clientKey(request: Request) {
  const bytes = new TextEncoder().encode(`reservation:${clientAddress(request)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function validDate(value: string) {
  return value === dateInSeoul();
}

export async function GET(request: Request) {
  const date = new URL(request.url).searchParams.get("date") ?? "";
  if (!validDate(date)) {
    return Response.json(
      { error: "고객 예약 화면에서는 오늘 예약만 접수할 수 있습니다." },
      { status: 400 },
    );
  }

  try {
    return Response.json({ date, occupied: await listOccupiedSlots(date) });
  } catch {
    return Response.json(
      { error: "예약 가능 시간을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const rateLimit = await consumeReservationRateLimit(await clientKey(request));
    if (!rateLimit.allowed) {
      return Response.json(
        { error: "예약 요청이 너무 많습니다. 잠시 후 다시 시도해주세요." },
        {
          status: 429,
          headers: { "retry-after": String(Math.max(1, rateLimit.retryAfter)) },
        },
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const scheduledDate = String(body.scheduledDate ?? "");
    const roomCode = String(body.roomCode ?? "");
    const teamName = String(body.teamName ?? "").trim();
    const difficultyCode = String(body.difficultyCode ?? "");
    const adultCount = Math.trunc(Number(body.adultCount));
    const youthCount = Math.trunc(Number(body.youthCount));
    const vehicleLast4 = String(body.vehicleLast4 ?? "").trim();
    const idempotencyKey = String(body.idempotencyKey ?? "").trim();
    const room = getRoom(roomCode);
    const difficulty = getDifficulty(difficultyCode);
    const totalCount = adultCount + youthCount;

    if (!validDate(scheduledDate)) {
      return Response.json(
        { error: "고객 예약 화면에서는 오늘 예약만 접수할 수 있습니다." },
        { status: 400 },
      );
    }
    if (!room) {
      return Response.json({ error: "이용할 방을 선택해주세요." }, { status: 400 });
    }
    if (!Number.isInteger(adultCount) || !Number.isInteger(youthCount) || adultCount < 0 || youthCount < 0) {
      return Response.json({ error: "인원 수를 확인해주세요." }, { status: 400 });
    }
    if (totalCount < 1 || totalCount > 10) {
      return Response.json(
        { error: "전체 인원은 1~10명으로 입력해주세요." },
        { status: 400 },
      );
    }
    if (!teamName || teamName.length > 10) {
      return Response.json({ error: "팀명은 1~10자로 입력해주세요." }, { status: 400 });
    }
    if (!difficulty) {
      return Response.json({ error: "난이도를 선택해주세요." }, { status: 400 });
    }
    if (vehicleLast4 && !/^\d{4}$/.test(vehicleLast4)) {
      return Response.json({ error: "차량번호는 뒤 4자리만 입력해주세요." }, { status: 400 });
    }
    if (body.agreeSafety !== true) {
      return Response.json({ error: "안전 주의사항에 동의해주세요." }, { status: 400 });
    }
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(idempotencyKey)) {
      return Response.json({ error: "예약 요청을 다시 시작해주세요." }, { status: 400 });
    }

    const occupied = await listOccupiedSlots(scheduledDate);
    const occupiedKeys = new Set(
      occupied.map((slot) => `${slot.roomCode}|${slot.time}`),
    );
    const minimumTime = nextBookableTime();
    const scheduledTime =
      OPERATING_SLOTS.find(
        (time) =>
          time >= minimumTime &&
          !occupiedKeys.has(`${roomCode}|${time}`),
      ) ?? "";

    if (!scheduledTime) {
      return Response.json(
        { error: "선택한 방은 오늘 예약 가능한 시간이 없습니다." },
        { status: 409 },
      );
    }

    const pricing = await getPricingSettings();
    const result = await createWebReservation({
      scheduledDate,
      scheduledTime,
      roomCode,
      teamName,
      difficultyCode: difficulty.code,
      difficultyLabel: difficulty.label,
      mapIndex: difficulty.mapIndex,
      adultCount,
      youthCount,
      totalCount,
      vehicleLast4,
      consentText:
        "필수안내를 확인했고 동의합니다. 부주의로 인한 사고·부상 및 LED로 인한 어지러움/구토 등의 증상 발생 시, 이에 대한 책임은 이용자에게 있습니다.",
      baseAmount: calculateBaseAmount(adultCount, youthCount, pricing),
      idempotencyKey,
    });
    if (result.created && vehicleLast4) {
      await queueAutomaticParkingRegistration(result.reservation, "customer-web");
    }
    const reservation = await getReservationById(result.reservation.id) ?? result.reservation;

    return Response.json(
      {
        bookingCode: reservation.bookingCode,
        reservation,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("active_slot_key") || message.includes("UNIQUE constraint")) {
      return Response.json(
        { error: "방금 다른 예약이 접수된 시간입니다. 다른 시간이나 방을 선택해주세요." },
        { status: 409 },
      );
    }
    return Response.json(
      { error: "예약 접수 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요." },
      { status: 500 },
    );
  }
}
