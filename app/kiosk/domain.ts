export const KIOSK_SESSION_IDLE_MS = 90_000;
export const KIOSK_HOLD_MS = 180_000;

export const CUSTOMER_VISIT_STATES = [
  "DRAFT", "HOLD", "PAYMENT_PENDING", "WAITING_STAFF_CONFIRMATION", "PREPARING", "READY_TO_PLAY", "PLAYING",
  "COMPLETED", "ABORTED", "ERROR", "START_FAILED", "STAFF_REVIEW", "CANCELLED", "EXPIRED",
] as const;

export type CustomerVisitState = (typeof CUSTOMER_VISIT_STATES)[number];

export type KioskPaymentMethod = "card" | "cash" | "account";
export type KioskPaymentMode = "single" | "equal" | "custom";

export function calculateParticipantTopUp(input: {
  currentAdultCount: number;
  currentYouthCount: number;
  additionalAdultCount: number;
  additionalYouthCount: number;
  adultPrice: number;
  youthPrice: number;
  maximumPartyCount?: number;
}) {
  const currentAdultCount = Math.max(0, Math.trunc(Number(input.currentAdultCount) || 0));
  const currentYouthCount = Math.max(0, Math.trunc(Number(input.currentYouthCount) || 0));
  const additionalAdultCount = Math.max(0, Math.trunc(Number(input.additionalAdultCount) || 0));
  const additionalYouthCount = Math.max(0, Math.trunc(Number(input.additionalYouthCount) || 0));
  const additionalCount = additionalAdultCount + additionalYouthCount;
  const targetAdultCount = currentAdultCount + additionalAdultCount;
  const targetYouthCount = currentYouthCount + additionalYouthCount;
  const targetPartyCount = targetAdultCount + targetYouthCount;
  const maximumPartyCount = Math.max(1, Math.trunc(Number(input.maximumPartyCount) || 10));
  if (additionalCount < 1) throw new Error("KIOSK_PARTICIPANT_TOP_UP_EMPTY");
  if (targetPartyCount > maximumPartyCount) throw new Error("KIOSK_PARTY_INVALID");
  return {
    currentAdultCount,
    currentYouthCount,
    additionalAdultCount,
    additionalYouthCount,
    additionalCount,
    targetAdultCount,
    targetYouthCount,
    targetPartyCount,
    amount:
      additionalAdultCount * Math.max(0, Math.trunc(Number(input.adultPrice) || 0)) +
      additionalYouthCount * Math.max(0, Math.trunc(Number(input.youthPrice) || 0)),
  };
}

export function splitKioskEqualAmount(amount: number, count: number) {
  const due = Math.max(0, Math.trunc(Number(amount) || 0));
  const normalizedCount = Math.max(2, Math.min(10, Math.trunc(Number(count) || 2)));
  const quotient = Math.floor(due / normalizedCount);
  const remainder = due % normalizedCount;
  return Array.from(
    { length: normalizedCount },
    (_, index) => quotient + (index < remainder ? 1 : 0),
  );
}

export function isPaymentOrGameCritical(state: string) {
  return ["PAYMENT_PENDING", "WAITING_STAFF_CONFIRMATION", "PREPARING", "READY_TO_PLAY", "PLAYING"].includes(state);
}

export function paidGameParticipantCount(input: {
  partyCount: number;
  benefitType?: string;
  benefitUses?: number;
  passUses?: number;
  couponUses?: number;
  addOnOnly?: boolean;
}) {
  if (input.addOnOnly) return 0;
  const partyCount = Math.max(0, Math.trunc(Number(input.partyCount) || 0));
  const explicitUses = Math.max(0, Math.trunc(Number(input.passUses) || 0)) +
    Math.max(0, Math.trunc(Number(input.couponUses) || 0));
  const legacyUses = ["pass", "coupon"].includes(String(input.benefitType ?? ""))
    ? Math.max(0, Math.trunc(Number(input.benefitUses) || 0))
    : 0;
  const excluded = explicitUses || legacyUses;
  return Math.max(0, partyCount - Math.min(partyCount, excluded));
}

export function stampAwardQuantity(input: Parameters<typeof paidGameParticipantCount>[0] & {
  stampsPerParticipant?: number;
}) {
  const stampsPerParticipant = Math.max(0, Math.trunc(Number(input.stampsPerParticipant) || 0));
  return paidGameParticipantCount(input) * stampsPerParticipant;
}

export function normalizeKioskPaymentItems(
  amount: number,
  items: Array<{ amount?: unknown; paymentMethod?: unknown }> | undefined,
) {
  const due = Math.max(0, Math.trunc(Number(amount) || 0));
  if (due === 0) return [];
  const allowed = new Set(["card", "cash", "account"]);
  const normalized = (Array.isArray(items) ? items : [])
    .map((item) => ({
      amount: Math.max(0, Math.trunc(Number(item?.amount) || 0)),
      paymentMethod: String(item?.paymentMethod ?? "").trim().toLowerCase(),
    }))
    .filter((item) => item.amount > 0 && allowed.has(item.paymentMethod));
  if (!normalized.length) return [{ amount: due, paymentMethod: "card" }];
  if (normalized.length > 20) {
    throw new Error("KIOSK_PAYMENT_ITEMS_INVALID");
  }
  if (normalized.reduce((sum, item) => sum + item.amount, 0) !== due) {
    throw new Error("KIOSK_PAYMENT_TOTAL_MISMATCH");
  }
  return normalized;
}

export function canCustomerStart(input: {
  state: string;
  roomStatus: string;
  hasDifficulty: boolean;
  tokenMatches: boolean;
  tokenExpiresAt: number;
  now: number;
}) {
  return input.state === "READY_TO_PLAY" &&
    ["waiting", "idle", "ready"].includes(input.roomStatus) &&
    input.hasDifficulty && input.tokenMatches && input.tokenExpiresAt > input.now;
}

export function holdSecondsRemaining(expiresAt: string, now = Date.now()) {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - now) / 1000)) : 0;
}

export function parkingSessionPhase(nowAt: number, endsAt: number, warningSeconds = 15) {
  const remainingMs = Math.max(0, Number(endsAt) - Number(nowAt));
  const remainingSeconds = Math.ceil(remainingMs / 1_000);
  return {
    remainingSeconds,
    warning: remainingMs > 0 && remainingMs <= Math.max(0, warningSeconds) * 1_000,
    expired: remainingMs <= 0,
  };
}

export function kioskSlotStartsAfterRunningGame(input: {
  roomStatus: string;
  slotStartAt: number;
  nowAt?: number;
  remainingSeconds?: number;
  endsAt?: string | number | null;
}) {
  if (input.roomStatus !== "running") return true;
  const slotStartAt = Number(input.slotStartAt);
  if (!Number.isFinite(slotStartAt)) return false;
  const nowAt = Number.isFinite(Number(input.nowAt)) ? Number(input.nowAt) : Date.now();
  const remainingSeconds = Math.max(0, Number(input.remainingSeconds) || 0);
  const explicitEndAt = typeof input.endsAt === "number"
    ? input.endsAt
    : Date.parse(String(input.endsAt ?? ""));
  const projectedEndAt = Math.max(
    nowAt + 1,
    nowAt + remainingSeconds * 1_000,
    Number.isFinite(explicitEndAt) ? explicitEndAt : 0,
  );
  return slotStartAt >= projectedEndAt;
}
