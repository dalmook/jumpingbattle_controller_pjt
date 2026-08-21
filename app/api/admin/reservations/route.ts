import { getOperator } from "@/app/operator";
import {
  OPERATING_SLOTS,
  calculateBaseAmount,
  dateInSeoul,
  getDifficulty,
  getRoom,
} from "@/app/reservation-config";
import {
  copyReservationToNextSlot,
  copyReservationToSlot,
  createAdminReservation,
  deleteClosedReservation,
  getReservationById,
  listReservations,
  type ReservationAdminAction,
  updateReservation,
} from "@/db/reservations";
import { getPricingSettings } from "@/db/pricing-settings";
import type { PricingSettings } from "@/app/pricing-config";
import { queueAutomaticParkingRegistration } from "@/db/parking-registration";

const PAYMENT_METHODS = new Set(["card", "cash", "account", "coupon", "mixed"]);

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function safeAmount(value: unknown) {
  const amount = Math.trunc(Number(value));
  return Number.isFinite(amount) ? Math.max(0, Math.min(10_000_000, amount)) : 0;
}

export async function GET(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const date = new URL(request.url).searchParams.get("date") ?? dateInSeoul();
  if (!validDate(date)) return Response.json({ error: "날짜 형식이 올바르지 않습니다." }, { status: 400 });

  try {
    return Response.json({ date, reservations: await listReservations(date) });
  } catch {
    return Response.json({ error: "예약 목록을 불러오지 못했습니다." }, { status: 500 });
  }
}

function readBookingDetails(
  body: Record<string, unknown>,
  pricing: PricingSettings,
) {
  const scheduledDate = String(body.scheduledDate ?? "");
  const scheduledTime = String(body.scheduledTime ?? "");
  const roomCode = String(body.roomCode ?? "");
  const teamName = String(body.teamName ?? "").trim();
  const difficulty = getDifficulty(String(body.difficultyCode ?? ""));
  const adultCount = Math.trunc(Number(body.adultCount));
  const youthCount = Math.trunc(Number(body.youthCount));
  const totalCount = adultCount + youthCount;
  const vehicleLast4 = String(body.vehicleLast4 ?? "").trim();
  const memo = String(body.memo ?? "").trim().slice(0, 500);
  const room = roomCode ? getRoom(roomCode) : undefined;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) return { error: "운영 날짜를 확인해주세요." } as const;
  if (!OPERATING_SLOTS.includes(scheduledTime)) return { error: "운영 시간을 확인해주세요." } as const;
  if (roomCode && !room) return { error: "방을 다시 선택해주세요." } as const;
  if (!Number.isInteger(adultCount) || !Number.isInteger(youthCount) || adultCount < 0 || youthCount < 0) return { error: "인원을 확인해주세요." } as const;
  if (totalCount < 1 || totalCount > 10) return { error: "전체 인원은 1~10명으로 입력해주세요." } as const;
  if (!teamName || teamName.length > 10) return { error: "팀명은 1~10자로 입력해주세요." } as const;
  if (!difficulty) return { error: "난이도를 선택해주세요." } as const;
  if (vehicleLast4 && !/^\d{4}$/.test(vehicleLast4)) return { error: "차량번호 뒤 4자리를 확인해주세요." } as const;

  return {
    value: {
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
      baseAmount: calculateBaseAmount(adultCount, youthCount, pricing),
      memo,
    },
  } as const;
}

