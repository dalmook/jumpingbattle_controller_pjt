import {
  DEFAULT_PRICING_SETTINGS,
  calculateConfiguredBaseAmount,
  type PricingSettings,
} from "./pricing-config.ts";

export const GAME_DURATION_MINUTES = 16;
export const ACTUAL_PLAY_MINUTES = 15;
export const SLOT_INTERVAL_MINUTES = 20;
export const CUSTOMER_CURRENT_SLOT_LAST_MINUTE = 3;

export const ADULT_PRICE = DEFAULT_PRICING_SETTINGS.adultPrice;
export const YOUTH_PRICE = DEFAULT_PRICING_SETTINGS.youthPrice;
export const NAVER_CANCELLATION_FEE_AMOUNT =
  DEFAULT_PRICING_SETTINGS.naverCancellationFeeAmount;

export const ROOM_OPTIONS = [
  { code: "C2", roomId: "3", name: "소형 C2", size: "소형", min: 2, max: 4 },
  { code: "B1", roomId: "2", name: "대형 B1", size: "대형", min: 4, max: 8 },
  { code: "C1", roomId: "1", name: "소형 C1", size: "소형", min: 2, max: 4 },
  { code: "A1", roomId: "0", name: "중형 A1", size: "중형", min: 2, max: 6 },
] as const;

export const DIFFICULTY_OPTIONS = [
  { code: "kids", legacy: "ㅋ키즈", label: "키즈", stars: "☆", description: "유아와 함께라면 키즈", mapIndex: 8 },
  { code: "basic", legacy: "ㅂ베이직", label: "베이직", stars: "★", description: "처음이라면 베이직", mapIndex: 1 },
  { code: "summer", legacy: "ㄹ여름", label: "여름", stars: "★½", description: "여름 테마 · 이지 수준", mapIndex: 7 },
  { code: "easy", legacy: "ㅇ이지", label: "이지", stars: "★★", description: "처음이지만 센스가 있다면", mapIndex: 2 },
  { code: "space", legacy: "ㅅ우주", label: "우주", stars: "★★½", description: "이지보다 살짝 높은 단계", mapIndex: 6 },
  { code: "normal", legacy: "ㄴ노멀", label: "노멀", stars: "★★★", description: "운동을 즐기는 팀", mapIndex: 3 },
  { code: "santa", legacy: "ㅌ산타", label: "산타", stars: "★★★", description: "산타 테마 고난도 점핑", mapIndex: 9 },
  { code: "hard", legacy: "ㅎ하드", label: "하드", stars: "★★★★", description: "어려운 난이도에 도전", mapIndex: 4 },
  { code: "challenger", legacy: "ㅊ챌린저", label: "챌린저", stars: "★★★★★", description: "최고 난이도", mapIndex: 5 },
] as const;

// B1 is a dual-mode large room.  Its manager combo contains ten large-mode
// entries first (the ninth public maps plus a development-test entry), then
// the same ten medium-mode entries.  Public/admin map indexes therefore need
// a +10 offset for B1 medium mode even though the test maps are not shown.
export const B1_MEDIUM_DIFFICULTY_OPTIONS = [
  { code: "b1-medium-kids", legacy: "중형-키즈맵", label: "중형 · 키즈", stars: "★", description: "유아와 함께라면 키즈", mapIndex: 18 },
  { code: "b1-medium-basic", legacy: "중형-Basic", label: "중형 · 베이직", stars: "★", description: "처음이라면 베이직", mapIndex: 11 },
  { code: "b1-medium-summer", legacy: "중형-여름맵", label: "중형 · 여름", stars: "★☆", description: "여름 테마", mapIndex: 17 },
  { code: "b1-medium-easy", legacy: "중형-Easy", label: "중형 · 이지", stars: "★★", description: "베이직보다 한 단계 위", mapIndex: 12 },
  { code: "b1-medium-space", legacy: "중형-우주맵", label: "중형 · 우주", stars: "★★☆", description: "우주 테마", mapIndex: 16 },
  { code: "b1-medium-normal", legacy: "중형-Normal", label: "중형 · 노멀", stars: "★★★", description: "활동적인 난이도", mapIndex: 13 },
  { code: "b1-medium-santa", legacy: "중형-산타맵", label: "중형 · 산타", stars: "★★★", description: "산타 테마", mapIndex: 19 },
  { code: "b1-medium-hard", legacy: "중형-HARD", label: "중형 · 하드", stars: "★★★★", description: "어려운 도전", mapIndex: 14 },
  { code: "b1-medium-challenger", legacy: "중형-챌린저", label: "중형 · 챌린저", stars: "★★★★☆", description: "최고 난이도", mapIndex: 15 },
] as const;

export const B1_DIFFICULTY_OPTIONS = [
  ...DIFFICULTY_OPTIONS.map((difficulty) => ({
    ...difficulty,
    label: `대형 · ${difficulty.label}`,
  })),
  ...B1_MEDIUM_DIFFICULTY_OPTIONS,
] as const;

const ALL_DIFFICULTY_OPTIONS = [
  ...DIFFICULTY_OPTIONS,
  ...B1_MEDIUM_DIFFICULTY_OPTIONS,
] as const;

