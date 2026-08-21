import type { ReservationRecord } from "@/app/reservation-config";
import { supportsParkingCommands } from "./bridge-capabilities";
import { ensureControlSchema, getControlAgentId, getD1 } from "./control";
import {
  createParkingDiscountRequest,
  getParkingDiscountRequest,
  getParkingDiscountRequestByIdempotency,
  type ParkingDiscountRequest,
} from "./parking-discounts";
import { getParkingSettings } from "./parking-settings";

type AgentRow = { version: string; online: number };

export class ParkingRegistrationError extends Error {
  constructor(
    message: string,
    readonly code: "AUTO_DISABLED" | "INVALID_VEHICLE" | "CANCELLED" | "BRIDGE_OFFLINE" | "BRIDGE_VERSION",
  ) {
    super(message);
  }
}

export async function queueParkingRegistration(input: {
  reservation: ReservationRecord;
  requestedBy: string;
  triggerMode: "auto" | "manual";
  idempotencyKey?: string;
  requireOnline?: boolean;
}): Promise<ParkingDiscountRequest> {
  const carLast4 = input.reservation.vehicleLast4.trim();
  const explicitIdempotencyKey = input.idempotencyKey?.trim() ?? "";
  if (!/^\d{4}$/.test(carLast4)) {
    throw new ParkingRegistrationError("차량번호 뒤 4자리를 확인해주세요.", "INVALID_VEHICLE");
  }
  if (input.reservation.status === "cancelled") {
    throw new ParkingRegistrationError("취소된 예약은 주차등록을 할 수 없습니다.", "CANCELLED");
  }

  if (
    !explicitIdempotencyKey &&
    input.reservation.parkingRegistrationStatus === "SUCCESS" &&
    input.reservation.parkingRegisteredVehicleLast4 === carLast4
  ) {
    const completed = input.reservation.parkingRegistrationRequestId
      ? await getParkingDiscountRequest(input.reservation.parkingRegistrationRequestId)
      : null;
    if (completed) return completed;
  }

  const settings = await getParkingSettings();
  if (input.triggerMode === "auto" && !settings.autoRegistrationEnabled) {
    throw new ParkingRegistrationError("주차 자동등록이 꺼져 있습니다.", "AUTO_DISABLED");
  }

  const idempotencyKey = explicitIdempotencyKey ||
    `parking:${input.triggerMode}:${input.reservation.id}:${carLast4}`;
  const existing = await getParkingDiscountRequestByIdempotency(idempotencyKey);
  if (existing) return existing;

  await ensureControlSchema();
  const agent = await getD1().prepare(`
    SELECT version,
      CASE WHEN last_seen > datetime('now', '-25 seconds') THEN 1 ELSE 0 END AS online
    FROM agents ORDER BY last_seen DESC LIMIT 1
  `).first<AgentRow>();
  if (input.requireOnline !== false && agent?.online !== 1) {
    throw new ParkingRegistrationError("매장 브릿지가 오프라인입니다.", "BRIDGE_OFFLINE");
  }
  if (!supportsParkingCommands(agent?.version ?? "")) {
    throw new ParkingRegistrationError("주차등록을 지원하는 매장 브릿지가 필요합니다.", "BRIDGE_VERSION");
  }

  const id = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  try {
    const created = await createParkingDiscountRequest({
      id,
      idempotencyKey,
      reservationId: input.reservation.id,
      triggerMode: input.triggerMode,
      carLast4,
      requestedBy: input.requestedBy,
      commandId,
      agentId: getControlAgentId(),
    });
    if (!created) throw new Error("주차등록 요청을 저장하지 못했습니다.");
    return created;
  } catch (error) {
    const duplicate = await getParkingDiscountRequestByIdempotency(idempotencyKey);
    if (duplicate) return duplicate;
    throw error;
  }
}

export async function queueAutomaticParkingRegistration(
  reservation: ReservationRecord,
  requestedBy: string,
) {
  if (!/^\d{4}$/.test(reservation.vehicleLast4)) return null;
  try {
    return await queueParkingRegistration({
      reservation,
      requestedBy,
      triggerMode: "auto",
      requireOnline: false,
    });
  } catch (error) {
    if (error instanceof ParkingRegistrationError && error.code === "AUTO_DISABLED") return null;
    console.error("주차 자동등록 요청을 만들지 못했습니다.", {
      reservationId: reservation.id,
      code: error instanceof ParkingRegistrationError ? error.code : "UNKNOWN",
    });
    return null;
  }
}