export async function POST(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (body.copyFromId) {
      const copyFromId = String(body.copyFromId);
      if (!/^[0-9a-f-]{36}$/i.test(copyFromId)) {
        return Response.json({ error: "복사할 예약 번호가 올바르지 않습니다." }, { status: 400 });
      }
      const scheduledDate = String(body.scheduledDate ?? "");
      const scheduledTime = String(body.scheduledTime ?? "");
      const roomCode = String(body.roomCode ?? "");
      const hasDropTarget = Boolean(scheduledDate || scheduledTime || roomCode);
      if (hasDropTarget) {
        if (!validDate(scheduledDate)) {
          return Response.json({ error: "복사할 날짜를 확인해주세요." }, { status: 400 });
        }
        if (!OPERATING_SLOTS.includes(scheduledTime)) {
          return Response.json({ error: "복사할 시간대를 확인해주세요." }, { status: 400 });
        }
        if (!getRoom(roomCode)) {
          return Response.json({ error: "복사할 방을 선택해주세요." }, { status: 400 });
        }
      }
      const reservation = hasDropTarget
        ? await copyReservationToSlot(
            copyFromId,
            scheduledDate,
            scheduledTime,
            roomCode,
            operator.email,
          )
        : await copyReservationToNextSlot(copyFromId, operator.email);
      if (!reservation) {
        return Response.json({ error: "복사할 예약을 찾지 못했습니다." }, { status: 404 });
      }
      return Response.json({ reservation }, { status: 201 });
    }
    const details = readBookingDetails(body, await getPricingSettings());
    if ("error" in details) return Response.json({ error: details.error }, { status: 400 });
    const reservation = await createAdminReservation(details.value, operator.email);
    if (reservation.vehicleLast4) {
      await queueAutomaticParkingRegistration(reservation, operator.email);
    }
    return Response.json(
      { reservation: await getReservationById(reservation.id) ?? reservation },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "NO_NEXT_SLOT") {
      return Response.json({ error: "마지막 운영 시간이라 다음 타임을 만들 수 없습니다." }, { status: 400 });
    }
    if (error instanceof Error && error.message === "CANCELLED_RESERVATION") {
      return Response.json({ error: "취소된 예약은 복사할 수 없습니다." }, { status: 400 });
    }
    if (error instanceof Error && error.message.includes("active_slot_key")) {
      return Response.json({ error: "이 시간의 방에는 이미 예약이 있습니다. 추가·대기 칸으로 입력해주세요." }, { status: 409 });
    }
    return Response.json({ error: "직접 예약 입력 중 문제가 발생했습니다." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const id = String(body.id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return Response.json({ error: "예약 번호가 올바르지 않습니다." }, { status: 400 });
    }
    const deleted = await deleteClosedReservation(id);
    if (!deleted) return Response.json({ error: "삭제할 예약을 찾지 못했습니다." }, { status: 404 });
    return Response.json({ deleted: true, id });
  } catch (error) {
    if (error instanceof Error && error.message === "ACTIVE_RESERVATION") {
      return Response.json(
        { error: "진행 중인 예약은 먼저 완료 또는 취소 처리해주세요." },
        { status: 409 },
      );
    }
    return Response.json({ error: "예약 기록을 삭제하지 못했습니다." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const id = String(body.id ?? "");
    const action = String(body.action ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return Response.json({ error: "예약 번호가 올바르지 않습니다." }, { status: 400 });
    }

    let command: ReservationAdminAction;
    const before = action === "details" ? await getReservationById(id) : null;
    if (["arrive", "undo_arrive", "complete", "cancel", "manager_loaded"].includes(action)) {
      command = {
        action: action as
          | "arrive"
          | "undo_arrive"
          | "complete"
          | "cancel"
          | "manager_loaded",
      };
    } else if (action === "assign") {
      const roomCode = String(body.roomCode ?? "");
      if (!getRoom(roomCode)) return Response.json({ error: "배정할 방을 선택해주세요." }, { status: 400 });
      command = { action: "assign", roomCode };
    } else if (action === "move") {
      const scheduledDate = String(body.scheduledDate ?? "");
      const scheduledTime = String(body.scheduledTime ?? "");
      const roomCode = String(body.roomCode ?? "");
      if (!validDate(scheduledDate)) return Response.json({ error: "이동할 날짜를 확인해주세요." }, { status: 400 });
      if (!OPERATING_SLOTS.includes(scheduledTime)) return Response.json({ error: "이동할 시간대를 확인해주세요." }, { status: 400 });
      if (!getRoom(roomCode)) return Response.json({ error: "이동할 방을 선택해주세요." }, { status: 400 });
      command = { action: "move", scheduledDate, scheduledTime, roomCode };
    } else if (action === "details") {
      const details = readBookingDetails(
        { ...body, scheduledDate: body.scheduledDate, scheduledTime: body.scheduledTime },
        await getPricingSettings(),
      );
      if ("error" in details) return Response.json({ error: details.error }, { status: 400 });
      command = { action: "details", ...details.value };
    } else if (action === "memo") {
      command = { action: "memo", memo: String(body.memo ?? "").trim().slice(0, 500) };
    } else if (action === "payment") {
      const paymentMethod = String(body.paymentMethod ?? "");
      if (!PAYMENT_METHODS.has(paymentMethod)) {
        return Response.json({ error: "결제 수단을 선택해주세요." }, { status: 400 });
      }
      command = {
        action: "payment",
        addOnAmount: safeAmount(body.addOnAmount),
        discountAmount: safeAmount(body.discountAmount),
        paymentAmount: safeAmount(body.paymentAmount),
        paymentCardAmount: safeAmount(body.paymentCardAmount),
        paymentCashAmount: safeAmount(body.paymentCashAmount),
        paymentAccountAmount: safeAmount(body.paymentAccountAmount),
        paymentMethod,
      };
    } else {
      return Response.json({ error: "지원하지 않는 처리입니다." }, { status: 400 });
    }

    let reservation = await updateReservation(id, command, operator.email);
    if (!reservation) return Response.json({ error: "예약을 찾지 못했습니다." }, { status: 404 });
    if (
      command.action === "details" &&
      before?.vehicleLast4 !== reservation.vehicleLast4 &&
      reservation.vehicleLast4
    ) {
      await queueAutomaticParkingRegistration(reservation, operator.email);
      reservation = await getReservationById(id) ?? reservation;
    }
    return Response.json({ reservation });
  } catch (error) {
    if (error instanceof Error && error.message === "PAYMENT_SPLIT_MISMATCH") {
      return Response.json(
        { error: "카드·현금·계좌 금액의 합계가 현장 결제할 금액과 같아야 합니다." },
        { status: 400 },
      );
    }
    if (error instanceof Error && error.message.includes("active_slot_key")) {
      return Response.json({ error: "같은 시간에 이미 배정된 방입니다." }, { status: 409 });
    }
    return Response.json({ error: "예약 처리 중 문제가 발생했습니다." }, { status: 500 });
  }
}