export type RoomCode = (typeof ROOM_OPTIONS)[number]["code"];
export type DifficultyCode = (typeof ALL_DIFFICULTY_OPTIONS)[number]["code"];

export const OPERATING_SLOTS = Array.from({ length: 40 }, (_, index) => {
  const totalMinutes = 10 * 60 + index * SLOT_INTERVAL_MINUTES;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
});

export function getRoom(code: string) {
  return ROOM_OPTIONS.find((room) => room.code === code);
}

export function getDifficulty(code: string) {
  const normalized = code.trim();
  const normalizedLower = normalized.toLowerCase();
  const exact = ALL_DIFFICULTY_OPTIONS.find(
    (difficulty) =>
      difficulty.code === normalizedLower ||
      difficulty.legacy === normalized ||
      difficulty.label === normalized,
  );
  if (exact) return exact;

  const embeddedCode = [...ALL_DIFFICULTY_OPTIONS]
    .sort((left, right) => right.code.length - left.code.length)
    .find((difficulty) => {
      const escapedCode = difficulty.code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        `(^|[^a-z0-9-])${escapedCode}(?=$|[^a-z0-9-])`,
      ).test(normalizedLower);
    });
  return embeddedCode ?? ALL_DIFFICULTY_OPTIONS.find(
    (difficulty) => normalized.includes(difficulty.label),
  );
}

export function getDifficultyOptions(roomCode: string) {
  return roomCode === "B1" ? B1_DIFFICULTY_OPTIONS : DIFFICULTY_OPTIONS;
}

export function resolveReservationDifficultyCode(
  difficultyCode: string,
  difficultyLabel: string,
  roomCode: string,
) {
  const resolved = getDifficulty(difficultyCode) ?? getDifficulty(difficultyLabel);
  return resolved && getDifficultyOptions(roomCode).some(
    (difficulty) => difficulty.code === resolved.code,
  )
    ? resolved.code
    : "basic";
}

export function calculateBaseAmount(
  adultCount: number,
  youthCount: number,
  pricing: PricingSettings = DEFAULT_PRICING_SETTINGS,
) {
  return calculateConfiguredBaseAmount(adultCount, youthCount, pricing);
}

export function dateInSeoul(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function naverSameDayCancellationFee(reservation: {
  source: string;
  status: string;
  scheduledDate: string;
  cancelledAt: string;
}, cancellationFeeAmount = NAVER_CANCELLATION_FEE_AMOUNT) {
  if (
    reservation.source !== "naver" ||
    reservation.status !== "cancelled" ||
    !reservation.scheduledDate ||
    !reservation.cancelledAt
  ) {
    return 0;
  }

  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(reservation.cancelledAt)
    ? reservation.cancelledAt
    : `${reservation.cancelledAt.replace(" ", "T")}Z`;
  const cancelledAt = new Date(normalized);
  if (!Number.isFinite(cancelledAt.getTime())) return 0;

  return dateInSeoul(cancelledAt) === reservation.scheduledDate
    ? cancellationFeeAmount
    : 0;
}

export function timeInSeoul(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

export function addDays(dateText: string, days: number) {
  const date = new Date(`${dateText}T12:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateInSeoul(date);
}

export function nextBookableTime(now = new Date()) {
  const [hour, minute] = timeInSeoul(now).split(":").map(Number);
  const totalMinutes = hour * 60 + minute;
  const currentSlot =
    Math.floor(totalMinutes / SLOT_INTERVAL_MINUTES) * SLOT_INTERVAL_MINUTES;
  const elapsedMinutes = totalMinutes - currentSlot;
  const bookableMinutes =
    elapsedMinutes <= CUSTOMER_CURRENT_SLOT_LAST_MINUTE
      ? currentSlot
      : currentSlot + SLOT_INTERVAL_MINUTES;
  return `${String(Math.floor(bookableMinutes / 60)).padStart(2, "0")}:${String(bookableMinutes % 60).padStart(2, "0")}`;
}

export type ReservationRecord = {
  id: string;
  bookingCode: string;
  source: string;
  sourceBookingNo: string;
  customerName: string;
  customerPhone: string;
  memberId: string;
  repeatGroupId: string;
  repeatSequence: number;
  scheduledDate: string;
  scheduledTime: string;
  roomCode: string;
  teamName: string;
  difficultyCode: string;
  difficultyLabel: string;
  mapIndex: number;
  adultCount: number;
  youthCount: number;
  totalCount: number;
  vehicleLast4: string;
  parkingRegistrationStatus: string;
  parkingRegistrationRequestId: string;
  parkingRegisteredVehicleLast4: string;
  parkingRegistrationCompletedAt: string;
  gameMinutes: number;
  baseAmount: number;
  addOnAmount: number;
  discountAmount: number;
  paymentAmount: number;
  paymentCardAmount: number;
  paymentCashAmount: number;
  paymentAccountAmount: number;
  paymentCouponAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  status: string;
  cancelledAt: string;
  memo: string;
  managerLoadedAt: string;
  createdAt: string;
  updatedAt: string;
};
