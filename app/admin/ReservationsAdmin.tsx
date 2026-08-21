"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  GAME_DURATION_MINUTES,
  OPERATING_SLOTS,
  ROOM_OPTIONS,
  SLOT_INTERVAL_MINUTES,
  dateInSeoul,
  getDifficulty,
  getDifficultyOptions,
  getRoom,
  resolveReservationDifficultyCode,
  naverSameDayCancellationFee,
  timeInSeoul,
  type ReservationRecord,
} from "../reservation-config";
import {
  sharedSalesUnitPrices,
  type PricingSettings,
  type SharedSalesCategory,
} from "../pricing-config";
import {
  allocateMemberCoupons,
  buildMemberCouponSlots,
} from "../member-coupon-allocation";
import type {
  ControlAction,
  PaymentAttempt,
  PaymentOverview,
  SignedPaymentIntent,
  Room,
  StatusResponse,
} from "../types";
import { calculateNextGameAvailability } from "./availability";
import {
  correctedRemainingSeconds,
  databaseTimestamp,
} from "./controller-time";
import { currentOperatingSlot } from "./schedule-time";
import { BottomSheet } from "./v2/ui";
import { formatPaymentTimeInSeoul } from "./payment-time";
import { unclassifiedReservationPaymentAmount } from "./sales-classification";
import { decidePaymentTransport } from "../payment-transport";
import {
  mergeMinimalPaymentProgress,
  paymentOverviewCoversProgress,
  type MinimalNextSplitResult,
} from "../payment-progress";

const STATUS_LABELS: Record<string, string> = {
  booked: "예약",
  arrived: "입장",
  completed: "완료",
  cancelled: "취소",
};

const PAYMENT_LABELS: Record<string, string> = {
  card: "카드",
  cash: "현금",
  account: "계좌이체",
  coupon: "쿠폰",
  mixed: "복합결제",
};

const ROOM_STATUS_LABELS: Record<Room["status"], string> = {
  offline: "연결 없음",
  waiting: "대기",
  running: "게임 중",
  error: "확인 필요",
};

const SCHEDULE_ROOM_CODES = ["C2", "B1", "C1", "A1"];
const CONTROL_PIN_STORAGE_KEY = "jumping-admin-control-pinned";
const LOCAL_PAYMENT_HEALTH_CACHE_TTL_MS = 3_000;

type ParkingRequestStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCESS"
  | "SKIPPED"
  | "NOT_FOUND"
  | "DISABLED"
  | "SESSION_EXPIRED"
  | "LIMIT_EXCEEDED"
  | "INVALID_DISCOUNT"
  | "AMBIGUOUS_RESULT"
  | "NEEDS_REVIEW"
  | "FAILED";

type ParkingDiscountRequestView = {
  id: string;
  status: ParkingRequestStatus;
  matchCount: number;
  dryRun: boolean;
  errorMessage: string;
  results: Array<{
    status: ParkingRequestStatus;
    message: string;
    carNo: string;
  }>;
};

const PARKING_PENDING_STATUSES = new Set<ParkingRequestStatus>(["PENDING", "PROCESSING"]);
const PARKING_MANUAL_REQUIRED_STATUSES = new Set<ParkingRequestStatus>([
  "NOT_FOUND",
  "DISABLED",
  "SESSION_EXPIRED",
  "INVALID_DISCOUNT",
  "AMBIGUOUS_RESULT",
  "NEEDS_REVIEW",
  "FAILED",
]);

function parkingRegistrationComplete(reservation: ReservationRecord | undefined, vehicleLast4?: string) {
  if (!reservation) return false;
  const vehicle = (vehicleLast4 ?? reservation.vehicleLast4).trim();
  return reservation.parkingRegistrationStatus === "SUCCESS" &&
    reservation.parkingRegisteredVehicleLast4 === vehicle &&
    /^\d{4}$/.test(vehicle);
}

function parkingRegistrationPending(reservation: ReservationRecord | undefined, vehicleLast4?: string) {
  if (!reservation) return false;
  const vehicle = (vehicleLast4 ?? reservation.vehicleLast4).trim();
  return PARKING_PENDING_STATUSES.has(reservation.parkingRegistrationStatus as ParkingRequestStatus) &&
    reservation.vehicleLast4 === vehicle;
}

function parkingRegistrationNeedsManual(reservation: ReservationRecord | undefined, vehicleLast4?: string) {
  if (!reservation) return false;
  const vehicle = (vehicleLast4 ?? reservation.vehicleLast4).trim();
  return PARKING_MANUAL_REQUIRED_STATUSES.has(reservation.parkingRegistrationStatus as ParkingRequestStatus) &&
    reservation.vehicleLast4 === vehicle &&
    /^\d{4}$/.test(vehicle);
}

type FrontendPaymentLatencyEvent = {
  component: "frontend";
  stage: string;
  isoTimestamp: string;
  elapsedMs: number;
  durationMs?: number | null;
  reservationId: string;
  attemptId?: string;
  details?: Record<string, unknown>;
};

type FrontendPaymentTrace = {
  traceId: string;
  startedAt: number;
  events: FrontendPaymentLatencyEvent[];
  flushedCount: number;
  attemptId: string;
  renderScheduled: boolean;
  apiCallSequence: number;
};

type FrontendControlTrace = {
  traceId: string;
  commandId: string;
  startedAt: number;
  stages: Record<string, number>;
};

function newPaymentTraceId() {
  const inSeoul = new Date(Date.now() + 9 * 60 * 60 * 1_000);
  const stamp = inSeoul.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `PAY-${stamp.slice(0, 8)}-${stamp.slice(8)}-${suffix}`;
}

type Mutation =
  | { action: "arrive" | "undo_arrive" | "complete" | "cancel" | "manager_loaded" }
  | { action: "assign"; roomCode: string }
  | { action: "move"; scheduledDate: string; scheduledTime: string; roomCode: string }
  | {
      action: "details";
      scheduledDate: string;
      scheduledTime: string;
      roomCode: string;
      teamName: string;
      difficultyCode: string;
      adultCount: number;
      youthCount: number;
      vehicleLast4: string;
      memo: string;
    }
  | { action: "memo"; memo: string }
  | {
      action: "payment";
      addOnAmount: number;
      discountAmount: number;
      paymentAmount: number;
      paymentCardAmount: number;
      paymentCashAmount: number;
      paymentAccountAmount: number;
      paymentMethod: string;
    };

type BookingOperationDomain = "control" | "payment" | "reservation" | "memo" | "parking";
type BookingOperationState = Record<BookingOperationDomain, string>;

const EMPTY_BOOKING_OPERATIONS: BookingOperationState = {
  control: "",
  payment: "",
  reservation: "",
  memo: "",
  parking: "",
};

function mutationOperationDomain(command: Mutation): BookingOperationDomain {
  if (command.action === "payment") return "payment";
  if (command.action === "memo") return "memo";
  if (command.action === "manager_loaded") return "control";
  return "reservation";
}

function useBookingOperationLocks() {
  const [operations, setOperations] = useState<BookingOperationState>(EMPTY_BOOKING_OPERATIONS);
  const operationsRef = useRef<BookingOperationState>(EMPTY_BOOKING_OPERATIONS);

  const startOperation = useCallback((domain: BookingOperationDomain, action: string) => {
    if (operationsRef.current[domain]) return false;
    const next = { ...operationsRef.current, [domain]: action };
    operationsRef.current = next;
    setOperations(next);
    return true;
  }, []);

  const finishOperation = useCallback((domain: BookingOperationDomain, action: string) => {
    if (operationsRef.current[domain] !== action) return;
    const next = { ...operationsRef.current, [domain]: "" };
    operationsRef.current = next;
    setOperations(next);
  }, []);

  return { operations, startOperation, finishOperation };
}

type BookingFilter = "all" | "unpaid" | "arrived" | "unassigned" | "cancelled";

export type ScheduleSelection = {
  time: string;
  roomCode: string;
  reservation?: ReservationRecord;
};

export type ReservationListChange =
  | { type: "upsert"; reservation: ReservationRecord }
  | { type: "remove"; id: string };

function applyReservationListChange(
  current: ReservationRecord[],
  change: ReservationListChange,
  listDate: string,
) {
  const changedId =
    change.type === "upsert" ? change.reservation.id : change.id;
  const next = current.filter((reservation) => reservation.id !== changedId);

  if (
    change.type === "upsert" &&
    change.reservation.scheduledDate === listDate
  ) {
    next.push(change.reservation);
  }

  return next.sort(
    (left, right) =>
      left.scheduledTime.localeCompare(right.scheduledTime) ||
      left.createdAt.localeCompare(right.createdAt),
  );
}

function sameReservationSnapshot(
  current: ReservationRecord[],
  next: ReservationRecord[],
) {
  return (
    current.length === next.length &&
    current.every(
      (reservation, index) =>
        reservation.id === next[index]?.id &&
        reservation.updatedAt === next[index]?.updatedAt &&
        reservation.parkingRegistrationStatus === next[index]?.parkingRegistrationStatus &&
        reservation.parkingRegistrationRequestId === next[index]?.parkingRegistrationRequestId &&
        reservation.parkingRegisteredVehicleLast4 === next[index]?.parkingRegisteredVehicleLast4,
    )
  );
}

type SharedPaymentMethod = "card" | "cash" | "account";
type PaymentSplit = Record<SharedPaymentMethod, number>;
type DailySharedSales = {
  date: string;
  slush: Record<SharedPaymentMethod, number>;
  beverage: Record<SharedPaymentMethod, number>;
  other: Record<SharedPaymentMethod, number>;
  youthPass10: Record<SharedPaymentMethod, number>;
  youthPass20: Record<SharedPaymentMethod, number>;
  adultPass10: Record<SharedPaymentMethod, number>;
  adultPass20: Record<SharedPaymentMethod, number>;
  updatedAt: string;
};

const SHARED_PAYMENT_METHODS: Array<{
  value: SharedPaymentMethod;
  label: string;
}> = [
  { value: "card", label: "카드" },
  { value: "cash", label: "현금" },
  { value: "account", label: "계좌" },
];

function emptySharedSales(date: string): DailySharedSales {
  return {
    date,
    slush: { card: 0, cash: 0, account: 0 },
    beverage: { card: 0, cash: 0, account: 0 },
    other: { card: 0, cash: 0, account: 0 },
    youthPass10: { card: 0, cash: 0, account: 0 },
    youthPass20: { card: 0, cash: 0, account: 0 },
    adultPass10: { card: 0, cash: 0, account: 0 },
    adultPass20: { card: 0, cash: 0, account: 0 },
    updatedAt: "",
  };
}

function paymentSplitTotal(split: PaymentSplit) {
  return split.card + split.cash + split.account;
}

function paymentSplitForSave(
  paymentMethod: string,
  paymentDue: number,
  mixedSplit: PaymentSplit,
): PaymentSplit {
  if (paymentMethod === "mixed") return mixedSplit;
  return {
    card: paymentMethod === "card" ? paymentDue : 0,
    cash: paymentMethod === "cash" ? paymentDue : 0,
    account: paymentMethod === "account" ? paymentDue : 0,
  };
}

function sharedSalesTotal(
  sales: DailySharedSales,
  unitPrices: Record<SharedSalesCategory, number>,
) {
  return (Object.keys(unitPrices) as SharedSalesCategory[]).reduce(
    (total, category) =>
      total +
      Object.values(sales[category]).reduce((sum, count) => sum + count, 0) *
        unitPrices[category],
    0,
  );
}

function sharedSalesCount(
  sales: DailySharedSales,
  unitPrices: Record<SharedSalesCategory, number>,
) {
  return (Object.keys(unitPrices) as SharedSalesCategory[]).reduce(
    (total, category) =>
      total + Object.values(sales[category]).reduce((sum, count) => sum + count, 0),
    0,
  );
}

function won(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

const TERMINAL_PAYMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "처리 대기",
  PROCESSING: "단말 처리 중",
  APPROVED: "승인 성공",
  COMPLETED: "수납 완료",
  DECLINED: "승인 거절",
  USER_CANCELLED: "사용자 취소",
  CANCELLED: "승인취소 완료",
  UNKNOWN: "결제 결과 확인 필요",
  BUSY: "다른 거래 진행 중",
  ERROR: "결제 연결 오류",
  UNLINKED: "예약 연결 해제",
};

async function reloadReservation(date: string, id: string) {
  const response = await fetch(
    `/api/admin/reservations?date=${encodeURIComponent(date)}`,
    { cache: "no-store" },
  );
  const data = (await response.json()) as {
    reservations?: ReservationRecord[];
  };
  return data.reservations?.find((item) => item.id === id) ?? null;
}

type PaymentCouponOption = {
  id: string;
  couponType: "STAMP_REWARD" | "WEEKDAY_EVENT";
  name: string;
  status: string;
  issuedAt: string;
  expiresAt: string;
};

type AddOnCheckoutSelection = {
  slush: number;
  beverage: number;
  other: number;
  items: Array<{ code: string; quantity: number }>;
};

type AttachedAddOnSaleResponse = {
  reservationId: string;
  salesDate: string;
  summary: string;
  amount: number;
  status: string;
  paymentStatus: string;
  counts: { slush: number; beverage: number; other: number };
  items: Array<{
    code: string;
    name: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
};

export function TerminalPaymentControls({
  reservation,
  amount,
  prepaidDepositAmount = 0,
  addOnAmount,
  addOnSale,
  discountAmount,
  pricing,
  participantCounts,
  disabled,
  beforePay,
  onSettled,
  onAmountLockChange,
  autoResetOnCompleted = false,
}: {
  reservation: ReservationRecord;
  amount: number;
  prepaidDepositAmount?: number;
  addOnAmount: number;
  addOnSale?: AddOnCheckoutSelection;
  discountAmount: number;
  pricing: PricingSettings;
  participantCounts?: { adult: number; youth: number };
  disabled: boolean;
  beforePay?: () => Promise<void>;
  onSettled: () => Promise<void>;
  onAmountLockChange?: (locked: boolean) => void;
  autoResetOnCompleted?: boolean;
}) {
  type DraftItem = {
    amount: number;
    paymentMethod: string;
    memberCouponId?: string;
    couponParticipantType?: "adult" | "youth";
  };
  const initialDepositAmount = Math.min(
    Math.max(0, Math.trunc(prepaidDepositAmount)),
    Math.max(0, amount),
  );
  const [overview, setOverview] = useState<PaymentOverview | null>(null);
  const [groupPaymentEnabled, setGroupPaymentEnabled] = useState(false);
  const [mode, setMode] = useState<"single" | "equal" | "custom">("single");
  const [splitCount, setSplitCount] = useState(2);
  const [draftItems, setDraftItems] = useState<DraftItem[]>([
    { amount: Math.max(0, amount - initialDepositAmount), paymentMethod: "card" },
  ]);
  const [plannerOpen, setPlannerOpen] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [manualAuthNo, setManualAuthNo] = useState("");
  const [manualAuthDate, setManualAuthDate] = useState(dateInSeoul());
  const [externalOpen, setExternalOpen] = useState(false);
  const [externalReviewed, setExternalReviewed] = useState(false);
  const [externalAuthNo, setExternalAuthNo] = useState("");
  const [externalAuthDate, setExternalAuthDate] = useState(dateInSeoul());
  const [externalApprovalTime, setExternalApprovalTime] = useState("");
  const [externalAmount, setExternalAmount] = useState(0);
  const [externalCardName, setExternalCardName] = useState("");
  const [externalCardLast4, setExternalCardLast4] = useState("");
  const [externalTerminalId, setExternalTerminalId] = useState("MPOS-1700AE");
  const [externalReference, setExternalReference] = useState("");
  const [externalReason, setExternalReason] = useState("단말기에서 직접 결제 후 수동 연결");
  const [unlinkTarget, setUnlinkTarget] = useState<PaymentAttempt | null>(null);
  const [unlinkReason, setUnlinkReason] = useState("");
  const [methodPickerIndex, setMethodPickerIndex] = useState<number | null>(null);
  const [retryMethodTarget, setRetryMethodTarget] = useState<PaymentAttempt | null>(null);
  const [pendingMethodTarget, setPendingMethodTarget] = useState<PaymentAttempt | null>(null);
  const [memberCoupons, setMemberCoupons] = useState<PaymentCouponOption[]>([]);
  const [couponSelection, setCouponSelection] = useState<{ contextKey: string; ids: string[] }>({
    contextKey: "",
    ids: [],
  });
  const requestInFlight = useRef(false);
  const plannerInitialized = useRef(false);
  const settledSignature = useRef<string | null>(null);
  const paymentTrace = useRef<FrontendPaymentTrace | null>(null);
  const paymentResultWait = useRef<AbortController | null>(null);
  const paymentProgressFloor = useRef<MinimalNextSplitResult | null>(null);
  const localPaymentHealthCache = useRef<{
    bridgeUrl: string;
    checkedAt: number;
  } | null>(null);

  function beginPaymentTrace(details: Record<string, unknown> = {}) {
    const trace: FrontendPaymentTrace = {
      traceId: newPaymentTraceId(),
      startedAt: performance.now(),
      events: [],
      flushedCount: 0,
      attemptId: "",
      renderScheduled: false,
      apiCallSequence: 0,
    };
    paymentTrace.current = trace;
    markPaymentTrace("FE_CLICK", details);
    return trace;
  }

  function markPaymentTrace(
    stage: string,
    details: Record<string, unknown> = {},
    durationMs?: number,
  ) {
    const trace = paymentTrace.current;
    if (!trace) return;
    const event: FrontendPaymentLatencyEvent = {
      component: "frontend",
      stage,
      isoTimestamp: new Date().toISOString(),
      elapsedMs: Math.round((performance.now() - trace.startedAt) * 1_000) / 1_000,
      durationMs: durationMs == null ? null : Math.round(durationMs * 1_000) / 1_000,
      reservationId: reservation.id,
      attemptId: trace.attemptId,
      details,
    };
    trace.events.push(event);
    console.info(`[PAY TRACE] trace=${trace.traceId} ${stage} +${event.elapsedMs}ms`, details);
  }

  function flushPaymentTrace() {
    const trace = paymentTrace.current;
    if (!trace || trace.flushedCount >= trace.events.length) return;
    const events = trace.events.slice(trace.flushedCount);
    trace.flushedCount = trace.events.length;
    void fetch("/api/admin/payment-latency", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceId: trace.traceId, events }),
      keepalive: true,
    }).then(async (response) => {
      const data = await response.json() as { report?: { text?: string } };
      if (data.report?.text) console.info(data.report.text);
    }).catch(() => {
      trace.flushedCount = Math.max(0, trace.flushedCount - events.length);
    });
  }

  const refreshCoupons = useCallback(async () => {
    if (!reservation.memberId) {
      setMemberCoupons([]);
      return [];
    }
    const response = await fetch(`/api/admin/member-benefits?memberId=${encodeURIComponent(reservation.memberId)}`, { cache: "no-store" });
    const data = await response.json() as { benefits?: { coupons?: PaymentCouponOption[] } };
    const coupons = response.ok ? data.benefits?.coupons ?? [] : [];
    setMemberCoupons(coupons);
    return coupons;
  }, [reservation.memberId]);

  const refresh = useCallback(async () => {
    const trace = paymentTrace.current;
    const pollStarted = performance.now();
    if (trace) markPaymentTrace("FE_RESULT_POLL_START");
    const response = await fetch(
      `/api/admin/payments?reservationId=${encodeURIComponent(reservation.id)}`,
      { cache: "no-store" },
    );
    const responseText = await response.text();
    const data = JSON.parse(responseText) as PaymentOverview & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "결제 상태를 불러오지 못했습니다.");
    const progressFloor = paymentProgressFloor.current;
    if (progressFloor && !paymentOverviewCoversProgress(data, progressFloor)) {
      markPaymentTrace("FULL_OVERVIEW_STALE_IGNORED", {
        paymentId: data.payment?.id ?? "",
        ledgerRevision: progressFloor.ledgerRevision,
      });
      return data;
    }
    if (progressFloor) paymentProgressFloor.current = null;
    setOverview(data);
    if (trace) {
      markPaymentTrace("FE_RESULT_POLL_DONE", {
        method: "GET",
        url: "/api/admin/payments",
        responseBytes: new TextEncoder().encode(responseText).byteLength,
      }, performance.now() - pollStarted);
      const tracedAttempt = data.attempts.find((attempt) => attempt.traceId === trace.traceId);
      if (tracedAttempt) trace.attemptId = tracedAttempt.id;
      const resultReady = Boolean(
        tracedAttempt && !["PENDING", "PROCESSING"].includes(tracedAttempt.status),
      );
      if (resultReady && !trace.renderScheduled) {
        trace.renderScheduled = true;
        markPaymentTrace("FE_STATE_UPDATED", { status: tracedAttempt?.status });
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          markPaymentTrace("FE_RENDER_DONE", { status: tracedAttempt?.status });
          flushPaymentTrace();
        }));
      }
    }
    if (!plannerInitialized.current) {
      plannerInitialized.current = true;
      const shouldGroup = Boolean(
        data.group?.isPaymentGroup ||
        (data.group?.eligible && data.group.items.length > 1),
      );
      setGroupPaymentEnabled(shouldGroup);
      const otherItems = shouldGroup
        ? data.group?.items.filter((item) => item.reservationId !== reservation.id) ?? []
        : [];
      const expectedFinalAmount = amount + otherItems.reduce((sum, item) => sum + item.finalAmount, 0);
      const expectedDepositAmount = initialDepositAmount + otherItems.reduce((sum, item) => sum + item.depositAmount, 0);
      const expectedPayable = Math.max(0, expectedFinalAmount - expectedDepositAmount);
      const savedPlanTotal = data.plan.reduce((sum, payment) => sum + payment.amount, 0);
      const savedPlanMatches = Boolean(
        data.payment &&
          data.payment.finalAmount === expectedFinalAmount &&
          data.payment.depositAmount === expectedDepositAmount &&
          data.payment.payableAmount === expectedPayable &&
          savedPlanTotal === expectedPayable,
      );
      const keepExistingPlan = Boolean(
        data.payment &&
          data.plan.length &&
          (data.summary?.amountLocked || savedPlanMatches),
      );
      setPlannerOpen(!keepExistingPlan);
      const initialPayable = data.summary?.amountLocked
        ? data.summary.payableAmount
        : expectedPayable;
      setDraftItems([{ amount: initialPayable, paymentMethod: "card" }]);
      if (data.payment && data.plan.length && !keepExistingPlan) {
        setMessage("네이버 예약금과 현재 인원 금액을 반영해 결제 계획을 다시 계산했습니다.");
      }
    }
    return data;
  }, [amount, initialDepositAmount, reservation.id]);

  async function waitForPaymentResult(attemptId: string) {
    paymentResultWait.current?.abort();
    const controller = new AbortController();
    paymentResultWait.current = controller;
    const traceId = paymentTrace.current?.traceId ?? "";
    const startedAt = performance.now();
    markPaymentTrace("FE_RESULT_PUSH_START", { attemptId });
    try {
      for (let reconnect = 0; reconnect < 4 && !controller.signal.aborted; reconnect += 1) {
        const response = await fetch(
          `/api/admin/payments/wait?reservationId=${encodeURIComponent(reservation.id)}&attemptId=${encodeURIComponent(attemptId)}&view=minimal`,
          {
            cache: "no-store",
            signal: controller.signal,
            headers: traceId ? { "x-payment-trace-id": traceId } : undefined,
          },
        );
        const responseText = await response.text();
        const data = JSON.parse(responseText) as {
          changed?: boolean;
          overview?: PaymentOverview | null;
          progress?: MinimalNextSplitResult | null;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error ?? "결제 결과 대기에 실패했습니다.");
        if (!data.changed || (!data.overview && !data.progress)) {
          markPaymentTrace("FE_RESULT_PUSH_RECONNECT", { attemptId, reconnect: reconnect + 1 });
          continue;
        }
        if (paymentTrace.current?.traceId !== traceId) return;
        const progress = data.progress ?? null;
        const tracedAttempt = progress?.currentAttempt ?? data.overview?.attempts.find((attempt) => attempt.id === attemptId);
        if (progress) {
          paymentProgressFloor.current = progress;
          setOverview((current) => current ? mergeMinimalPaymentProgress(current, progress) : current);
        } else if (data.overview) {
          setOverview(data.overview);
        }
        markPaymentTrace(
          "FE_RESULT_PUSH_DONE",
          {
            attemptId,
            status: tracedAttempt?.status,
            method: "GET",
            url: "/api/admin/payments/wait",
            responseBytes: new TextEncoder().encode(responseText).byteLength,
          },
          performance.now() - startedAt,
        );
        if (tracedAttempt && !paymentTrace.current.renderScheduled) {
          paymentTrace.current.attemptId = tracedAttempt.id;
          paymentTrace.current.renderScheduled = true;
          markPaymentTrace("FE_STATE_UPDATED", { status: tracedAttempt.status, source: "push" });
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            markPaymentTrace("UI_NEXT_SPLIT_READY", {
              status: tracedAttempt.status,
              canUseNextSplit: progress?.canUseNextSplit ?? false,
            });
            markPaymentTrace("FE_RENDER_DONE", { status: tracedAttempt.status, source: "push" });
            flushPaymentTrace();
          }));
        }
        if (progress) {
          markPaymentTrace("FULL_OVERVIEW_START", { ledgerRevision: progress.ledgerRevision });
          void refresh()
            .then(() => {
              markPaymentTrace("FULL_OVERVIEW_DONE", { ledgerRevision: progress.ledgerRevision });
              flushPaymentTrace();
            })
            .catch(() => undefined);
        }
        return;
      }
      markPaymentTrace("FE_RESULT_PUSH_FALLBACK", { attemptId, reason: "timeout" });
    } catch (reason) {
      if (controller.signal.aborted) return;
      markPaymentTrace("FE_RESULT_PUSH_FALLBACK", {
        attemptId,
        reason: reason instanceof Error ? reason.message : String(reason),
      });
      await refresh().catch(() => undefined);
    } finally {
      if (paymentResultWait.current === controller) paymentResultWait.current = null;
    }
  }

  async function waitForFullCancellation(initialAttemptId: string) {
    paymentResultWait.current?.abort();
    const controller = new AbortController();
    paymentResultWait.current = controller;
    let afterAttemptId = initialAttemptId;
    markPaymentTrace("FE_FULL_CANCEL_PUSH_START", { attemptId: initialAttemptId });
    try {
      for (let cycle = 0; cycle < 50 && !controller.signal.aborted; cycle += 1) {
        const response = await fetch(
          `/api/admin/payments/wait?scope=full-cancel&reservationId=${encodeURIComponent(reservation.id)}&attemptId=${encodeURIComponent(afterAttemptId)}`,
          {
            cache: "no-store",
            signal: controller.signal,
            headers: paymentTrace.current?.traceId
              ? { "x-payment-trace-id": paymentTrace.current.traceId }
              : undefined,
          },
        );
        const data = await response.json() as {
          changed?: boolean;
          overview?: PaymentOverview | null;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error ?? "전체 취소 결과 대기에 실패했습니다.");
        if (!data.changed || !data.overview) continue;

        setOverview(data.overview);
        const cancellations = data.overview.attempts.filter(
          (attempt) => attempt.attemptType === "CANCEL",
        );
        const completed = cancellations.filter((attempt) => attempt.status === "CANCELLED").length;
        const failed = cancellations.filter(
          (attempt) => ["DECLINED", "USER_CANCELLED", "ERROR", "BUSY", "UNKNOWN"].includes(attempt.status),
        );
        if (failed.length) {
          setMessage(`전체 취소 중 ${completed}건 완료 · ${failed.length}건 확인 필요`);
          markPaymentTrace("FE_FULL_CANCEL_PUSH_FAILED", { completed, failed: failed.length });
          return;
        }
        if (!data.overview.payment?.fullCancelRequested) {
          setMessage(`전체 취소 완료 · ${completed}건`);
          markPaymentTrace("FE_FULL_CANCEL_PUSH_DONE", { completed });
          await refreshCoupons();
          await onSettled();
          return;
        }
        const next = cancellations.find(
          (attempt) => ["PENDING", "PROCESSING"].includes(attempt.status),
        );
        if (next) afterAttemptId = next.id;
        setMessage(`전체 취소 진행 중 · ${completed}건 완료`);
      }
      setMessage("전체 취소 진행 상태를 새로고침해 확인해주세요.");
    } catch (reason) {
      if (controller.signal.aborted) return;
      setMessage(reason instanceof Error ? reason.message : "전체 취소 결과 확인 실패");
      await refresh().catch(() => undefined);
    } finally {
      if (paymentResultWait.current === controller) paymentResultWait.current = null;
    }
  }

  const hasProcessing = Boolean(
    overview?.attempts.some((attempt) =>
      ["PROCESSING", "UNKNOWN"].includes(attempt.status) ||
      (attempt.status === "BUSY" && Boolean(attempt.activeKey)) ||
      (attempt.status === "PENDING" && Boolean(attempt.commandId)),
    ),
  );

  useEffect(() => {
    let active = true;
    const initial = window.setTimeout(() => {
      void refresh().catch((reason) => {
        if (active) setMessage(reason instanceof Error ? reason.message : "결제 상태 확인 실패");
      });
    }, 0);
    const timer = window.setInterval(
      () => {
        if (!paymentResultWait.current) void refresh().catch(() => undefined);
      },
      overview?.payment?.fullCancelRequested ? 900 : 5_000,
    );
    return () => {
      active = false;
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [hasProcessing, overview?.payment?.fullCancelRequested, refresh]);

  useEffect(() => () => paymentResultWait.current?.abort(), [reservation.id]);

  useEffect(() => {
    void refreshCoupons();
  }, [refreshCoupons]);

  const summary = overview?.summary;
  const planLocked = Boolean(summary?.amountLocked);
  const paymentGroup = overview?.group;
  const groupSelectionActive = Boolean(
    paymentGroup &&
    (paymentGroup.isPaymentGroup || (groupPaymentEnabled && paymentGroup.eligible)),
  );
  const otherGroupItems = groupSelectionActive
    ? paymentGroup?.items.filter((item) => item.reservationId !== reservation.id) ?? []
    : [];
  const selectedFinalAmount = amount + otherGroupItems.reduce((sum, item) => sum + item.finalAmount, 0);
  const otherGroupDepositAmount = otherGroupItems.reduce((sum, item) => sum + item.depositAmount, 0);
  const editableFinalAmount = planLocked ? summary?.finalAmount ?? selectedFinalAmount : selectedFinalAmount;
  const effectiveDepositAmount = planLocked
    ? summary?.depositAmount ?? initialDepositAmount + otherGroupDepositAmount
    : Math.min(initialDepositAmount + otherGroupDepositAmount, Math.max(0, editableFinalAmount));
  const payableAmount = Math.max(0, editableFinalAmount - effectiveDepositAmount);
  const completedAmount = planLocked ? summary?.completedAmount ?? 0 : 0;
  const remainingAmount = planLocked ? summary?.remainingAmount ?? payableAmount : payableAmount;
  const plan = overview?.plan ?? [];
  const terminal = overview?.terminal;
  const savedPlanTotal = plan.reduce((sum, payment) => sum + payment.amount, 0);
  const unlockedPlanMismatch = Boolean(
    overview?.payment &&
      !planLocked &&
      (
        overview.payment.finalAmount !== editableFinalAmount ||
        overview.payment.depositAmount !== effectiveDepositAmount ||
        overview.payment.payableAmount !== payableAmount ||
        savedPlanTotal !== payableAmount
      ),
  );
  const visiblePlan = unlockedPlanMismatch ? [] : plan;
  const cancelledOriginals = new Set(
    overview?.attempts
      .filter((attempt) => attempt.attemptType === "CANCEL" && attempt.status === "CANCELLED")
      .map((attempt) => attempt.originalAttemptId) ?? [],
  );

  useEffect(() => {
    onAmountLockChange?.(planLocked);
  }, [onAmountLockChange, planLocked]);

  useEffect(() => {
    if (!overview) return;
    const signature = overview.attempts
      .filter((attempt) => ["APPROVED", "COMPLETED", "CANCELLED"].includes(attempt.status))
      .map((attempt) => `${attempt.id}:${attempt.status}:${attempt.updatedAt}`)
      .join("|");
    const completedNow = Boolean(
      overview.summary &&
      overview.summary.remainingAmount === 0 &&
      overview.summary.completedAmount > 0 &&
      !overview.summary.hasUnknown,
    );
    if (settledSignature.current === null) {
      settledSignature.current = signature;
      if (autoResetOnCompleted && completedNow) void onSettled();
      return;
    }
    if (settledSignature.current === signature) return;
    settledSignature.current = signature;
    if (!autoResetOnCompleted || completedNow) void onSettled();
  }, [autoResetOnCompleted, onSettled, overview]);

  function equalAmounts(total: number, count: number) {
    const quotient = Math.floor(total / count);
    const remainder = total % count;
    return Array.from({ length: count }, (_, index) => quotient + (index < remainder ? 1 : 0));
  }

  function rebalanceDraftItems(current: DraftItem[], targetAmount: number) {
    const target = Math.max(0, Math.trunc(targetAmount));
    if (target === 0) return [];
    const next = current
      .filter((item) => item.paymentMethod !== "coupon")
      .map((item) => ({ ...item, memberCouponId: undefined, couponParticipantType: undefined }));
    if (!next.length) return [{ amount: target, paymentMethod: "card" }];
    let total = next.reduce((sum, item) => sum + item.amount, 0);
    if (total < target) {
      let targetIndex = 0;
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index].amount > 0) {
          targetIndex = index;
          break;
        }
      }
      next[targetIndex] = { ...next[targetIndex], amount: next[targetIndex].amount + target - total };
      return next;
    }
    let reduction = total - target;
    for (let index = next.length - 1; index >= 0 && reduction > 0; index -= 1) {
      const removable = Math.min(next[index].amount, reduction);
      next[index] = { ...next[index], amount: next[index].amount - removable };
      reduction -= removable;
    }
    total = next.reduce((sum, item) => sum + item.amount, 0);
    return total === target ? next : [{ amount: target, paymentMethod: "card" }];
  }

  const methodOptions = [
    { value: "card", label: "카드" },
    { value: "cash", label: "현금" },
    { value: "account", label: "계좌" },
  ];
  const couponPaymentAllowed = !groupSelectionActive && !["member_pass_purchase", "add_on_sale_purchase"].includes(reservation.source);
  const reservationDay = new Date(`${reservation.scheduledDate}T12:00:00+09:00`).getUTCDay();
  const eligibleCoupons = memberCoupons
    .filter((coupon) =>
      couponPaymentAllowed &&
      coupon.status === "ACTIVE" &&
      (coupon.couponType !== "WEEKDAY_EVENT" || (reservationDay >= 1 && reservationDay <= 5)),
    )
    .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt) || left.issuedAt.localeCompare(right.issuedAt));
  const participantAdultCount = Math.max(0, Math.trunc(participantCounts?.adult ?? reservation.adultCount));
  const participantYouthCount = Math.max(0, Math.trunc(participantCounts?.youth ?? reservation.youthCount));
  const configuredGameAmount = participantCounts
    ? participantAdultCount * pricing.adultPrice + participantYouthCount * pricing.youthPrice
    : Math.max(0, Math.trunc(reservation.baseAmount));
  const discountedGameAmount = Math.max(0, configuredGameAmount - Math.max(0, Math.trunc(discountAmount)));
  const gameDepositAmount = Math.min(effectiveDepositAmount, discountedGameAmount);
  const maximumCouponAmount = Math.max(0, discountedGameAmount - gameDepositAmount);
  const couponSlots = buildMemberCouponSlots({
    adultCount: participantAdultCount,
    youthCount: participantYouthCount,
    adultPrice: pricing.adultPrice,
    youthPrice: pricing.youthPrice,
    maximumCouponAmount,
  });
  const eligibleCouponIds = new Set(eligibleCoupons.map((coupon) => coupon.id));
  const eligibleCouponSignature = eligibleCoupons.map((coupon) => coupon.id).join("|");
  const couponSelectionContextKey = [
    reservation.id,
    reservation.memberId ?? "",
    eligibleCouponSignature,
    couponSlots.map((slot) => `${slot.participantType}:${slot.amount}`).join("|"),
  ].join("::");
  useEffect(() => {
    // 이용자 구성이나 사용 가능한 쿠폰이 바뀌면 이전 금융 선택을 다시 살리지 않는다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCouponSelection((current) => current.contextKey === couponSelectionContextKey
      ? current
      : { contextKey: couponSelectionContextKey, ids: [] });
  }, [couponSelectionContextKey]);
  const appliedCouponIds = (couponSelection.contextKey === couponSelectionContextKey ? couponSelection.ids : [])
    .filter((couponId) => eligibleCouponIds.has(couponId))
    .slice(0, couponSlots.length);
  const couponAllocations = allocateMemberCoupons({
    couponIds: appliedCouponIds,
    adultCount: participantAdultCount,
    youthCount: participantYouthCount,
    adultPrice: pricing.adultPrice,
    youthPrice: pricing.youthPrice,
    maximumCouponAmount,
  });
  const couponAllocationById = new Map(
    couponAllocations.map((allocation) => [allocation.couponId, allocation] as const),
  );
  const couponAmount = couponAllocations.reduce((sum, allocation) => sum + allocation.amount, 0);
  const remainingCashAmount = Math.max(0, payableAmount - couponAmount);
  const maximumCashSplitCount = Math.max(1, 20 - couponAllocations.length);
  const effectiveSplitCount = Math.min(splitCount, maximumCashSplitCount);
  const draftCashMethod = (index: number) =>
    ["card", "cash", "account"].includes(draftItems[index]?.paymentMethod)
      ? draftItems[index].paymentMethod
      : "card";
  const cashConfiguredItems: DraftItem[] = remainingCashAmount === 0
    ? []
    : mode === "single"
      ? [{ amount: remainingCashAmount, paymentMethod: draftCashMethod(0) }]
      : mode === "equal"
        ? equalAmounts(remainingCashAmount, effectiveSplitCount).map((itemAmount, index) => ({
            amount: itemAmount,
            paymentMethod: draftCashMethod(index),
          }))
        : draftItems
          .filter((item) => item.paymentMethod !== "coupon")
          .map((item) => ({
            ...item,
            memberCouponId: undefined,
            couponParticipantType: undefined,
          }));
  const configuredItems: DraftItem[] = [
    ...couponAllocations.map((allocation) => ({
      amount: allocation.amount,
      paymentMethod: "coupon",
      memberCouponId: allocation.couponId,
      couponParticipantType: allocation.participantType,
    })),
    ...cashConfiguredItems,
  ];
  const draftTotal = configuredItems.reduce((sum, item) => sum + item.amount, 0);
  const draftValid = configuredItems.length > 0 && configuredItems.every((item) => item.amount > 0 && (item.paymentMethod !== "coupon" || Boolean(item.memberCouponId))) && draftTotal === payableAmount;
  const currentSplitIndex = unlockedPlanMismatch ? null : summary?.currentSplitIndex ?? null;
  const unknownCardAttempt = overview?.attempts.find(
    (attempt) =>
      attempt.attemptType === "PAY" &&
      attempt.paymentMethod === "card" &&
      attempt.status === "UNKNOWN",
  );

  async function post(body: Record<string, unknown>) {
    const trace = paymentTrace.current;
    const action = String(body.action ?? "unknown");
    const apiCallSequence = trace ? ++trace.apiCallSequence : 0;
    const apiStarted = performance.now();
    const payload = JSON.stringify({
      reservationId: reservation.id,
      ...(trace ? { traceId: trace.traceId } : {}),
      ...body,
    });
    const requestBytes = new TextEncoder().encode(payload).byteLength;
    const requestDetails = {
      action,
      apiCallSequence,
      method: "POST",
      url: "/api/admin/payments",
      requestBytes,
    };
    if (trace) markPaymentTrace("FE_API_START", requestDetails);
    const response = await fetch("/api/admin/payments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(trace ? { "x-payment-trace-id": trace.traceId } : {}),
      },
      body: payload,
    });
    if (trace) markPaymentTrace("FE_API_RESPONSE_HEADERS", {
      ...requestDetails,
      status: response.status,
      contentLength: Number(response.headers.get("content-length")) || null,
    }, performance.now() - apiStarted);
    const responseText = await response.text();
    const responseBytes = new TextEncoder().encode(responseText).byteLength;
    const parseStarted = performance.now();
    const data = JSON.parse(responseText) as PaymentOverview & {
      attempt?: PaymentAttempt;
      overview?: PaymentOverview;
      intent?: SignedPaymentIntent | null;
      paymentTransport?: "CLOUD_FAST_LANE" | "LOCAL_DIRECT";
      localDirectEnabled?: boolean;
      localBridgeUrl?: string;
      error?: string;
    };
    const parseDurationMs = performance.now() - parseStarted;
    if (trace) {
      markPaymentTrace("FE_API_JSON_PARSE_DONE", {
        ...requestDetails,
        status: response.status,
        responseBytes,
      }, parseDurationMs);
      markPaymentTrace("FE_API_RESPONSE_BODY", {
        ...requestDetails,
        status: response.status,
        responseBytes,
        parseDurationMs: Math.round(parseDurationMs * 1_000) / 1_000,
      }, performance.now() - apiStarted);
    }
    if (!response.ok) throw new Error(data.error ?? "결제 요청을 처리하지 못했습니다.");
    return data;
  }

  async function probeLocalPaymentBridge(bridgeUrl: string) {
    const cached = localPaymentHealthCache.current;
    const cacheAgeMs = cached ? performance.now() - cached.checkedAt : Number.POSITIVE_INFINITY;
    markPaymentTrace("LOCAL_HEALTH_START", {
      bridgeUrl,
      cacheCandidate: Boolean(cached && cached.bridgeUrl === bridgeUrl),
    });
    if (
      cached &&
      cached.bridgeUrl === bridgeUrl &&
      cacheAgeMs <= LOCAL_PAYMENT_HEALTH_CACHE_TTL_MS
    ) {
      const roundedAgeMs = Math.max(0, Math.round(cacheAgeMs));
      markPaymentTrace("LOCAL_HEALTH_END", {
        healthy: true,
        cacheHit: true,
        cacheAgeMs: roundedAgeMs,
      }, 0);
      return {
        healthy: true as const,
        elapsedMs: 0,
        failures: 0,
        attempts: [] as Array<{ attempt: number; elapsedMs: number; error: string }>,
        cacheHit: true,
        cacheAgeMs: roundedAgeMs,
      };
    }
    const attempts: Array<{ attempt: number; elapsedMs: number; error: string }> = [];
    const probeStarted = performance.now();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const started = performance.now();
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 900);
      try {
        const response = await fetch(`${bridgeUrl}/health`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json() as { ok?: boolean; service?: string };
        const elapsedMs = Math.round(performance.now() - started);
        if (response.ok && data.ok === true) {
          localPaymentHealthCache.current = {
            bridgeUrl,
            checkedAt: performance.now(),
          };
          markPaymentTrace("LOCAL_HEALTH_END", {
            healthy: true,
            cacheHit: false,
            failures: attempt - 1,
          }, performance.now() - probeStarted);
          return {
            healthy: true as const,
            elapsedMs,
            failures: attempt - 1,
            attempts,
            cacheHit: false,
            cacheAgeMs: null,
          };
        }
        attempts.push({ attempt, elapsedMs, error: `HTTP_${response.status}` });
      } catch (reason) {
        attempts.push({
          attempt,
          elapsedMs: Math.round(performance.now() - started),
          error: reason instanceof Error ? reason.name : "LOCAL_HEALTH_FAILED",
        });
      } finally {
        window.clearTimeout(timer);
      }
      if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    if (localPaymentHealthCache.current?.bridgeUrl === bridgeUrl) {
      localPaymentHealthCache.current = null;
    }
    markPaymentTrace("LOCAL_HEALTH_END", {
      healthy: false,
      cacheHit: false,
      failures: attempts.length,
    }, performance.now() - probeStarted);
    return {
      healthy: false as const,
      elapsedMs: attempts.reduce((sum, item) => sum + item.elapsedMs, 0),
      failures: attempts.length,
      attempts,
      cacheHit: false,
      cacheAgeMs: null,
    };
  }

  async function executeLocalDirectPayment(
    intent: SignedPaymentIntent,
    bridgeUrl: string,
  ) {
    markPaymentTrace("LD_INTENT_READY", {
      intentId: intent.intent_id,
      transactionUuid: intent.transaction_uuid,
      expiresAt: intent.expires_at,
    });
    const prepareStarted = performance.now();
    const prepareResponse = await fetch(`${bridgeUrl}/local-payments/prepare`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payment-trace-id": intent.trace_id,
      },
      body: JSON.stringify({ payment_intent: intent }),
    });
    const prepareResult = await prepareResponse.json() as {
      ready?: boolean;
      error?: string;
      request_sent?: boolean;
    };
    markPaymentTrace("LD_BRIDGE_PREPARE_DONE", {
      ready: prepareResult.ready === true,
      status: prepareResponse.status,
    }, performance.now() - prepareStarted);
    if (!prepareResponse.ok || !prepareResult.ready) {
      await post({ action: "local_release", intentId: intent.intent_id }).catch(() => undefined);
      throw new Error(
        prepareResult.error ??
        "로컬 결제 준비에 실패했습니다. 단말에는 결제 요청을 보내지 않았습니다.",
      );
    }

    let executeResponse: Response;
    const executeStarted = performance.now();
    markPaymentTrace("LD_LOCAL_REQUEST_START", {
      intentId: intent.intent_id,
      transactionUuid: intent.transaction_uuid,
    });
    markPaymentTrace("LOCAL_EXECUTE_REQUEST", {
      splitPhase: overview?.summary?.currentSplitIndex === 1 ? "INITIAL" : "SUBSEQUENT",
    });
    try {
      executeResponse = await fetch(`${bridgeUrl}/local-payments/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-payment-trace-id": intent.trace_id,
        },
        body: JSON.stringify({ payment_intent: intent }),
      });
    } catch (reason) {
      markPaymentTrace("LD_RESPONSE_AMBIGUOUS", {
        error: reason instanceof Error ? reason.message : String(reason),
      }, performance.now() - executeStarted);
      await post({
        action: "local_unknown",
        intentId: intent.intent_id,
        reason: reason instanceof Error ? reason.message : String(reason),
      }).catch(() => undefined);
      throw new Error("단말 요청 결과를 확인하지 못해 UNKNOWN으로 잠갔습니다. 자동 재결제하지 않았습니다.");
    }

    const result = await executeResponse.json() as Record<string, unknown> & {
      error?: string;
      request_sent?: boolean;
      response_message?: string;
      status?: string;
    };
    markPaymentTrace("LD_PAY_FINAL_RESPONSE", {
      httpStatus: executeResponse.status,
      status: result.status,
      requestSent: result.request_sent,
      cloudSyncStatus: result.cloud_sync_status,
    }, performance.now() - executeStarted);

    if (!executeResponse.ok) {
      if (result.request_sent !== false) {
        await post({
          action: "local_unknown",
          intentId: intent.intent_id,
          reason: result.error ?? "LOCAL_EXECUTE_AMBIGUOUS",
        }).catch(() => undefined);
        throw new Error("단말 요청 여부가 불명확해 UNKNOWN으로 잠갔습니다. 자동 재결제하지 않았습니다.");
      }
      await post({ action: "local_release", intentId: intent.intent_id }).catch(() => undefined);
      throw new Error(result.error ?? "단말 전송 전에 로컬 결제가 거절되었습니다.");
    }

    const status = String(result.status ?? "UNKNOWN").toUpperCase();
    if (status === "BUSY" && result.request_sent === false) {
      setMessage("다른 카드 거래가 진행 중입니다. 이번 회차는 단말에 전송되지 않았습니다.");
      return;
    }

    void waitForPaymentResult(intent.attempt_id);
    if (["APPROVED", "COMPLETED"].includes(status)) {
      setMessage("카드 승인이 완료됐습니다. 매출 기록을 동기화하고 있습니다.");
    } else if (status === "USER_CANCELLED") {
      setMessage("카드 결제가 취소되었습니다.");
    } else if (status === "UNKNOWN") {
      setMessage("결제 결과 확인이 필요합니다. 자동 재결제하지 않았습니다.");
    } else {
      setMessage(String(result.response_message ?? "결제 결과를 확인해주세요."));
    }
  }

  async function preparePlan() {
    if (requestInFlight.current || !draftValid) return;
    requestInFlight.current = true;
    const explicitExecution = Boolean(overview?.explicitExecutionV2Enabled);
    const submittedMode = appliedCouponIds.length > 0 ? "custom" : mode;
    beginPaymentTrace({
      action: explicitExecution ? "prepare" : "start",
      amount: payableAmount,
      mode: submittedMode,
      couponCount: appliedCouponIds.length,
    });
    markPaymentTrace("FE_VALIDATION_DONE", { valid: true, splitCount: configuredItems.length });
    setBusy("prepare");
    setMessage("");
    try {
      if (beforePay) {
        const beforeStarted = performance.now();
        markPaymentTrace("FE_BEFORE_PAY_START");
        await beforePay();
        markPaymentTrace("FE_BEFORE_PAY_DONE", {}, performance.now() - beforeStarted);
      }
      let localFailureEvidence: Awaited<ReturnType<typeof probeLocalPaymentBridge>> | null = null;
      let useLocalDirect = false;
      const localDirectCandidate = !explicitExecution &&
        configuredItems[0]?.paymentMethod === "card" &&
        Boolean(overview?.localDirectEnabled && overview.localBridgeUrl);
      if (localDirectCandidate && overview?.localBridgeUrl) {
        localFailureEvidence = await probeLocalPaymentBridge(overview.localBridgeUrl);
        const localDecision = decidePaymentTransport({
          localDirectEnabled: true,
          browserLocalRequestPossible: true,
          localHealthHealthy: localFailureEvidence.healthy,
          consecutiveHealthFailures: localFailureEvidence.failures,
          localRequestSent: false,
          responseKnown: false,
        });
        useLocalDirect = localDecision === "LOCAL_DIRECT";
        markPaymentTrace("TRANSPORT_DECISION", {
          selectedTransport: localDecision,
          localHealth: localFailureEvidence.healthy ? "HEALTHY" : "OFFLINE_3X",
          localLatencyMs: localFailureEvidence.elapsedMs,
          failureCount: localFailureEvidence.failures,
          featureFlag: overview.paymentTransport,
          browserLocalRequestPossible: localFailureEvidence.healthy,
          fallbackReason: localFailureEvidence.healthy ? "" : "LOCAL_HEALTH_FAILED_BEFORE_SEND",
        });
        if (!useLocalDirect && localDecision !== "CLOUD_FAST_LANE") {
          throw new Error("로컬 결제 상태를 확인 중입니다. 잠시 후 다시 눌러주세요.");
        }
      }
      const startAction = explicitExecution
        ? "prepare"
        : useLocalDirect
          ? "local_prepare"
          : "start";
      const data = await post({
        action: startAction,
        reservationIds: groupSelectionActive
          ? paymentGroup?.items.map((item) => item.reservationId)
          : undefined,
        mode: submittedMode,
        count: submittedMode === "equal" ? splitCount : undefined,
        paymentMethod: configuredItems[0]?.paymentMethod,
        items: configuredItems,
        addOnAmount,
        addOnSale,
        discountAmount,
        requestKey: crypto.randomUUID(),
        ...(startAction === "start" ? { transactionRequestKey: crypto.randomUUID() } : {}),
        ...(localFailureEvidence
          ? {
              localHealth: localFailureEvidence.healthy ? "HEALTHY" : "OFFLINE_3X",
              localLatencyMs: localFailureEvidence.elapsedMs,
              localFailureCount: localFailureEvidence.failures,
            }
          : {}),
      });
      const preparedOverview = data.overview ?? data;
      setPlannerOpen(false);
      if (useLocalDirect) {
        setOverview(preparedOverview);
        const intent = data.intent;
        const bridgeUrl = data.localBridgeUrl || overview?.localBridgeUrl;
        if (!intent) {
          setMessage("결제 계획을 저장했습니다.");
          flushPaymentTrace();
          return;
        }
        if (!bridgeUrl) throw new Error("로컬 결제 주소가 없습니다.");
        if (paymentTrace.current) paymentTrace.current.attemptId = intent.attempt_id;
        await executeLocalDirectPayment(intent, bridgeUrl);
        await refreshCoupons();
        return;
      }
      if (explicitExecution) {
        setOverview(preparedOverview);
        setMessage("결제 방식이 확정되었습니다. 아래 회차별 결제 버튼을 눌러주세요.");
        flushPaymentTrace();
        return;
      }
      const first = preparedOverview.plan.find((payment) => payment.status === "PENDING");
      const startedOverview = data.attempt
        ? {
            ...preparedOverview,
            plan: preparedOverview.plan.map((payment) =>
              payment.id === data.attempt?.id ? data.attempt : payment),
            attempts: preparedOverview.attempts.some((attempt) => attempt.id === data.attempt?.id)
              ? preparedOverview.attempts.map((attempt) =>
                  attempt.id === data.attempt?.id ? data.attempt! : attempt)
              : [data.attempt, ...preparedOverview.attempts],
          }
        : preparedOverview;
      setOverview(startedOverview);
      if (!first) {
        setMessage("결제 계획을 저장했습니다.");
        flushPaymentTrace();
        return;
      }
      if (paymentTrace.current) paymentTrace.current.attemptId = first.id;
      const cardReady = first.paymentMethod !== "card" || (
        preparedOverview.terminal.connected && preparedOverview.terminal.paymentReady
      );
      if (!cardReady) {
        setMessage("결제 계획을 저장했습니다. 카드 단말 연결을 확인한 뒤 1회차를 처리해주세요.");
        markPaymentTrace("FE_TERMINAL_NOT_READY");
        flushPaymentTrace();
        return;
      }
      setBusy(`process:${first.id}`);
      if (first.paymentMethod === "card") {
        void waitForPaymentResult(data.attempt?.id ?? first.id);
      }
      const method = PAYMENT_LABELS[first.paymentMethod] ?? first.paymentMethod;
      setMessage(
        first.paymentMethod === "card"
          ? "카드를 단말기에 삽입해주세요. 승인 결과를 기다리는 중입니다."
          : `${method} 수납을 완료했습니다.`,
      );
      if (first.paymentMethod !== "card") {
        await refresh();
        await refreshCoupons();
        await onSettled();
      }
    } catch (reason) {
      markPaymentTrace("FE_ERROR", { error: reason instanceof Error ? reason.message : String(reason) });
      flushPaymentTrace();
      setMessage(reason instanceof Error ? reason.message : "결제 시작 실패");
    } finally {
      setBusy("");
      requestInFlight.current = false;
    }
  }

  async function processTransaction(payment: PaymentAttempt, retry = false, retryPaymentMethod?: string) {
    if (requestInFlight.current) return;
    const effectivePaymentMethod = retryPaymentMethod ?? payment.paymentMethod;
    beginPaymentTrace({ action: retry ? "retry" : "process", amount: payment.amount, paymentMethod: effectivePaymentMethod });
    if (paymentTrace.current) paymentTrace.current.attemptId = payment.id;
    markPaymentTrace("FE_VALIDATION_DONE", { valid: true, paymentMethod: effectivePaymentMethod });
    const method = PAYMENT_LABELS[effectivePaymentMethod] ?? effectivePaymentMethod;
    requestInFlight.current = true;
    setBusy(`process:${payment.id}`);
    setMessage("");
    try {
      let localFailureEvidence: Awaited<ReturnType<typeof probeLocalPaymentBridge>> | null = null;
      if (
        effectivePaymentMethod === "card" &&
        overview?.localDirectEnabled &&
        overview.localBridgeUrl
      ) {
        localFailureEvidence = await probeLocalPaymentBridge(overview.localBridgeUrl);
        const localDecision = decidePaymentTransport({
          localDirectEnabled: true,
          browserLocalRequestPossible: true,
          localHealthHealthy: localFailureEvidence.healthy,
          consecutiveHealthFailures: localFailureEvidence.failures,
          localRequestSent: false,
          responseKnown: false,
        });
        markPaymentTrace("TRANSPORT_DECISION", {
          transactionUuid: payment.transactionUuid || payment.id,
          selectedTransport: localDecision,
          localHealth: localFailureEvidence.healthy ? "HEALTHY" : "OFFLINE_3X",
          localLatencyMs: localFailureEvidence.elapsedMs,
          failureCount: localFailureEvidence.failures,
          featureFlag: overview.paymentTransport,
          browserLocalRequestPossible: localFailureEvidence.healthy,
          fallbackReason: localFailureEvidence.healthy ? "" : "LOCAL_HEALTH_FAILED_BEFORE_SEND",
        });
        if (localDecision === "LOCAL_DIRECT") {
          const localPrepared = await post({
            action: retry ? "local_retry_prepare" : "local_prepare_transaction",
            transactionId: payment.id,
            requestKey: crypto.randomUUID(),
            ...(retry ? { paymentMethod: effectivePaymentMethod } : {}),
            localHealth: "HEALTHY",
            localLatencyMs: localFailureEvidence.elapsedMs,
            localFailureCount: localFailureEvidence.failures,
          });
          const intent = localPrepared.intent;
          const bridgeUrl = localPrepared.localBridgeUrl || overview.localBridgeUrl;
          if (!intent || !bridgeUrl) throw new Error("로컬 결제 준비정보가 없습니다.");
          if (paymentTrace.current) paymentTrace.current.attemptId = intent.attempt_id;
          setOverview(localPrepared.overview ?? overview);
          await executeLocalDirectPayment(intent, bridgeUrl);
          await refreshCoupons();
          return;
        }
        if (localDecision !== "CLOUD_FAST_LANE") {
          throw new Error("로컬 결제 상태를 확인 중입니다. 잠시 후 다시 눌러주세요.");
        }
        setMessage("로컬 결제 서비스가 3회 연속 응답하지 않아 단말 전송 전에 기존 결제 경로로 전환합니다.");
      }

      const processResult = await post({
        action: retry ? "retry" : "process",
        transactionId: payment.id,
        requestKey: crypto.randomUUID(),
        ...(retry ? { paymentMethod: effectivePaymentMethod } : {}),
        ...(localFailureEvidence
          ? {
              selectedTransport: "CLOUD_FAST_LANE",
              localHealth: "OFFLINE_3X",
              localLatencyMs: localFailureEvidence.elapsedMs,
              localFailureCount: localFailureEvidence.failures,
              fallbackReason: "LOCAL_HEALTH_FAILED_BEFORE_SEND",
            }
          : {}),
      });
      if (effectivePaymentMethod === "card") {
        void waitForPaymentResult(processResult.attempt?.id ?? payment.id);
      }
      setMessage(
        effectivePaymentMethod === "card"
          ? "카드를 단말기에 삽입해주세요. 승인 결과를 기다리는 중입니다."
          : `${method} 수납을 완료했습니다.`,
      );
      await refresh();
      await refreshCoupons();
      if (effectivePaymentMethod !== "card") await onSettled();
    } catch (reason) {
      markPaymentTrace("FE_ERROR", { error: reason instanceof Error ? reason.message : String(reason) });
      flushPaymentTrace();
      setMessage(reason instanceof Error ? reason.message : "결제 처리 실패");
    } finally {
      setBusy("");
      requestInFlight.current = false;
    }
  }

  async function cancelTransaction(payment: PaymentAttempt) {
    if (requestInFlight.current) return;
    if (!window.confirm(`${won(payment.amount)}원 ${PAYMENT_LABELS[payment.paymentMethod] ?? "결제"} 건만 취소할까요?`)) return;
    beginPaymentTrace({ action: "cancel", amount: payment.amount });
    if (paymentTrace.current) paymentTrace.current.attemptId = payment.id;
    markPaymentTrace("FE_VALIDATION_DONE", { valid: true, paymentMethod: payment.paymentMethod });
    requestInFlight.current = true;
    setBusy(`cancel:${payment.id}`);
    setMessage("");
    try {
      const cancelResult = await post({
        action: "cancel",
        paymentId: payment.id,
        requestKey: crypto.randomUUID(),
      });
      if (payment.paymentMethod === "card" && cancelResult.attempt?.id) {
        void waitForPaymentResult(cancelResult.attempt.id);
      }
      setMessage(payment.paymentMethod === "card" ? "단말 승인취소 결과를 기다리는 중입니다." : "반환 내역을 저장했습니다.");
      await refresh();
      await refreshCoupons();
      if (payment.paymentMethod !== "card") await onSettled();
    } catch (reason) {
      markPaymentTrace("FE_ERROR", { error: reason instanceof Error ? reason.message : String(reason) });
      flushPaymentTrace();
      setMessage(reason instanceof Error ? reason.message : "취소 처리 실패");
    } finally {
      setBusy("");
      requestInFlight.current = false;
    }
  }

  async function cancelAll() {
    if (requestInFlight.current || completedAmount <= 0) return;
    if (!window.confirm("완료된 결제를 최신 거래부터 순서대로 전체 취소할까요?\n중간에 실패하면 성공한 취소는 유지되고 실패 건부터 다시 진행합니다.")) return;
    beginPaymentTrace({ action: "cancel_all", amount: completedAmount });
    markPaymentTrace("FE_VALIDATION_DONE", { valid: true });
    requestInFlight.current = true;
    setBusy("cancel-all");
    setMessage("");
    try {
      const result = await post({ action: "cancel_all", requestKey: crypto.randomUUID() });
      if (result.overview) setOverview(result.overview);
      setMessage("전체 취소를 역순으로 처리하고 있습니다. 창을 닫아도 진행 상태가 저장됩니다.");
      if (result.attempt?.id) {
        void waitForFullCancellation(result.attempt.id);
      } else {
        await refresh();
      }
    } catch (reason) {
      markPaymentTrace("FE_ERROR", { error: reason instanceof Error ? reason.message : String(reason) });
      flushPaymentTrace();
      setMessage(reason instanceof Error ? reason.message : "전체 취소 요청 실패");
    } finally {
      setBusy("");
      requestInFlight.current = false;
    }
  }

  async function checkTerminal() {
    setBusy("status");
    try {
      await post({ action: "status", requestKey: crypto.randomUUID() });
      setMessage("단말 상태를 다시 확인하고 있습니다.");
      window.setTimeout(() => void refresh(), 600);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "단말 상태 확인 실패");
    } finally {
      setBusy("");
    }
  }

  function changeGroupPayment(enabled: boolean) {
    if (!paymentGroup || paymentGroup.isPaymentGroup || planLocked) return;
    const otherItems = enabled
      ? paymentGroup.items.filter((item) => item.reservationId !== reservation.id)
      : [];
    const nextFinalAmount = amount + otherItems.reduce((sum, item) => sum + item.finalAmount, 0);
    const nextDepositAmount = initialDepositAmount + otherItems.reduce((sum, item) => sum + item.depositAmount, 0);
    const nextPayableAmount = Math.max(0, nextFinalAmount - nextDepositAmount);
    setGroupPaymentEnabled(enabled);
    if (enabled) setCouponSelection({ contextKey: "", ids: [] });
    setMode("single");
    setDraftItems((current) => [{
      amount: nextPayableAmount,
      paymentMethod: current[0]?.paymentMethod ?? "card",
    }]);
    setPlannerOpen(true);
    setMessage("");
  }

  async function reconcileManualApproval() {
    if (requestInFlight.current || !unknownCardAttempt) return;
    const authNo = manualAuthNo.trim();
    if (!/^[A-Za-z0-9]{1,20}$/.test(authNo)) {
      setMessage("승인번호를 영문 또는 숫자 1~20자로 입력해주세요.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(manualAuthDate)) {
      setMessage("승인일자를 확인해주세요.");
      return;
    }
    if (!window.confirm(`${won(unknownCardAttempt.amount)}원 카드 승인번호 ${authNo}를 이 결제와 연결할까요?\n단말기 또는 KPN 관리자에서 승인금액을 먼저 확인해주세요.`)) return;
    requestInFlight.current = true;
    setBusy(`reconcile:${unknownCardAttempt.id}`);
    setMessage("");
    try {
      const data = await post({
        action: "reconcile_approved",
        transactionId: unknownCardAttempt.id,
        authNo,
        authDate: manualAuthDate,
      });
      setOverview(data);
      setManualAuthNo("");
      setMessage("승인번호를 확인해 결제완료로 처리했습니다.");
      await onSettled();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "승인번호 매칭 실패");
    } finally {
      setBusy("");
      requestInFlight.current = false;
    }
  }

  async function changePendingPaymentMethod(payment: PaymentAttempt, paymentMethod: string) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setBusy(`method:${payment.id}`);
    setMessage("");
    try {
      await post({
        action: "change_method",
        transactionId: payment.id,
        paymentMethod,
      });
      setMessage(`${payment.splitIndex}번째 결제수단을 ${PAYMENT_LABELS[paymentMethod] ?? paymentMethod}(으)로 변경했습니다.`);
      await refresh();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "결제수단 변경 실패");
    } finally {
      setBusy("");
      requestInFlight.current = false;
    }
  }

  function openExternalApproval() {
    setExternalAuthNo("");
    setExternalAuthDate(dateInSeoul());
    setExternalApprovalTime(timeInSeoul());
    setExternalAmount(expectedExternalAmount);
    setExternalCardName("");
    setExternalCardLast4("");
    setExternalTerminalId("MPOS-1700AE");
    setExternalReference("");
    setExternalReason("단말기에서 직접 결제 후 수동 연결");
    setExternalReviewed(false);
    setExternalOpen(true);
  }

  function reviewExternalApproval() {
    const authNo = externalAuthNo.trim();
    if (!/^[A-Za-z0-9]{1,20}$/.test(authNo)) {
      setMessage("승인번호를 영문 또는 숫자 1~20자로 입력해주세요.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(externalAuthDate)) {
      setMessage("승인일자를 확인해주세요.");
      return;
    }
    if (externalApprovalTime && !/^\d{2}:\d{2}(?::\d{2})?$/.test(externalApprovalTime)) {
      setMessage("승인시각을 시:분 형식으로 입력해주세요.");
      return;
    }
    if (externalCardLast4 && !/^\d{4}$/.test(externalCardLast4)) {
      setMessage("카드번호 뒤 4자리는 숫자 4자리로 입력해주세요.");
      return;
    }
    if (!externalAmountMatches) {
      setMessage(`승인금액은 현재 연결할 결제금액 ${won(expectedExternalAmount)}원과 정확히 같아야 합니다.`);
      return;
    }
    if (externalReason.trim().length < 2) {
      setMessage("수동 연결 사유를 2자 이상 입력해주세요.");
      return;
    }
    setMessage("");
    setExternalReviewed(true);
  }

  async function importExternalApproval() {
    if (requestInFlight.current || !externalReviewed || !externalAmountMatches) return;
    requestInFlight.current = true;
    setBusy("external-import");
    setMessage("");
    try {
      if (beforePay) await beforePay();
      let activeOverview = overview;
      if (!activeOverview?.payment) {
        activeOverview = await post({
          action: "prepare",
          reservationIds: groupSelectionActive
            ? paymentGroup?.items.map((item) => item.reservationId)
            : undefined,
          mode: "single",
          paymentMethod: "card",
          items: [{ amount: externalAmount, paymentMethod: "card" }],
          addOnAmount,
          addOnSale,
          discountAmount,
          requestKey: crypto.randomUUID(),
        });
        setOverview(activeOverview);
      }
      const pendingCard = activeOverview.plan.find((payment) =>
        payment.paymentMethod === "card" &&
        !["APPROVED", "COMPLETED"].includes(payment.status),
      );
      const completedPlanTopUp = !pendingCard && Boolean(
        activeOverview.payment &&
        activeOverview.payment.status === "PAID" &&
        activeOverview.summary?.amountLocked &&
        activeOverview.summary.remainingAmount === externalAmount &&
        activeOverview.plan.length > 0 &&
        activeOverview.plan.every((payment) => ["APPROVED", "COMPLETED"].includes(payment.status)),
      );
      if ((!pendingCard && !completedPlanTopUp) || (pendingCard && pendingCard.amount !== externalAmount)) {
        throw new Error("승인금액과 현재 결제할 카드 회차 금액이 일치하지 않습니다.");
      }
      const data = await post({
        action: "record_external_approved",
        amount: externalAmount,
        authNo: externalAuthNo.trim(),
        authDate: externalAuthDate,
        approvalTime: externalApprovalTime,
        cardName: externalCardName.trim(),
        cardLast4: externalCardLast4,
        terminalId: externalTerminalId.trim(),
        externalTransactionId: externalReference.trim(),
        reason: externalReason.trim(),
      });
      setOverview(data);
      setExternalOpen(false);
      setExternalReviewed(false);
      setMessage("단말기 직접 승인건을 예약 결제와 연결했습니다. 수동 확인 거래로 기록됩니다.");
      await onSettled();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "단말 직접 승인건 연결 실패");
    } finally {
      setBusy("");
      requestInFlight.current = false;
    }
  }

  async function unlinkExternalApproval() {
    if (requestInFlight.current || !unlinkTarget) return;
    if (unlinkReason.trim().length < 2) {
      setMessage("연결 해제 사유를 2자 이상 입력해주세요.");
      return;
    }
    requestInFlight.current = true;
    setBusy(`unlink:${unlinkTarget.id}`);
    setMessage("");
    try {
      const data = await post({
        action: "unlink_external_approved",
        transactionId: unlinkTarget.id,
        reason: unlinkReason.trim(),
      });
      setOverview(data);
      setUnlinkTarget(null);
      setUnlinkReason("");
      setMessage("예약과 결제내역의 연결만 해제했습니다. 카드 승인은 취소되지 않았습니다.");
      await onSettled();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "단말 직접 승인건 연결 해제 실패");
    } finally {
      setBusy("");
      requestInFlight.current = false;
    }
  }

  const maskApproval = (value: string) => value ? `******${value.slice(-2)}` : "저장됨";
  const currentPayment = currentSplitIndex == null
    ? null
    : visiblePlan.find((payment) => payment.splitIndex === currentSplitIndex) ?? null;
  const expectedExternalAmount = currentPayment?.amount ?? remainingAmount;
  const externalAmountMatches = externalAmount > 0 && externalAmount === expectedExternalAmount;
  const hasActiveTerminalDirect = visiblePlan.some((payment) =>
    payment.transactionSource === "TERMINAL_DIRECT" &&
    ["APPROVED", "COMPLETED"].includes(payment.status) &&
    !cancelledOriginals.has(payment.id),
  );
  const terminalChecking = !overview || busy === "status";
  const terminalTone = terminalChecking ? "checking" : terminal?.connected && terminal.paymentReady ? "ready" : terminal?.connected ? "checking" : "offline";
  const terminalTitle = terminalChecking
    ? "카드 단말 연결 확인 중"
    : terminal?.connected && terminal.paymentReady
      ? "카드 단말 준비됨"
      : terminal?.connected
        ? "카드 단말 연결됨"
        : "카드 단말 연결 안됨";
  const paymentMethodIcon: Record<string, string> = { card: "▣", cash: "₩", account: "↔", coupon: "◇" };
  const firstDraft = configuredItems[0];
  const completedPlanTopUpAvailable = Boolean(
    !currentPayment &&
    planLocked &&
    remainingAmount > 0 &&
    overview?.payment?.status === "PAID" &&
    visiblePlan.length > 0 &&
    visiblePlan.every((payment) => ["APPROVED", "COMPLETED"].includes(payment.status)),
  );
  const externalCardPaymentAvailable = currentPayment?.paymentMethod === "card" ||
    (!currentPayment && !planLocked && firstDraft?.paymentMethod === "card") ||
    completedPlanTopUpAvailable;
  const primaryAmount = firstDraft?.amount ?? payableAmount;
  const primaryMethod = PAYMENT_LABELS[firstDraft?.paymentMethod ?? "card"] ?? "결제";
  const explicitExecution = Boolean(overview?.explicitExecutionV2Enabled);
  const primaryLabel = explicitExecution
    ? "결제 방식 확정"
    : appliedCouponIds.length > 0
      ? `쿠폰 ${appliedCouponIds.length}장 적용 후 결제 시작`
      : mode === "single"
        ? `${won(primaryAmount)}원 ${primaryMethod} 결제`
        : `1번째 ${won(primaryAmount)}원 ${primaryMethod} 결제 시작`;
  const draftDifference = payableAmount - draftTotal;
  const showPaymentProgress = hasProcessing && !summary?.hasUnknown;
  const fullySettled = Boolean(overview && remainingAmount === 0 && completedAmount > 0 && !summary?.hasUnknown);

  function toggleCoupon(couponId: string) {
    const selected = appliedCouponIds.includes(couponId);
    if (!selected && appliedCouponIds.length >= couponSlots.length) return;
    const nextIds = selected
      ? appliedCouponIds.filter((candidate) => candidate !== couponId)
      : [...appliedCouponIds, couponId];
    const nextAllocations = allocateMemberCoupons({
      couponIds: nextIds,
      adultCount: participantAdultCount,
      youthCount: participantYouthCount,
      adultPrice: pricing.adultPrice,
      youthPrice: pricing.youthPrice,
      maximumCouponAmount,
    });
    const nextCouponAmount = nextAllocations.reduce((sum, allocation) => sum + allocation.amount, 0);
    setCouponSelection({ contextKey: couponSelectionContextKey, ids: nextIds });
    if (mode === "custom") {
      setDraftItems((current) => rebalanceDraftItems(current, Math.max(0, payableAmount - nextCouponAmount)));
    }
    setMessage("");
  }

  function choosePaymentMethod(paymentMethod: string) {
    if (methodPickerIndex == null) return;
    const targetIndex = methodPickerIndex;
    setDraftItems((current) => {
      const next = [...current];
      while (next.length <= targetIndex) {
        const configured = cashConfiguredItems[next.length];
        next.push({ amount: configured?.amount ?? 0, paymentMethod: configured?.paymentMethod ?? "card" });
      }
      next[targetIndex] = {
        ...next[targetIndex],
        amount: cashConfiguredItems[targetIndex]?.amount ?? next[targetIndex].amount,
        paymentMethod,
        memberCouponId: undefined,
        couponParticipantType: undefined,
      };
      return next;
    });
    setMethodPickerIndex(null);
  }

  return (
    <>
    <section className="terminal-payment-panel" aria-label="분할·복합결제">
      <div className="terminal-payment-head">
        <div className={`terminal-status-badge is-${terminalTone}`}>
          <span className={`terminal-dot is-${terminalTone}`} />
          <div>
            <strong>{terminalTitle}</strong>
            <small>{terminal?.model || "MPOS-1700AE"}</small>
          </div>
        </div>
        <button type="button" className="terminal-status-button" disabled={Boolean(busy)} onClick={() => void checkTerminal()}>{busy === "status" ? "확인 중…" : "상태 확인"}</button>
      </div>

      {paymentGroup && paymentGroup.items.length > 1 ? (
        <section className={`payment-group-box ${groupSelectionActive ? "is-active" : ""}`}>
          <div className="payment-group-heading">
            <div>
              <strong>한판더 함께 결제</strong>
              <span>한 번만 결제하고 게임별 매출은 각각 나눠 저장합니다.</span>
            </div>
            <label className="payment-group-toggle">
              <input
                type="checkbox"
                checked={groupSelectionActive}
                disabled={paymentGroup.isPaymentGroup || planLocked || !paymentGroup.eligible}
                onChange={(event) => changeGroupPayment(event.target.checked)}
              />
              <span>{groupSelectionActive ? "묶음" : "개별"}</span>
            </label>
          </div>
          <div className="payment-group-items">
            {paymentGroup.items.map((item) => {
              const isCurrent = item.reservationId === reservation.id;
              const finalAmount = isCurrent ? amount : item.finalAmount;
              const depositAmount = isCurrent ? initialDepositAmount : item.depositAmount;
              return (
                <article key={item.reservationId} className={isCurrent ? "is-current" : ""}>
                  <b>{item.sequence}게임 · {item.scheduledTime}</b>
                  <span>{item.roomCode} · 성인 {item.adultCount}명 · 청소년 {item.youthCount}명</span>
                  <strong>{won(finalAmount)}원</strong>
                  {depositAmount > 0 ? <small>예약금 {won(depositAmount)}원 포함</small> : null}
                </article>
              );
            })}
          </div>
          {!paymentGroup.eligible && !paymentGroup.isPaymentGroup ? (
            <small className="terminal-error">이미 결제했거나 취소된 게임이 있어 묶음 결제를 사용할 수 없습니다.</small>
          ) : null}
        </section>
      ) : null}

      <div className="split-payment-summary">
        <div className="is-remaining"><span>남은 결제금액</span><strong>{won(remainingAmount)}원</strong></div>
        <div className="payment-summary-support">
          <p><span>완료</span><strong>{won(completedAmount)}원</strong></p>
          <p><span>총 현장결제</span><strong>{won(payableAmount)}원</strong></p>
        </div>
      </div>
      {effectiveDepositAmount ? (
        <p className="split-payment-deposit">총 매출 {won(summary?.finalAmount ?? editableFinalAmount)}원 중 네이버 예약금 {won(effectiveDepositAmount)}원은 현장 분할결제에서 제외됩니다.</p>
      ) : null}
      {summary?.hasUnknown ? (
        <div className="terminal-reconciliation" role="alert">
          <strong>결제 결과 확인 필요</strong>
          <span>카드사 또는 KPN 관리자 자료에서 거래 결과를 먼저 확인해주세요.</span>
          <span>중복 승인을 막기 위해 추가 결제와 취소를 차단했습니다.</span>
          {unknownCardAttempt ? (
            <div className="terminal-manual-approval">
              <b>단말기 직접 승인 내역 연결</b>
              <span>{unknownCardAttempt.splitIndex}회차 · {won(unknownCardAttempt.amount)}원</span>
              <label>
                <span>승인번호</span>
                <input
                  value={manualAuthNo}
                  maxLength={20}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="예: 12345678"
                  onChange={(event) => setManualAuthNo(event.target.value.replace(/\s/g, ""))}
                />
              </label>
              <label>
                <span>승인일자</span>
                <input type="date" value={manualAuthDate} onChange={(event) => setManualAuthDate(event.target.value)} />
              </label>
              <button type="button" disabled={Boolean(busy)} onClick={() => void reconcileManualApproval()}>
                {busy.startsWith("reconcile:") ? "확인 중…" : "승인번호로 결제완료"}
              </button>
              <small>실제 단말 승인건을 확인한 경우에만 입력하세요. 중복 승인번호와 다른 금액은 저장되지 않습니다.</small>
            </div>
          ) : null}
        </div>
      ) : null}
      {!terminal?.connected && terminal?.responseMessage ? <p className="terminal-error">{terminal.responseMessage}</p> : null}
      {message ? <p className="terminal-message" role="status">{message}</p> : null}

      {showPaymentProgress ? (
        <div className="terminal-flow-state is-processing" role="status" aria-live="polite">
          <span className="terminal-flow-icon"><i /></span>
          <div><strong>카드 결제 중</strong><b>{won(currentPayment?.amount ?? remainingAmount)}원</b><p>단말기에 금액을 전송했어요. 카드를 꽂거나 태그해주세요.</p><small>● {terminal?.model || "MPOS-1700AE"} 연결됨</small></div>
        </div>
      ) : fullySettled ? (
        <div className="terminal-flow-state is-complete" role="status">
          <span className="terminal-flow-icon">✓</span>
          <div><strong>결제 완료</strong><b>{won(completedAmount)}원</b><p>모든 현장 결제가 정상적으로 처리되었습니다.</p></div>
        </div>
      ) : null}

      {!planLocked && plannerOpen ? (
        <div className="payment-plan-builder">
          {!["member_pass_purchase", "add_on_sale_purchase"].includes(reservation.source) ? (
            <section className="member-coupon-payment-box" aria-label="회원 쿠폰 적용">
              <div className="member-coupon-payment-heading">
                <div>
                  <strong>회원 쿠폰 적용</strong>
                  <span>쿠폰 1장당 이용자 1명의 게임비만 적용됩니다.</span>
                </div>
                <b>{appliedCouponIds.length} / {Math.min(eligibleCoupons.length, couponSlots.length)}장</b>
              </div>
              {groupSelectionActive ? (
                <p className="member-coupon-payment-empty">쿠폰은 예약별로 적용됩니다. 위의 묶음 결제를 ‘개별’로 바꿔주세요.</p>
              ) : !reservation.memberId ? (
                <p className="member-coupon-payment-empty">예약에 회원을 연결하면 보유 쿠폰을 선택할 수 있습니다.</p>
              ) : eligibleCoupons.length === 0 ? (
                <p className="member-coupon-payment-empty">이 예약에 사용할 수 있는 쿠폰이 없습니다.</p>
              ) : couponSlots.length === 0 ? (
                <p className="member-coupon-payment-empty">현장에서 결제할 게임비가 없어 쿠폰을 적용할 수 없습니다.</p>
              ) : (
                <div className="member-coupon-payment-list">
                  {eligibleCoupons.map((coupon) => {
                    const allocation = couponAllocationById.get(coupon.id);
                    const selected = Boolean(allocation);
                    const capacityReached = !selected && appliedCouponIds.length >= couponSlots.length;
                    return (
                      <button
                        type="button"
                        className={selected ? "is-selected" : ""}
                        disabled={capacityReached}
                        aria-pressed={selected}
                        key={coupon.id}
                        onClick={() => toggleCoupon(coupon.id)}
                      >
                        <span className="member-coupon-check" aria-hidden="true">{selected ? "✓" : "◇"}</span>
                        <span>
                          <strong>{coupon.name}</strong>
                          <small>유효기간 {coupon.expiresAt.slice(0, 10)}</small>
                        </span>
                        <b>{allocation ? `${allocation.participantType === "youth" ? "청소년" : "성인"} 1명 · ${won(allocation.amount)}원` : "선택"}</b>
                      </button>
                    );
                  })}
                </div>
              )}
              {couponAllocations.length > 0 ? (
                <div className="member-coupon-payment-summary">
                  <span>쿠폰 {couponAllocations.length}장</span>
                  <strong>-{won(couponAmount)}원</strong>
                  <small>남은 현장 결제 {won(remainingCashAmount)}원 · 부가상품에는 쿠폰이 적용되지 않습니다.</small>
                </div>
              ) : null}
            </section>
          ) : null}
          <div className="payment-section-heading"><strong>결제 방식</strong><span>원하는 결제 방식을 선택하세요.</span></div>
          <div className="payment-mode-tabs" role="tablist" aria-label="결제 방식">
            {([
              ["single", "한 번 결제"],
              ["equal", "N분의1"],
              ["custom", "직접 나누기"],
            ] as const).map(([value, label]) => (
              <button type="button" className={mode === value ? "is-active" : ""} key={value} onClick={() => {
                setMode(value);
                if (value === "custom" && draftItems.length < 2) {
                  setDraftItems(equalAmounts(remainingCashAmount, 2).filter((itemAmount) => itemAmount > 0).map((itemAmount) => ({ amount: itemAmount, paymentMethod: "card" })));
                }
              }}>{label}</button>
            ))}
          </div>
          {mode === "equal" ? (
            <div className="payment-split-count">
              <div><strong>몇 명이 나눠 결제하나요?</strong><span>2명부터 20명까지 나눌 수 있어요.</span></div>
              <div className="payment-count-stepper">
                <button type="button" aria-label="인원 줄이기" disabled={effectiveSplitCount <= 2} onClick={() => setSplitCount((count) => Math.max(2, count - 1))}>−</button>
                <b>{effectiveSplitCount}명</b>
                <button type="button" aria-label="인원 늘리기" disabled={effectiveSplitCount >= maximumCashSplitCount} onClick={() => setSplitCount((count) => Math.min(maximumCashSplitCount, count + 1))}>＋</button>
              </div>
            </div>
          ) : null}
          <div className="payment-draft-list">
            {configuredItems.map((item, index) => {
              const isCoupon = item.paymentMethod === "coupon";
              const cashIndex = index - couponAllocations.length;
              return (
              <article className={`payment-draft-row ${isCoupon ? "is-coupon" : ""}`} key={isCoupon ? `coupon-${item.memberCouponId}` : `${mode}-${cashIndex}`}>
                <header><span>{index + 1}번째 결제</span>{isCoupon ? <small>쿠폰 1장 · {item.couponParticipantType === "youth" ? "청소년" : "성인"} 1명분</small> : mode === "equal" ? <small>{effectiveSplitCount}명 중 {cashIndex + 1}번째</small> : null}</header>
                <div className={`payment-draft-amount ${mode === "custom" && !isCoupon ? "is-editable" : "is-readonly"}`}>
                  <span>금액</span>
                  {mode === "custom" && !isCoupon ? <input
                    aria-label={`${cashIndex + 1}번째 현장 결제 금액`}
                    type="number"
                    min="1"
                    step="100"
                    value={item.amount}
                    onChange={(event) => setDraftItems(cashConfiguredItems.map((candidate, candidateIndex) => candidateIndex === cashIndex ? { ...candidate, amount: Math.max(0, Math.trunc(Number(event.target.value) || 0)) } : candidate))}
                  /> : <strong>{won(item.amount)}원</strong>}
                </div>
                {isCoupon ? <div className="payment-method-trigger is-fixed" aria-label={`${index + 1}번째 결제수단 쿠폰`}>
                  <span className="payment-method-icon" aria-hidden="true">{paymentMethodIcon[item.paymentMethod] ?? "○"}</span>
                  <span><small>적용 쿠폰</small><strong>{memberCoupons.find((coupon) => coupon.id === item.memberCouponId)?.name ?? "회원 쿠폰"}</strong></span>
                  <b aria-hidden="true">✓</b>
                </div> : <button type="button" className="payment-method-trigger" aria-label={`${index + 1}번째 결제수단 ${PAYMENT_LABELS[item.paymentMethod] ?? item.paymentMethod}`} onClick={() => setMethodPickerIndex(cashIndex)}>
                  <span className="payment-method-icon" aria-hidden="true">{paymentMethodIcon[item.paymentMethod] ?? "○"}</span>
                  <span><small>결제수단</small><strong>{PAYMENT_LABELS[item.paymentMethod] ?? item.paymentMethod}</strong></span>
                  <b aria-hidden="true">›</b>
                </button>}
                {mode === "custom" && !isCoupon && cashConfiguredItems.length > 1 ? <button type="button" className="payment-draft-remove" onClick={() => setDraftItems(cashConfiguredItems.filter((_, candidateIndex) => candidateIndex !== cashIndex))}>삭제</button> : null}
              </article>
              );
            })}
          </div>
          {mode === "custom" && configuredItems.length < 20 && remainingCashAmount > 0 ? (
            <button type="button" className="payment-draft-add" onClick={() => setDraftItems([...cashConfiguredItems, { amount: 0, paymentMethod: "card" }])}>+ 결제 회차 추가</button>
          ) : null}
          <div className={`payment-draft-total ${draftValid ? "is-valid" : "is-invalid"}`}>
            <span>분할 금액</span><strong>{won(draftTotal)}원</strong>
            <small>{draftValid ? "결제금액과 일치해요 ✓" : draftDifference > 0 ? `${won(draftDifference)}원이 부족해요` : `${won(Math.abs(draftDifference))}원이 초과됐어요`}</small>
          </div>
          {!draftValid ? <p className="terminal-error">각 금액은 1원 이상이고 합계는 현장 결제금액과 정확히 같아야 합니다.</p> : null}
          <button type="button" className="terminal-pay-button payment-primary-action" disabled={disabled || Boolean(busy) || !draftValid} onClick={() => void preparePlan()}>{busy ? "결제를 준비하는 중…" : primaryLabel}</button>
        </div>
      ) : null}

      {overview && remainingAmount > 0 && !summary?.hasUnknown && externalCardPaymentAvailable ? (
        <button
          type="button"
          className="terminal-external-payment-button"
          disabled={disabled || Boolean(busy) || hasProcessing}
          onClick={openExternalApproval}
        >
          단말에서 이미 결제했어요
        </button>
      ) : null}

      {visiblePlan.length ? (
        <div className="split-payment-history">
          <div className="split-payment-history-head">
            <h4>결제 순서</h4>
            {!planLocked ? <button type="button" onClick={() => setPlannerOpen((value) => !value)}>{plannerOpen ? "계획 닫기" : "계획 수정"}</button> : null}
          </div>
          {visiblePlan.map((payment) => {
            const cancellation = overview?.attempts.find((attempt) => attempt.attemptType === "CANCEL" && attempt.originalAttemptId === payment.id && attempt.status === "CANCELLED");
            const failedCancellation = overview?.attempts.find((attempt) => attempt.attemptType === "CANCEL" && attempt.originalAttemptId === payment.id && ["DECLINED", "USER_CANCELLED", "ERROR"].includes(attempt.status));
            const cancelled = cancelledOriginals.has(payment.id);
            const status = cancelled ? "CANCELLED" : payment.status;
            const isCurrent = currentSplitIndex === payment.splitIndex;
            const retryable = ["DECLINED", "USER_CANCELLED", "ERROR", "BUSY", "UNLINKED"].includes(payment.status);
            const completed = ["APPROVED", "COMPLETED"].includes(payment.status);
            const legacyCard = payment.paymentMethod === "card" && !payment.authNo;
            const terminalDirect = payment.transactionSource === "TERMINAL_DIRECT";
            return (
              <article className={`split-payment-row status-${status.toLowerCase()} ${isCurrent ? "is-current" : ""}`} key={payment.id}>
                <div className="split-payment-row-main">
                  <span className="split-payment-status-mark" aria-hidden="true">{cancelled ? "×" : completed ? "✓" : isCurrent ? "●" : payment.splitIndex}</span>
                  <div><b>{payment.splitIndex}번째 결제</b><small>{payment.paymentMethod === "coupon" ? memberCoupons.find((coupon) => coupon.id === payment.memberCouponId)?.name ?? "회원 쿠폰" : PAYMENT_LABELS[payment.paymentMethod] ?? payment.paymentMethod}</small></div>
                  <strong>{won(payment.amount)}원</strong>
                  <span className="split-payment-status-label">{TERMINAL_PAYMENT_STATUS_LABELS[status] ?? status}</span>
                </div>
                {terminalDirect ? <small className="terminal-direct-badge">단말 직접결제 · 운영자 수동 확인</small> : null}
                {payment.paymentMethod === "card" && completed ? (
                  <small>{payment.issuerName || "카드"} · 승인번호 {maskApproval(payment.authNo)} · {formatPaymentTimeInSeoul({ authDate: payment.authDate, approvalTime: payment.approvalTime, fallbackTimestamp: payment.completedAt || payment.updatedAt })}{payment.maskedCardNo ? ` · ${payment.maskedCardNo}` : ""}</small>
                ) : null}
                {payment.responseMessage && !cancelled ? <small>{payment.responseMessage}</small> : null}
                {cancellation ? <small className="split-payment-refund-history">취소 완료 · {formatPaymentTimeInSeoul({ authDate: cancellation.authDate, approvalTime: cancellation.approvalTime, fallbackTimestamp: cancellation.completedAt || cancellation.updatedAt })}</small> : null}
                {failedCancellation ? <small className="terminal-error">취소 실패 · 전체 취소를 다시 누르면 이 건부터 재시도합니다.</small> : null}
                <div className="split-payment-row-actions">
                  {payment.status === "PENDING" ? (
                    <>
                      <button type="button" className="terminal-pay-button" disabled={disabled || Boolean(busy) || !isCurrent || (payment.paymentMethod === "card" && (!terminal?.connected || !terminal.paymentReady))} onClick={() => void processTransaction(payment)}>{won(payment.amount)}원 {PAYMENT_LABELS[payment.paymentMethod] ?? "결제"} 결제</button>
                      {isCurrent ? <button type="button" className="terminal-method-change-button" disabled={disabled || Boolean(busy)} onClick={() => setPendingMethodTarget(payment)}>결제수단 변경</button> : null}
                    </>
                  ) : null}
                  {retryable && isCurrent ? <button type="button" className="terminal-pay-button" disabled={disabled || Boolean(busy)} onClick={() => void processTransaction(payment, true)}>이 회차 다시 시도</button> : null}
                  {retryable && isCurrent ? <button type="button" className="terminal-method-change-button" disabled={disabled || Boolean(busy)} onClick={() => setRetryMethodTarget(payment)}>결제수단 변경</button> : null}
                  {completed && !cancelled && terminalDirect ? (
                    <button type="button" className="terminal-unlink-button" disabled={disabled || Boolean(busy) || hasProcessing} onClick={() => {
                      setUnlinkReason("");
                      setUnlinkTarget(payment);
                    }}>연결 해제</button>
                  ) : null}
                  {completed && !cancelled && !terminalDirect ? <button type="button" className="terminal-cancel-button" disabled={disabled || Boolean(busy) || hasProcessing || legacyCard} title={legacyCard ? "기존 수기 카드 결제는 승인정보가 없어 단말 자동취소할 수 없습니다." : ""} onClick={() => void cancelTransaction(payment)}>이 건 취소</button> : null}
                </div>
              </article>
            );
          })}
          {completedAmount > 0 ? (
            <button type="button" className="terminal-cancel-all-button" disabled={disabled || Boolean(busy) || hasProcessing || hasActiveTerminalDirect} title={hasActiveTerminalDirect ? "단말 직접 결제건은 자동 취소가 검증되지 않아 먼저 단말 취소 후 연결 해제해야 합니다." : ""} onClick={() => void cancelAll()}>{busy === "cancel-all" ? "전체 취소 준비 중…" : "완료 거래 전체 취소"}</button>
          ) : null}
          {hasActiveTerminalDirect ? <small className="terminal-direct-warning">단말 직접 결제건은 카드 승인취소가 아니라 예약 연결 해제만 지원합니다.</small> : null}
        </div>
      ) : null}
    </section>
    <BottomSheet open={methodPickerIndex != null} title="결제수단 선택" onClose={() => setMethodPickerIndex(null)}>
      <div className="payment-method-sheet">
        <p>{methodPickerIndex == null ? "" : `${methodPickerIndex + 1}번째 결제에 사용할 수단을 선택하세요.`}</p>
        <div>
          {methodOptions.map((option) => {
            const selectedMethod = methodPickerIndex == null ? "" : cashConfiguredItems[methodPickerIndex]?.paymentMethod;
            return <button type="button" className={selectedMethod === option.value ? "is-selected" : ""} key={option.value} onClick={() => choosePaymentMethod(option.value)}>
              <span className="payment-method-icon" aria-hidden="true">{paymentMethodIcon[option.value]}</span>
              <strong>{option.label}</strong>
              <b aria-hidden="true">{selectedMethod === option.value ? "✓" : "›"}</b>
            </button>;
          })}
        </div>
      </div>
    </BottomSheet>
    <BottomSheet open={retryMethodTarget != null || pendingMethodTarget != null} title={pendingMethodTarget ? "결제 전 수단 변경" : "실패한 회차 결제수단 변경"} onClose={() => {
      if (!busy) {
        setRetryMethodTarget(null);
        setPendingMethodTarget(null);
      }
    }}>
      <div className="payment-method-sheet retry-payment-method-sheet">
        <p>{pendingMethodTarget
          ? `${pendingMethodTarget.splitIndex}번째 ${won(pendingMethodTarget.amount)}원 결제수단만 먼저 바꿉니다. 변경 후 결제 버튼을 눌러 진행해주세요.`
          : retryMethodTarget
            ? `${retryMethodTarget.splitIndex}번째 ${won(retryMethodTarget.amount)}원 결제만 새 수단으로 처리합니다. 앞서 승인된 회차는 그대로 유지됩니다.`
            : ""}</p>
        <div>
          {methodOptions.map((option) => {
            const target = pendingMethodTarget ?? retryMethodTarget;
            const selected = pendingMethodTarget?.paymentMethod === option.value;
            const cardUnavailable = !pendingMethodTarget && option.value === "card" && (!terminal?.connected || !terminal.paymentReady);
            return <button type="button" className={selected ? "is-selected" : ""} disabled={Boolean(busy) || cardUnavailable} key={option.value} onClick={() => {
              if (!target) return;
              if (pendingMethodTarget) {
                setPendingMethodTarget(null);
                void changePendingPaymentMethod(target, option.value);
              } else {
                setRetryMethodTarget(null);
                void processTransaction(target, true, option.value);
              }
            }}>
              <span className="payment-method-icon" aria-hidden="true">{paymentMethodIcon[option.value]}</span>
              <strong>{pendingMethodTarget
                ? `${option.label}(으)로 변경`
                : option.value === "card"
                  ? `카드 ${won(retryMethodTarget?.amount ?? 0)}원 다시 결제`
                  : `${option.label} ${won(retryMethodTarget?.amount ?? 0)}원으로 처리`}
                <small>{pendingMethodTarget
                  ? "수단만 변경하며 아직 결제 처리되지 않습니다."
                  : option.value === "card"
                    ? (cardUnavailable ? "현재 카드 단말 연결을 확인해주세요." : "단말기에 새 승인 요청을 보냅니다.")
                    : `단말 승인 없이 ${option.label} 수납으로 기록합니다.`}</small>
              </strong>
              <b aria-hidden="true">{selected ? "✓" : "›"}</b>
            </button>;
          })}
        </div>
      </div>
    </BottomSheet>
    <BottomSheet open={externalOpen} title="단말 직접 결제 연결" onClose={() => {
      if (!busy) setExternalOpen(false);
    }}>
      <div className="terminal-external-payment-sheet">
        <div className="terminal-external-lookup-note">
          <strong>자동 조회 대신 승인전표를 확인해주세요</strong>
          <p>{overview?.terminalImport.reason || "현재 결제 모듈에서 단말 직접 거래 조회 기능을 확인할 수 없어 운영자 확인 방식으로 연결합니다."}</p>
          <small>단말기 또는 KPN 관리자에서 승인번호·일자·금액을 먼저 확인해야 합니다.</small>
        </div>
        {!externalReviewed ? (
          <div className="terminal-external-form">
            <label><span>승인번호 *</span><input value={externalAuthNo} maxLength={20} inputMode="numeric" autoComplete="off" placeholder="예: 12345678" onChange={(event) => setExternalAuthNo(event.target.value.replace(/\s/g, ""))} /></label>
            <div className="terminal-external-form-grid">
              <label><span>승인일자 *</span><input type="date" value={externalAuthDate} onChange={(event) => setExternalAuthDate(event.target.value)} /></label>
              <label><span>승인시각</span><input type="time" step="1" value={externalApprovalTime} onChange={(event) => setExternalApprovalTime(event.target.value)} /></label>
            </div>
            <label className={externalAmountMatches ? "is-matched" : "is-mismatch"}><span>승인금액 *</span><input type="number" min="1" step="100" value={externalAmount || ""} onChange={(event) => setExternalAmount(Math.max(0, Math.trunc(Number(event.target.value) || 0)))} /><small>{externalAmountMatches ? `현재 결제 회차 ${won(expectedExternalAmount)}원과 일치합니다.` : `현재 결제 회차는 ${won(expectedExternalAmount)}원입니다.`}</small></label>
            <div className="terminal-external-form-grid">
              <label><span>카드사</span><input value={externalCardName} maxLength={100} placeholder="예: 현대카드" onChange={(event) => setExternalCardName(event.target.value)} /></label>
              <label><span>카드 뒤 4자리</span><input value={externalCardLast4} maxLength={4} inputMode="numeric" placeholder="선택 입력" onChange={(event) => setExternalCardLast4(event.target.value.replace(/\D/g, "").slice(0, 4))} /></label>
            </div>
            <div className="terminal-external-form-grid">
              <label><span>단말기</span><input value={externalTerminalId} maxLength={80} onChange={(event) => setExternalTerminalId(event.target.value)} /></label>
              <label><span>거래 참조값</span><input value={externalReference} maxLength={100} placeholder="선택 입력" onChange={(event) => setExternalReference(event.target.value)} /></label>
            </div>
            <label><span>연결 사유 *</span><textarea rows={2} maxLength={200} value={externalReason} onChange={(event) => setExternalReason(event.target.value)} /></label>
            <button type="button" className="terminal-external-primary" disabled={Boolean(busy) || !externalAmountMatches} onClick={reviewExternalApproval}>입력 내용 확인</button>
          </div>
        ) : (
          <div className="terminal-external-review">
            <div className="terminal-external-review-reservation"><strong>{reservation.teamName || reservation.customerName || "예약"}</strong><span>{reservation.roomCode} · 성인 {reservation.adultCount}명 · 청소년 {reservation.youthCount}명</span></div>
            <dl>
              <div><dt>승인번호</dt><dd>{externalAuthNo}</dd></div>
              <div><dt>승인일시</dt><dd>{externalAuthDate}{externalApprovalTime ? ` ${externalApprovalTime}` : ""}</dd></div>
              <div><dt>승인금액</dt><dd>{won(externalAmount)}원</dd></div>
              <div><dt>카드</dt><dd>{externalCardName || "미입력"}{externalCardLast4 ? ` · ****${externalCardLast4}` : ""}</dd></div>
              <div><dt>확인 상태</dt><dd>운영자 수동 확인</dd></div>
            </dl>
            <p className="terminal-external-confirm-warning">이 기능은 카드 승인을 새로 요청하지 않습니다. 실제 승인전표와 일치하는지 다시 확인해주세요.</p>
            <div className="terminal-external-review-actions"><button type="button" disabled={Boolean(busy)} onClick={() => setExternalReviewed(false)}>이전</button><button type="button" className="terminal-external-primary" disabled={Boolean(busy)} onClick={() => void importExternalApproval()}>{busy === "external-import" ? "연결 중…" : "확인하고 결제 연결"}</button></div>
          </div>
        )}
      </div>
    </BottomSheet>
    <BottomSheet open={Boolean(unlinkTarget)} title="단말 직접 결제 연결 해제" onClose={() => {
      if (!busy) setUnlinkTarget(null);
    }}>
      <div className="terminal-external-unlink-sheet">
        <strong>{unlinkTarget ? `${won(unlinkTarget.amount)}원 · 승인번호 ${unlinkTarget.authNo}` : ""}</strong>
        <p>예약·매출 연결만 해제됩니다. 카드 승인 자체는 취소되지 않습니다. 단말에서 실제 취소 여부를 먼저 확인해주세요.</p>
        <label><span>연결 해제 사유 *</span><textarea rows={3} maxLength={200} value={unlinkReason} placeholder="예: 단말기에서 직접 승인취소 완료" onChange={(event) => setUnlinkReason(event.target.value)} /></label>
        <button type="button" className="terminal-unlink-confirm" disabled={Boolean(busy) || unlinkReason.trim().length < 2} onClick={() => void unlinkExternalApproval()}>{busy.startsWith("unlink:") ? "해제 중…" : "카드 취소 없이 연결만 해제"}</button>
      </div>
    </BottomSheet>
    </>
  );
}

type ParticipantTopUpMode = "single" | "equal" | "custom";
type ParticipantTopUpDraftItem = {
  amount: number;
  paymentMethod: SharedPaymentMethod;
};

function participantTopUpEqualAmounts(total: number, count: number) {
  const quotient = Math.floor(total / count);
  const remainder = total % count;
  return Array.from(
    { length: count },
    (_, index) => quotient + (index < remainder ? 1 : 0),
  );
}

function ParticipantTopUpControls({
  reservation,
  pricing,
  disabled,
  disabledReason,
  onPrepared,
}: {
  reservation: ReservationRecord;
  pricing: PricingSettings;
  disabled: boolean;
  disabledReason: string;
  onPrepared: (reservation: ReservationRecord) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [additionalAdultCount, setAdditionalAdultCount] = useState(0);
  const [additionalYouthCount, setAdditionalYouthCount] = useState(0);
  const [mode, setMode] = useState<ParticipantTopUpMode>("single");
  const [splitCount, setSplitCount] = useState(2);
  const [draftItems, setDraftItems] = useState<ParticipantTopUpDraftItem[]>([
    { amount: 0, paymentMethod: "card" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRef("");

  const additionalCount = additionalAdultCount + additionalYouthCount;
  const targetTotalCount = reservation.totalCount + additionalCount;
  const topUpAmount =
    additionalAdultCount * pricing.adultPrice +
    additionalYouthCount * pricing.youthPrice;
  const configuredItems: ParticipantTopUpDraftItem[] = mode === "single"
    ? [{
        amount: topUpAmount,
        paymentMethod: draftItems[0]?.paymentMethod ?? "card",
      }]
    : mode === "equal"
      ? participantTopUpEqualAmounts(topUpAmount, splitCount).map((amount, index) => ({
          amount,
          paymentMethod: draftItems[index]?.paymentMethod ?? "card",
        }))
      : draftItems;
  const draftTotal = configuredItems.reduce((sum, item) => sum + item.amount, 0);
  const draftValid = additionalCount > 0 &&
    targetTotalCount <= 10 &&
    configuredItems.length > 0 &&
    configuredItems.every((item) => item.amount > 0) &&
    draftTotal === topUpAmount;

  function resetAndOpen() {
    requestKey.current = crypto.randomUUID();
    setAdditionalAdultCount(0);
    setAdditionalYouthCount(0);
    setMode("single");
    setSplitCount(2);
    setDraftItems([{ amount: 0, paymentMethod: "card" }]);
    setError("");
    setOpen(true);
  }

  function close() {
    if (!busy) setOpen(false);
  }

  function changeMode(nextMode: ParticipantTopUpMode) {
    setMode(nextMode);
    if (nextMode === "custom" && draftItems.length < 2) {
      setDraftItems(
        participantTopUpEqualAmounts(topUpAmount, 2).map((amount) => ({
          amount,
          paymentMethod: "card" as const,
        })),
      );
    }
  }

  function changePaymentMethod(index: number, paymentMethod: SharedPaymentMethod) {
    setDraftItems(
      configuredItems.map((item, itemIndex) =>
        itemIndex === index ? { ...item, paymentMethod } : item,
      ),
    );
  }

  async function prepareTopUp() {
    if (!draftValid || busy) return;
    if (!requestKey.current) requestKey.current = crypto.randomUUID();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "prepare_participant_top_up",
          reservationId: reservation.id,
          expectedAdultCount: reservation.adultCount,
          expectedYouthCount: reservation.youthCount,
          additionalAdultCount,
          additionalYouthCount,
          mode,
          count: mode === "equal" ? splitCount : configuredItems.length,
          paymentMethod: configuredItems[0]?.paymentMethod ?? "card",
          items: configuredItems,
          requestKey: requestKey.current,
        }),
      });
      const data = await response.json() as {
        reservation?: ReservationRecord;
        error?: string;
      };
      if (!response.ok || !data.reservation) {
        throw new Error(data.error ?? "추가 인원 결제 회차를 만들지 못했습니다.");
      }
      await onPrepared(data.reservation);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "추가 인원 결제 회차를 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="participant-topup-launch">
        <div>
          <strong>게임 인원 추가 결제</strong>
          <span>기존 승인 내역은 유지하고 추가 인원 금액만 결제합니다.</span>
          {disabledReason ? <small>{disabledReason}</small> : null}
        </div>
        <button type="button" disabled={disabled || reservation.totalCount >= 10} onClick={resetAndOpen}>
          인원 추가 결제
        </button>
      </div>
      <BottomSheet open={open} title="게임 인원 추가 결제" onClose={close}>
        <div className="participant-topup-sheet">
          <div className="participant-topup-current">
            <span>현재 인원</span>
            <strong>성인 {reservation.adultCount}명 · 청소년 {reservation.youthCount}명</strong>
            <small>결제 완료된 기존 인원과 승인 내역은 변경되지 않습니다.</small>
          </div>
          <div className="participant-topup-count-grid">
            <section>
              <div><strong>성인 추가</strong><small>1명 {won(pricing.adultPrice)}원</small></div>
              <div className="payment-count-stepper">
                <button type="button" aria-label="추가 성인 줄이기" disabled={additionalAdultCount <= 0} onClick={() => setAdditionalAdultCount((count) => Math.max(0, count - 1))}>−</button>
                <b>{additionalAdultCount}명</b>
                <button type="button" aria-label="추가 성인 늘리기" disabled={targetTotalCount >= 10} onClick={() => setAdditionalAdultCount((count) => Math.min(10, count + 1))}>＋</button>
              </div>
            </section>
            <section>
              <div><strong>청소년 추가</strong><small>1명 {won(pricing.youthPrice)}원</small></div>
              <div className="payment-count-stepper">
                <button type="button" aria-label="추가 청소년 줄이기" disabled={additionalYouthCount <= 0} onClick={() => setAdditionalYouthCount((count) => Math.max(0, count - 1))}>−</button>
                <b>{additionalYouthCount}명</b>
                <button type="button" aria-label="추가 청소년 늘리기" disabled={targetTotalCount >= 10} onClick={() => setAdditionalYouthCount((count) => Math.min(10, count + 1))}>＋</button>
              </div>
            </section>
          </div>
          <div className="participant-topup-summary">
            <span>추가 {additionalCount}명 · 변경 후 총 {targetTotalCount}명</span>
            <strong>{won(topUpAmount)}원</strong>
          </div>
          <div className="payment-plan-builder">
            <div className="payment-section-heading"><strong>결제 방식</strong><span>회차를 만든 뒤 아래 결제 버튼을 눌러 실제 결제를 진행합니다.</span></div>
            <div className="payment-mode-tabs" role="tablist" aria-label="추가 인원 결제 방식">
              {([[
                "single", "한 번 결제",
              ], [
                "equal", "N분의1",
              ], [
                "custom", "직접 나누기",
              ]] as const).map(([value, label]) => (
                <button type="button" className={mode === value ? "is-active" : ""} key={value} onClick={() => changeMode(value)}>{label}</button>
              ))}
            </div>
            {mode === "equal" ? (
              <div className="payment-split-count">
                <div><strong>몇 명이 나눠 결제하나요?</strong><span>각 회차마다 카드·현금·계좌를 다르게 선택할 수 있습니다.</span></div>
                <div className="payment-count-stepper">
                  <button type="button" aria-label="분할 인원 줄이기" disabled={splitCount <= 2} onClick={() => setSplitCount((count) => Math.max(2, count - 1))}>−</button>
                  <b>{splitCount}명</b>
                  <button type="button" aria-label="분할 인원 늘리기" disabled={splitCount >= 20} onClick={() => setSplitCount((count) => Math.min(20, count + 1))}>＋</button>
                </div>
              </div>
            ) : null}
            <div className="payment-draft-list">
              {configuredItems.map((item, index) => (
                <article className="payment-draft-row" key={`${mode}-${index}`}>
                  <header><span>{index + 1}번째 결제</span></header>
                  <div className={`payment-draft-amount ${mode === "custom" ? "is-editable" : "is-readonly"}`}>
                    <span>금액</span>
                    {mode === "custom" ? (
                      <input
                        aria-label={`${index + 1}번째 추가 인원 결제 금액`}
                        type="number"
                        min="1"
                        step="100"
                        value={item.amount}
                        onChange={(event) => setDraftItems((current) => current.map((candidate, itemIndex) => itemIndex === index ? { ...candidate, amount: Math.max(0, Math.trunc(Number(event.target.value) || 0)) } : candidate))}
                      />
                    ) : <strong>{won(item.amount)}원</strong>}
                  </div>
                  <label className="participant-topup-method">
                    <span>결제수단</span>
                    <select value={item.paymentMethod} onChange={(event) => changePaymentMethod(index, event.target.value as SharedPaymentMethod)}>
                      {SHARED_PAYMENT_METHODS.map((method) => <option value={method.value} key={method.value}>{method.label}</option>)}
                    </select>
                  </label>
                  {mode === "custom" && configuredItems.length > 1 ? <button type="button" className="payment-draft-remove" onClick={() => setDraftItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}>삭제</button> : null}
                </article>
              ))}
            </div>
            {mode === "custom" && configuredItems.length < 20 ? <button type="button" className="payment-draft-add" onClick={() => setDraftItems((current) => [...current, { amount: 0, paymentMethod: "card" }])}>+ 결제 회차 추가</button> : null}
            <div className={`payment-draft-total ${draftValid ? "is-valid" : "is-invalid"}`}>
              <span>분할 금액</span><strong>{won(draftTotal)}원</strong>
              <small>{draftValid ? "추가 결제금액과 일치해요 ✓" : "추가 결제금액과 합계를 맞춰주세요."}</small>
            </div>
          </div>
          {error ? <p className="quick-booking-error" role="alert">{error}</p> : null}
          <div className="participant-topup-actions">
            <button type="button" disabled={busy} onClick={close}>취소</button>
            <button type="button" className="is-primary" disabled={busy || !draftValid} onClick={() => void prepareTopUp()}>{busy ? "준비 중…" : "추가 결제 회차 만들기"}</button>
          </div>
        </div>
      </BottomSheet>
    </>
  );
}

function nextOperatingSlot(time: string) {
  const index = OPERATING_SLOTS.indexOf(time);
  return index >= 0 ? OPERATING_SLOTS[index + 1] ?? "" : "";
}

function formatRemaining(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

type AvailabilityEstimate = {
  availableSeconds: number;
  availableAt: string;
  queuedReservations: number;
  nextReservationTime: string;
  basis: "controller" | "schedule" | "available";
};

function clockInSeoul(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

function currentReservationSlotStartsAt(now: number) {
  const slotTime = currentOperatingSlot(clockInSeoul(now), OPERATING_SLOTS);
  return new Date(
    `${dateInSeoul(new Date(now))}T${slotTime}:00+09:00`,
  ).getTime();
}

function runningGameStartedAt(room: Room | undefined, now: number) {
  if (room?.status !== "running") return null;

  const storedStartedAt = databaseTimestamp(room.gameStartedAt);
  if (Number.isFinite(storedStartedAt)) return storedStartedAt;

  const observedAt = databaseTimestamp(room.updatedAt);
  const syncedAt = Number.isFinite(observedAt) ? observedAt : now;
  const gameSeconds = GAME_DURATION_MINUTES * 60;
  const remainingSeconds = Math.min(
    gameSeconds,
    Math.max(0, room.remainingSeconds),
  );
  return syncedAt - (gameSeconds - remainingSeconds) * 1_000;
}

function estimateAvailability(
  room: Room | undefined,
  roomCode: string,
  reservations: ReservationRecord[],
  now = Date.now(),
): AvailabilityEstimate | null {
  const reservationSlots = reservations
    .filter((reservation) => reservation.roomCode === roomCode)
    .map((reservation) => ({
      startsAt: new Date(
        `${reservation.scheduledDate}T${reservation.scheduledTime}:00+09:00`,
      ).getTime(),
      status: reservation.status,
      scheduledTime: reservation.scheduledTime,
      teamName: reservation.teamName,
    }))
    .filter((item) => Number.isFinite(item.startsAt))
    .sort((left, right) => left.startsAt - right.startsAt);

  const availability = calculateNextGameAvailability({
    now,
    gameStartedAt: runningGameStartedAt(room, now),
    controllerRemainingSeconds:
      room?.status === "running" ? room.remainingSeconds : null,
    currentTeamName: room?.teamName ?? "",
    currentReservationStartsAt:
      room?.status === "running" ? currentReservationSlotStartsAt(now) : null,
    reservations: reservationSlots,
  });

  if (
    availability.basis === "available" &&
    (!room || room.status === "offline" || room.status === "error")
  ) {
    return null;
  }

  return {
    availableSeconds: availability.availableSeconds,
    availableAt: clockInSeoul(availability.availableAt),
    queuedReservations: availability.queuedReservations,
    nextReservationTime: availability.nextReservationTime,
    basis: availability.basis,
  };
}

function sourceLabel(source: string) {
  if (source === "naver") return "네이버 예약";
  if (source === "web_walkin") return "예약 접수 사이트";
  if (source === "admin_manual") return "직원 입력";
  if (source === "admin_repeat") return "한판 더";
  return source;
}

function reservationDeposit(
  source: string,
  grossAmount: number,
  depositAmount: number,
) {
  return source === "naver"
    ? Math.min(depositAmount, Math.max(0, grossAmount))
    : 0;
}

function scheduleRevenueAmount(
  reservation: ReservationRecord,
  cancellationFeeAmount: number,
) {
  return reservation.status === "cancelled"
    ? naverSameDayCancellationFee(reservation, cancellationFeeAmount)
    : expectedAmount(reservation);
}

function sharedSalesAmountByMethod(
  sales: DailySharedSales,
  method: SharedPaymentMethod,
  unitPrices: Record<SharedSalesCategory, number>,
) {
  return (Object.keys(unitPrices) as SharedSalesCategory[]).reduce(
    (total, category) =>
      total + sales[category][method] * unitPrices[category],
    0,
  );
}

function sharedSalesCategoryTotal(
  sales: DailySharedSales,
  category: SharedSalesCategory,
  unitPrices: Record<SharedSalesCategory, number>,
) {
  return (
    Object.values(sales[category]).reduce((sum, count) => sum + count, 0) *
    unitPrices[category]
  );
}

function SharedSalesPanel({
  sales,
  totalSales,
  editMode,
  loading,
  saving,
  notice,
  unitPrices,
  onChange,
  onSave,
  onStartEdit,
  onCancelEdit,
}: {
  sales: DailySharedSales;
  totalSales: DailySharedSales;
  editMode: boolean;
  loading: boolean;
  saving: boolean;
  notice: string;
  unitPrices: Record<SharedSalesCategory, number>;
  onChange: (
    category: SharedSalesCategory,
    method: SharedPaymentMethod,
    count: number,
  ) => void;
  onSave: () => Promise<void>;
  onStartEdit: () => void;
  onCancelEdit: () => void;
}) {
  const [passesOpen, setPassesOpen] = useState(false);
  const categoryRows: Array<{
    value: SharedSalesCategory;
    label: string;
  }> = [
    { value: "slush", label: "슬러시" },
    { value: "beverage", label: "음료" },
    { value: "other", label: "양말" },
    { value: "youthPass10", label: "청소년 10회" },
    { value: "youthPass20", label: "청소년 20회" },
    { value: "adultPass10", label: "성인 10회" },
    { value: "adultPass20", label: "성인 20회" },
  ];
  const regularRows = categoryRows.slice(0, 3);
  const passRows = categoryRows.slice(3);

  const renderCategoryRow = (category: (typeof categoryRows)[number]) => {
    const categoryCount = Object.values(sales[category.value]).reduce(
      (sum, count) => sum + count,
      0,
    );
    const categoryTotal =
      categoryCount * unitPrices[category.value];

    return (
      <div className="shared-sales-row" key={category.value}>
        <strong>
          {category.label}
          <small>{won(unitPrices[category.value])}원</small>
        </strong>
        {SHARED_PAYMENT_METHODS.map((method) => (
          <label key={method.value}>
            <span>{category.label} {method.label} 판매 개수</span>
            <input
              type="number"
              min="0"
              max="999"
              step="1"
              inputMode="numeric"
              disabled={loading || saving}
              value={sales[category.value][method.value] || ""}
              placeholder="0"
              onChange={(event) =>
                onChange(
                  category.value,
                  method.value,
                  Math.max(0, Math.min(999, Math.trunc(Number(event.target.value) || 0))),
                )
              }
            />
          </label>
        ))}
        <b>{won(categoryTotal)}원</b>
      </div>
    );
  };

  return (
    <aside className="shared-sales-panel" aria-labelledby="shared-sales-title">
      <div className="shared-sales-heading">
        <div>
          <h3 id="shared-sales-title">공용 부가매출 <small>오늘 누적 · {editMode ? "수정 중" : "빠른 추가"}</small></h3>
          <strong>{won(sharedSalesTotal(totalSales, unitPrices))}원</strong>
        </div>
        <button
          type="button"
          className={editMode ? "is-editing" : ""}
          disabled={loading || saving}
          onClick={editMode ? onCancelEdit : onStartEdit}
        >
          {editMode ? "수정 취소" : "누적 수정"}
        </button>
      </div>
      <div className={`shared-sales-table ${loading ? "is-loading" : ""}`}>
        <div className="shared-sales-row shared-sales-labels" aria-hidden="true">
          <strong>구분</strong>
          {SHARED_PAYMENT_METHODS.map((method) => (
            <strong key={method.value}>{method.label}</strong>
          ))}
          <strong>합계</strong>
        </div>
        {regularRows.map(renderCategoryRow)}
        <button
          type="button"
          className="shared-sales-group-toggle"
          aria-expanded={passesOpen}
          aria-controls="shared-sales-pass-rows"
          onClick={() => setPassesOpen((open) => !open)}
        >
          <strong>다회권</strong>
          <span>{passesOpen ? "접기 ▲" : "펼치기 ▼"}</span>
        </button>
        {passesOpen ? (
          <div id="shared-sales-pass-rows" className="shared-sales-pass-rows">
            {passRows.map(renderCategoryRow)}
          </div>
        ) : null}
      </div>
      <div
        className={`shared-sales-current-total ${editMode ? "is-editing" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span>
          <small>
            {editMode ? "수정 후 오늘 누적 금액" : "지금 입력한 판매 금액"}
          </small>
          현재 합계
        </span>
        <strong>{won(sharedSalesTotal(sales, unitPrices))}원</strong>
      </div>
      <div
        className="shared-sales-payment-totals"
        aria-label="공용 부가매출 결제수단별 누적 합계"
      >
        {SHARED_PAYMENT_METHODS.map((method) => (
          <span key={method.value}>
            <small>{method.label} 합계</small>
            <strong>{won(sharedSalesAmountByMethod(totalSales, method.value, unitPrices))}원</strong>
          </span>
        ))}
      </div>
      <div className="shared-sales-footer">
        <span role="status">
          {notice || (editMode
            ? "현재 누적 개수를 고쳐 저장할 수 있습니다."
            : "새 판매 개수 입력 · 저장 후 0 초기화")}
        </span>
        <button type="button" disabled={loading || saving} onClick={() => void onSave()}>
          {saving ? "저장 중…" : editMode ? "수정 저장" : "추가 저장"}
        </button>
      </div>
    </aside>
  );
}

export function QuickBookingModal({
  date,
  selection,
  status,
  manualStartMode,
  title,
  extraPanel,
  onClose,
  onSaved,
  onOpenCopied,
  onRefreshStatus,
  pricing,
}: {
  date: string;
  selection: ScheduleSelection;
  status: StatusResponse | null;
  manualStartMode: boolean;
  title?: string;
  extraPanel?: ReactNode;
  onClose: () => void;
  onSaved: (change: ReservationListChange) => Promise<void>;
  onOpenCopied: (reservation: ReservationRecord) => void;
  onRefreshStatus: () => Promise<void>;
  pricing: PricingSettings;
}) {
  const initialReservation = selection.reservation;
  const initialRoom = initialReservation?.roomCode ?? selection.roomCode;
  const [reservation, setReservation] = useState(initialReservation);
  const [roomCode, setRoomCode] = useState(initialRoom);
  const [teamName, setTeamName] = useState(initialReservation?.teamName ?? "");
  const [difficultyCode, setDifficultyCode] = useState(() =>
    initialReservation
      ? resolveReservationDifficultyCode(
          initialReservation.difficultyCode,
          initialReservation.difficultyLabel,
          initialRoom,
        )
      : "basic",
  );
  const [adultCount, setAdultCount] = useState(
    initialReservation?.adultCount ?? 2,
  );
  const [youthCount, setYouthCount] = useState(initialReservation?.youthCount ?? 0);
  const [vehicleLast4, setVehicleLast4] = useState(initialReservation?.vehicleLast4 ?? "");
  const [memo, setMemo] = useState(initialReservation?.memo ?? "");
  const [manualAddOnAmount, setManualAddOnAmount] = useState(initialReservation?.addOnAmount ?? 0);
  const [checkoutAddOnCounts, setCheckoutAddOnCounts] = useState({
    slush: 0,
    beverage: 0,
    other: 0,
  });
  const [checkoutExtraCounts, setCheckoutExtraCounts] = useState<Record<string, number>>({});
  const [attachedAddOnLoading, setAttachedAddOnLoading] = useState(Boolean(initialReservation));
  const [discountAmount, setDiscountAmount] = useState(initialReservation?.discountAmount ?? 0);
  const [paymentMethod, setPaymentMethod] = useState(initialReservation?.paymentMethod || "card");
  const [terminalAmountLocked, setTerminalAmountLocked] = useState(false);
  const [mixedPayment, setMixedPayment] = useState<PaymentSplit>({
    card: initialReservation?.paymentCardAmount ?? 0,
    cash: initialReservation?.paymentCashAmount ?? 0,
    account: initialReservation?.paymentAccountAmount ?? 0,
  });
  const { operations, startOperation, finishOperation } = useBookingOperationLocks();
  const controlBusy = operations.control;
  const paymentBusy = operations.payment;
  const reservationBusy = operations.reservation;
  const memoBusy = operations.memo;
  const parkingBusy = operations.parking;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [parkingAutoEnabled, setParkingAutoEnabled] = useState(false);
  const [parkingExplicitRequest, setParkingExplicitRequest] = useState(false);
  const totalCount = adultCount + youthCount;
  const amount =
    adultCount * pricing.adultPrice + youthCount * pricing.youthPrice;
  const addOnCatalog = [
    { code: "slush", name: "슬러시", price: pricing.slushPrice },
    { code: "beverage", name: "음료", price: pricing.beveragePrice },
    { code: "other", name: "양말", price: pricing.otherPrice },
    ...pricing.extraAddOnItems
      .filter((item) => item.active)
      .map((item) => ({ code: item.code, name: item.name, price: item.price })),
  ];
  const catalogAddOnAmount =
    checkoutAddOnCounts.slush * pricing.slushPrice +
    checkoutAddOnCounts.beverage * pricing.beveragePrice +
    checkoutAddOnCounts.other * pricing.otherPrice +
    pricing.extraAddOnItems.reduce(
      (sum, item) => sum + (item.active ? (checkoutExtraCounts[item.code] ?? 0) * item.price : 0),
      0,
    );
  const addOnAmount = manualAddOnAmount + catalogAddOnAmount;
  const addOnSaleSelection: AddOnCheckoutSelection = {
    ...checkoutAddOnCounts,
    items: pricing.extraAddOnItems
      .filter((item) => item.active && (checkoutExtraCounts[item.code] ?? 0) > 0)
      .map((item) => ({ code: item.code, quantity: checkoutExtraCounts[item.code] })),
  };
  const grossPaymentAmount = Math.max(0, amount + addOnAmount - discountAmount);
  const depositEligibleAmount = Math.max(0, grossPaymentAmount - catalogAddOnAmount);
  const depositAmount = reservationDeposit(
    reservation?.source ?? "",
    depositEligibleAmount,
    pricing.naverDepositAmount,
  );
  const paymentDue = Math.max(0, grossPaymentAmount - depositAmount);
  const isCancelled = reservation?.status === "cancelled";
  const isClosed = reservation?.status === "cancelled" || reservation?.status === "completed";
  const reservationControlBusy = Boolean(reservationBusy || controlBusy);
  const roomConfig = getRoom(roomCode);
  const liveRoom = status?.rooms.find((room) => room.roomId === roomConfig?.roomId);
  const difficultyOptions = getDifficultyOptions(roomCode);
  const agentReady = Boolean(
    status?.store.agentOnline &&
      status.store.controlArmed &&
      status.store.managerVisible,
  );
  const hasUnsavedReservationChanges = Boolean(
    reservation &&
      (
        reservation.roomCode !== roomCode ||
        reservation.teamName !== teamName.trim() ||
        reservation.baseAmount !== amount ||
        resolveReservationDifficultyCode(
          reservation.difficultyCode,
          reservation.difficultyLabel,
          reservation.roomCode,
        ) !== difficultyCode ||
        reservation.adultCount !== adultCount ||
        reservation.youthCount !== youthCount ||
        (reservation.vehicleLast4 ?? "") !== vehicleLast4 ||
        (reservation.memo ?? "") !== memo
      ),
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/settings", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as {
          parking?: { autoRegistrationEnabled?: boolean };
        };
        if (response.ok) setParkingAutoEnabled(data.parking?.autoRegistrationEnabled === true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  async function registerParkingDiscount() {
    if (!reservation || !/^\d{4}$/.test(vehicleLast4) || parkingBusy) return;
    const action = "register";
    if (!startOperation("parking", action)) return;
    setError("");
    setNotice("주차등록을 처리하고 있습니다…");
    try {
      const response = await fetch("/api/parking-discount/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reservationId: reservation.id,
          carLast4: vehicleLast4,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const data = await response.json() as {
        request?: ParkingDiscountRequestView;
        reservation?: ReservationRecord | null;
        error?: string;
      };
      if (!response.ok || !data.request) throw new Error(data.error ?? "주차등록 요청을 시작하지 못했습니다.");

      if (data.reservation) {
        setReservation(data.reservation);
        await onSaved({ type: "upsert", reservation: data.reservation });
      }

      let current = data.request;
      const deadline = Date.now() + 75_000;
      while (PARKING_PENDING_STATUSES.has(current.status) && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        const statusResponse = await fetch(
          `/api/parking-discount/register?id=${encodeURIComponent(current.id)}`,
          { cache: "no-store" },
        );
        const statusData = await statusResponse.json() as {
          request?: ParkingDiscountRequestView;
          reservation?: ReservationRecord | null;
          error?: string;
        };
        if (!statusResponse.ok || !statusData.request) {
          throw new Error(statusData.error ?? "주차등록 결과를 확인하지 못했습니다.");
        }
        current = statusData.request;
        if (statusData.reservation) {
          setReservation(statusData.reservation);
          await onSaved({ type: "upsert", reservation: statusData.reservation });
        }
      }
      if (PARKING_PENDING_STATUSES.has(current.status)) {
        throw new Error("주차등록 처리가 지연되고 있습니다. 잠시 후 다시 확인해주세요.");
      }
      const messages = current.results.map((item) => item.message).filter(Boolean);
      const summary = messages.length ? messages.join(" · ") : current.errorMessage;
      if (current.dryRun) {
        setNotice(`DRY RUN · 실제 할인은 등록하지 않았습니다. ${summary || "등록 가능 여부를 확인했습니다."}`);
      } else if (["SUCCESS", "SKIPPED", "LIMIT_EXCEEDED"].includes(current.status)) {
        setParkingExplicitRequest(false);
        setNotice("주차등록이 완료되었습니다. 차량번호는 예약에 그대로 보관됩니다.");
      } else {
        throw new Error(summary || "주차 할인을 등록하지 못했습니다.");
      }
    } catch (reason) {
      setNotice("");
      setError(reason instanceof Error ? reason.message : "주차 할인을 등록하지 못했습니다.");
    } finally {
      finishOperation("parking", action);
    }
  }

  useEffect(() => {
    const reservationId = reservation?.id;
    if (!reservationId || ["member_pass_purchase", "add_on_sale_purchase"].includes(reservation.source)) {
      setAttachedAddOnLoading(false);
      return;
    }
    const controller = new AbortController();
    setAttachedAddOnLoading(true);
    void fetch(`/api/admin/add-on-sales?reservationId=${encodeURIComponent(reservationId)}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json() as { order?: AttachedAddOnSaleResponse | null; error?: string };
      if (!response.ok) throw new Error(data.error ?? "부가상품 내역을 불러오지 못했습니다.");
      const order = data.order;
      if (order) {
        setCheckoutAddOnCounts(order.counts);
        setCheckoutExtraCounts(Object.fromEntries(order.items.map((item) => [item.code, item.quantity])));
        setManualAddOnAmount(Math.max(0, reservation.addOnAmount - order.amount));
      } else {
        setCheckoutAddOnCounts({ slush: 0, beverage: 0, other: 0 });
        setCheckoutExtraCounts({});
        setManualAddOnAmount(reservation.addOnAmount);
      }
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "부가상품 내역을 불러오지 못했습니다.");
    }).finally(() => {
      if (!controller.signal.aborted) setAttachedAddOnLoading(false);
    });
    return () => controller.abort();
  }, [reservation?.id]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  function changeCheckoutAddOn(code: string, delta: number) {
    if (["slush", "beverage", "other"].includes(code)) {
      const key = code as keyof typeof checkoutAddOnCounts;
      setCheckoutAddOnCounts((current) => ({
        ...current,
        [key]: Math.max(0, Math.min(99, current[key] + delta)),
      }));
      return;
    }
    setCheckoutExtraCounts((current) => ({
      ...current,
      [code]: Math.max(0, Math.min(99, (current[code] ?? 0) + delta)),
    }));
  }

  async function copyInputValue(value: string, label: string) {
    const normalized = value.trim();
    if (!normalized) return;
    setError("");
    try {
      await navigator.clipboard.writeText(normalized);
      setNotice(`${label}을(를) 복사했습니다.`);
    } catch {
      setNotice(`${label}을(를) 복사하지 못했습니다. 다시 눌러주세요.`);
    }
  }

  async function persistDetails() {
    const response = await fetch("/api/admin/reservations", {
      method: reservation ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(reservation ? { id: reservation.id, action: "details" } : {}),
        scheduledDate: date,
        scheduledTime: selection.time,
        roomCode,
        teamName: teamName.trim(),
        difficultyCode,
        adultCount,
        youthCount,
        vehicleLast4,
        memo,
      }),
    });
    const data = (await response.json()) as {
      reservation?: ReservationRecord;
      error?: string;
    };
    if (!response.ok || !data.reservation) {
      throw new Error(data.error ?? "예약 칸을 저장하지 못했습니다.");
    }
    setReservation(data.reservation);
    await onSaved({ type: "upsert", reservation: data.reservation });
    return data.reservation;
  }

  async function patchReservation(id: string, command: Mutation) {
    const response = await fetch("/api/admin/reservations", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...command }),
    });
    const data = (await response.json()) as {
      reservation?: ReservationRecord;
      error?: string;
    };
    if (!response.ok || !data.reservation) {
      throw new Error(data.error ?? "예약을 처리하지 못했습니다.");
    }
    setReservation(data.reservation);
    await onSaved({ type: "upsert", reservation: data.reservation });
    return data.reservation;
  }

  async function save() {
    const action = "save";
    if (!startOperation("reservation", action)) return;
    setError("");
    setNotice("");
    try {
      const wasExisting = Boolean(reservation);
      await persistDetails();
      setNotice(wasExisting ? "예약 내용을 저장했습니다." : "예약 칸을 추가했습니다. 아래에서 바로 운영할 수 있습니다.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "예약 칸을 저장하지 못했습니다.");
    } finally {
      finishOperation("reservation", action);
    }
  }

  async function mutate(command: Mutation, success: string) {
    if (!reservation) return;
    const domain = mutationOperationDomain(command);
    if (!startOperation(domain, command.action)) return;
    setError("");
    setNotice("");
    try {
      await patchReservation(reservation.id, command);
      setNotice(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "예약을 처리하지 못했습니다.");
    } finally {
      finishOperation(domain, command.action);
    }
  }

  async function saveMemo() {
    if (!reservation) return;
    await mutate({ action: "memo", memo }, "메모를 저장했습니다.");
  }

  async function sendManager(action: "set_info" | "start") {
    const difficulty = getDifficulty(difficultyCode);
    if (!roomConfig || !difficulty || !teamName.trim()) {
      setError("팀명, 방, 난이도를 먼저 확인해주세요.");
      return;
    }
    if (!agentReady) {
      setError("매장 관리자 프로그램이 연결되고 안전 잠금이 해제되어야 실행할 수 있습니다.");
      return;
    }
    const manualStartOnly = action === "start" && manualStartMode;
    const informationOnly = action === "set_info" || manualStartOnly;
    if (
      action === "start" &&
      !manualStartMode &&
      !window.confirm(`${roomConfig.name}에서 ${teamName.trim()} 팀 게임을 시작할까요?\n16:00부터 카운트다운됩니다.`)
    ) return;

    if (!startOperation("control", action)) return;
    setError("");
    setNotice("");
    try {
      const saved = await persistDetails();
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomId: roomConfig.roomId,
          action: informationOnly ? "set_info" : "start",
          teamName: teamName.trim(),
          mapIndex: manualStartOnly ? 0 : difficulty.mapIndex,
          people: 0,
          skipPeople: true,
          durationMinutes: GAME_DURATION_MINUTES,
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "관리자 프로그램 명령을 보내지 못했습니다.");
      if (informationOnly) {
        await patchReservation(saved.id, { action: "manager_loaded" });
        setNotice(
          manualStartMode && action === "start"
            ? "팀명만 빠르게 입력했습니다. 매장 관리자 프로그램에서 난이도를 선택하고 시작 버튼을 눌러주세요."
            : "관리자 프로그램에 팀명·난이도를 빠르게 입력했습니다. 인원은 변경하지 않았습니다.",
        );
      } else {
        setNotice(`${roomConfig.name} 게임 시작 명령을 보냈습니다.`);
      }
      window.setTimeout(() => void onRefreshStatus(), 650);
      window.setTimeout(() => void onRefreshStatus(), 1_500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "관리자 프로그램 명령을 보내지 못했습니다.");
    } finally {
      finishOperation("control", action);
    }
  }

  async function stopGame() {
    if (!roomConfig || !liveRoom || liveRoom.status !== "running") return;
    if (!window.confirm(`${roomConfig.name} 게임을 정지할까요?`)) return;
    const action = "stop";
    if (!startOperation("control", action)) return;
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: roomConfig.roomId, action: "stop" }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "게임 정지 명령을 보내지 못했습니다.");
      setNotice(`${roomConfig.name} 게임 정지 명령을 보냈습니다.`);
      window.setTimeout(() => void onRefreshStatus(), 650);
      window.setTimeout(() => void onRefreshStatus(), 1_500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "게임 정지 명령을 보내지 못했습니다.");
    } finally {
      finishOperation("control", action);
    }
  }

  async function completeReservation() {
    if (!reservation || isClosed) return;
    if (!window.confirm("이 예약을 이용 완료로 처리할까요?")) return;
    await mutate({ action: "complete" }, "이용 완료 처리했습니다.");
  }

  async function savePayment() {
    const split = paymentSplitForSave(paymentMethod, paymentDue, mixedPayment);
    if (paymentMethod === "mixed" && paymentSplitTotal(split) !== paymentDue) {
      setError(
        `복합결제 합계가 현장 결제액과 같아야 합니다. 현재 ${won(paymentSplitTotal(split))}원 / 필요 ${won(paymentDue)}원`,
      );
      return;
    }
    const action = "payment";
    if (!startOperation("payment", action)) return;
    setError("");
    setNotice("");
    try {
      const saved = await persistDetails();
      await patchReservation(saved.id, {
        action: "payment",
        addOnAmount,
        discountAmount,
        paymentAmount: grossPaymentAmount,
        paymentCardAmount: split.card,
        paymentCashAmount: split.cash,
        paymentAccountAmount: split.account,
        paymentMethod,
      });
      setNotice("결제 내역을 저장했습니다.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "결제 내역을 저장하지 못했습니다.");
    } finally {
      finishOperation("payment", action);
    }
  }

  async function syncPaymentReservation() {
    if (!reservation) return;
    const response = await fetch(
      `/api/admin/payments?reservationId=${encodeURIComponent(reservation.id)}`,
      { cache: "no-store" },
    );
    const overview = response.ok ? await response.json() as PaymentOverview : null;
    const targets = overview?.group?.isPaymentGroup
      ? overview.group.items.map((item) => ({ id: item.reservationId, date: item.scheduledDate }))
      : [{ id: reservation.id, date }];
    for (const target of targets) {
      const updated = await reloadReservation(target.date, target.id);
      if (!updated) continue;
      if (updated.id === reservation.id) setReservation(updated);
      await onSaved({ type: "upsert", reservation: updated });
    }
  }

  async function clearCell() {
    if (!reservation || !window.confirm("이 예약 칸을 비울까요? 예약은 취소 기록으로 보존됩니다.")) return;
    const action = "cancel";
    if (!startOperation("reservation", action)) return;
    setError("");
    try {
      const response = await fetch("/api/admin/reservations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: reservation.id, action: "cancel" }),
      });
      const data = (await response.json()) as {
        reservation?: ReservationRecord;
        error?: string;
      };
      if (!response.ok || !data.reservation) {
        throw new Error(data.error ?? "예약 칸을 비우지 못했습니다.");
      }
      await onSaved({ type: "upsert", reservation: data.reservation });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "예약 칸을 비우지 못했습니다.");
    } finally {
      finishOperation("reservation", action);
    }
  }

  async function copyNextGame() {
    if (!reservation) return;
    const nextTime = nextOperatingSlot(reservation.scheduledTime);
    if (!nextTime) {
      setError("마지막 운영 시간이라 다음 타임을 만들 수 없습니다.");
      return;
    }
    if (!window.confirm(
      `${reservation.teamName} 팀 정보를 ${nextTime} 같은 방에 복사할까요?\n새 예약은 미결제 상태로 만들어집니다.`,
    )) return;

    const action = "copy";
    if (!startOperation("reservation", action)) return;
    setError("");
    setNotice("");
    try {
      const saved = await persistDetails();
      const response = await fetch("/api/admin/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ copyFromId: saved.id }),
      });
      const data = (await response.json()) as {
        reservation?: ReservationRecord;
        error?: string;
      };
      if (!response.ok || !data.reservation) {
        throw new Error(data.error ?? "다음 타임 예약을 만들지 못했습니다.");
      }
      setNotice(`${data.reservation.scheduledTime} 같은 방에 미결제 예약으로 복사했습니다.`);
      await onSaved({ type: "upsert", reservation: data.reservation });
      onOpenCopied(data.reservation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "다음 타임 예약을 만들지 못했습니다.");
    } finally {
      finishOperation("reservation", action);
    }
  }

  async function deleteRecord() {
    if (!reservation || !isClosed) return;
    if (!window.confirm(
      `${reservation.teamName || "이 예약"}의 ${STATUS_LABELS[reservation.status] ?? reservation.status} 기록을 완전히 삭제할까요?\n삭제 후에는 되돌릴 수 없습니다.`,
    )) return;

    const action = "delete";
    if (!startOperation("reservation", action)) return;
    setError("");
    try {
      const response = await fetch("/api/admin/reservations", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: reservation.id }),
      });
      const data = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !data.id) {
        throw new Error(data.error ?? "예약 기록을 삭제하지 못했습니다.");
      }
      await onSaved({ type: "remove", id: data.id });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "예약 기록을 삭제하지 못했습니다.");
    } finally {
      finishOperation("reservation", action);
    }
  }

  return (
    <div className="quick-booking-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="quick-booking-modal" role="dialog" aria-modal="true" aria-labelledby="quick-booking-title">
        <div className="quick-booking-head">
          <div>
            <p className="eyebrow">QUICK SCHEDULE EDIT</p>
            <h2 id="quick-booking-title">{reservation ? (title ?? "예약 칸 통합 관리") : "예약 칸 직접 입력"}</h2>
            <span>{date} · {selection.time} · {initialRoom ? getRoom(initialRoom)?.name : "추가·대기 칸"}</span>
          </div>
          <button type="button" aria-label="닫기" onClick={onClose}>×</button>
        </div>

        <div className="quick-booking-grid">
          <div className="wide-field quick-copy-control">
            <label htmlFor="quick-team-name">팀명</label>
            <div className="quick-copy-field">
              <input id="quick-team-name" autoFocus maxLength={10} disabled={isCancelled} value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="최대 10자" />
              <button type="button" disabled={!teamName.trim()} onClick={() => void copyInputValue(teamName, "팀명")} aria-label="팀명 복사">복사</button>
            </div>
          </div>
          <label><span>방 배정</span><select disabled={isCancelled} value={roomCode} onChange={(event) => {
            const nextRoomCode = event.target.value;
            setRoomCode(nextRoomCode);
            if (!getDifficultyOptions(nextRoomCode).some((difficulty) => difficulty.code === difficultyCode)) {
              setDifficultyCode("basic");
            }
          }}><option value="">추가·대기(미배정)</option>{ROOM_OPTIONS.map((room) => <option key={room.code} value={room.code}>{room.name} · 권장 {room.min}~{room.max}명</option>)}</select></label>
          <label><span>난이도</span><select disabled={isCancelled} value={difficultyCode} onChange={(event) => setDifficultyCode(event.target.value)}>{difficultyOptions.map((difficulty) => <option key={difficulty.code} value={difficulty.code}>{difficulty.label} {difficulty.stars}</option>)}</select></label>
          <label><span>성인</span><input type="number" min="0" max="10" disabled={isCancelled} value={adultCount} onChange={(event) => setAdultCount(Math.max(0, Number(event.target.value) || 0))} /></label>
          <label><span>청소년·어린이</span><input type="number" min="0" max="10" disabled={isCancelled} value={youthCount} onChange={(event) => setYouthCount(Math.max(0, Number(event.target.value) || 0))} /></label>
          <div className="wide-field quick-copy-control">
            <label htmlFor="quick-vehicle-last4">차량번호 뒤 4자리</label>
            <div className="quick-copy-field quick-parking-field">
              <input id="quick-vehicle-last4" inputMode="numeric" maxLength={4} disabled={isCancelled} value={vehicleLast4} onChange={(event) => {
                if (parkingRegistrationComplete(reservation, vehicleLast4)) {
                  setParkingExplicitRequest(true);
                }
                setVehicleLast4(event.target.value.replace(/\D/g, "").slice(0, 4));
              }} placeholder="선택 입력" />
              <button type="button" disabled={!vehicleLast4.trim()} onClick={() => void copyInputValue(vehicleLast4, "차량번호")} aria-label="차량번호 복사">복사</button>
              <button
                type="button"
                className="quick-parking-register"
                disabled={
                  isCancelled ||
                  !reservation ||
                  !/^\d{4}$/.test(vehicleLast4) ||
                  parkingBusy ||
                  (parkingAutoEnabled && !parkingRegistrationNeedsManual(reservation, vehicleLast4) && !parkingExplicitRequest) ||
                  parkingRegistrationPending(reservation, vehicleLast4) ||
                  (parkingRegistrationComplete(reservation, vehicleLast4) && !parkingExplicitRequest)
                }
                onClick={() => void registerParkingDiscount()}
                title={
                  !reservation
                    ? "예약을 먼저 저장해주세요."
                    : parkingRegistrationNeedsManual(reservation, vehicleLast4)
                      ? "자동등록에 실패했습니다. 눌러서 수동으로 다시 시도할 수 있습니다."
                      : parkingRegistrationComplete(reservation, vehicleLast4) && !parkingExplicitRequest
                      ? "주차등록이 완료되었습니다."
                      : parkingAutoEnabled
                        ? "차량번호를 저장하면 백그라운드에서 자동 등록됩니다."
                        : "차량번호로 주차 할인을 등록합니다."
                }
              >
                {parkingBusy || parkingRegistrationPending(reservation, vehicleLast4)
                  ? "등록 중…"
                  : parkingRegistrationNeedsManual(reservation, vehicleLast4)
                    ? "수동등록필요"
                    : parkingRegistrationComplete(reservation, vehicleLast4) && !parkingExplicitRequest
                      ? "주차등록완료"
                      : parkingRegistrationComplete(reservation, vehicleLast4) && parkingExplicitRequest
                        ? "1시간 추가"
                    : parkingAutoEnabled
                      ? "자동등록"
                      : "주차등록"}
              </button>
            </div>
          </div>
          <div className="wide-field quick-memo-row">
            <label><span>메모</span><textarea rows={2} maxLength={500} disabled={isCancelled} value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="현장 메모" /></label>
            {reservation ? <button type="button" disabled={Boolean(memoBusy) || Boolean(isCancelled)} onClick={() => void saveMemo()}>{memoBusy ? "저장 중…" : "메모 저장"}</button> : null}
          </div>
        </div>

        <div className="quick-booking-summary">
          <span>총 {totalCount}명</span><strong>{won(amount)}원</strong>
          {reservation ? (
            <em className={`quick-source-badge source-${reservation.source}`}>
              {sourceLabel(reservation.source)}
            </em>
          ) : null}
          {!roomCode ? <em>추가·대기 칸은 나중에 방을 배정할 수 있습니다.</em> : null}
        </div>
        {extraPanel}
        {reservation ? (
          <div className="quick-operation-panel">
            <div className="quick-operation-head">
              <div>
                <span className={`booking-status status-${reservation.status}`}>
                  {STATUS_LABELS[reservation.status] ?? reservation.status}
                </span>
                <strong>입장·게임 제어</strong>
              </div>
              <small>
                {roomConfig
                  ? `${roomConfig.name} · ${liveRoom ? ROOM_STATUS_LABELS[liveRoom.status] : "상태 불러오는 중"}`
                  : "방을 배정해주세요"}
              </small>
            </div>
            <div className="quick-game-controls">
              <button
                type="button"
                className={reservation.status === "arrived" ? "undo-arrive-button" : "arrive-button"}
                disabled={isClosed || reservationControlBusy}
                onClick={() =>
                  void mutate(
                    { action: reservation.status === "arrived" ? "undo_arrive" : "arrive" },
                    reservation.status === "arrived"
                      ? "입장 처리를 원복했습니다."
                      : "입장 처리했습니다.",
                  )
                }
              >
                {reservation.status === "arrived" ? "입장 원복" : "입장 처리"}
              </button>
              <button type="button" className="manager-load-button" disabled={isClosed || reservationControlBusy || !agentReady || !roomCode} onClick={() => void sendManager("set_info")}>{controlBusy === "set_info" ? "관리자 입력 중…" : "관리자에 입력"}</button>
              <button type="button" className="game-start-button" disabled={isClosed || reservationControlBusy || !agentReady || !roomCode || liveRoom?.status === "running"} onClick={() => void sendManager("start")}>{controlBusy === "start" ? "전송 중…" : manualStartMode ? "게임 시작 · 수동" : "게임 시작"}</button>
              <button type="button" className="quick-stop-button" disabled={Boolean(controlBusy) || !agentReady || liveRoom?.status !== "running"} onClick={() => void stopGame()}>{controlBusy === "stop" ? "정지 중…" : "게임 정지"}</button>
              <button type="button" className="quick-complete-button" disabled={isClosed || reservationControlBusy} onClick={() => void completeReservation()}>{reservationBusy === "complete" ? "처리 중…" : "이용완료"}</button>
            </div>
            {!agentReady ? <p className="quick-control-hint">매장 관리자 프로그램이 연결되면 게임 제어 버튼이 활성화됩니다.</p> : null}

            <div className="quick-payment-panel">
              <div className="quick-payment-head">
                <strong>결제 처리</strong>
                <span>{reservation.paymentStatus === "paid" ? `${PAYMENT_LABELS[reservation.paymentMethod] ?? "결제"} ${won(reservation.paymentAmount)}원 완료` : "미결제"}</span>
              </div>
              {reservation.paymentStatus === "paid" && !isClosed ? (
                <ParticipantTopUpControls
                  reservation={reservation}
                  pricing={pricing}
                  disabled={
                    Boolean(paymentBusy) ||
                    hasUnsavedReservationChanges ||
                    !terminalAmountLocked ||
                    reservation.totalCount >= 10
                  }
                  disabledReason={
                    hasUnsavedReservationChanges
                      ? "예약 내용을 먼저 저장한 뒤 인원을 추가해주세요."
                      : !terminalAmountLocked
                        ? "기존 결제 완료 상태를 확인하고 있습니다."
                        : reservation.totalCount >= 10
                          ? "현재 예약 인원이 최대 10명입니다."
                          : ""
                  }
                  onPrepared={async (updatedReservation) => {
                    setReservation(updatedReservation);
                    setAdultCount(updatedReservation.adultCount);
                    setYouthCount(updatedReservation.youthCount);
                    await onSaved({ type: "upsert", reservation: updatedReservation });
                    setError("");
                    setNotice("추가 인원과 결제 회차를 준비했습니다. 아래 결제 순서에서 각 회차를 진행해주세요.");
                  }}
                />
              ) : null}
              <div className="quick-attached-addons">
                <div className="quick-attached-addons-head">
                  <div>
                    <strong>부가상품 함께 결제</strong>
                    <span>게임비와 합쳐 단말기에 한 번만 결제합니다.</span>
                  </div>
                  <b>{won(catalogAddOnAmount)}원</b>
                </div>
                {attachedAddOnLoading ? (
                  <p className="quick-attached-addons-loading">기존 부가상품 내역을 확인하고 있습니다.</p>
                ) : (
                  <div className="quick-attached-addons-grid">
                    {addOnCatalog.map((item) => {
                      const quantity = item.code === "slush" || item.code === "beverage" || item.code === "other"
                        ? checkoutAddOnCounts[item.code]
                        : checkoutExtraCounts[item.code] ?? 0;
                      return (
                        <div className={quantity ? "is-selected" : ""} key={item.code}>
                          <span><strong>{item.name}</strong><small>{won(item.price)}원</small></span>
                          <span className="quick-attached-addon-stepper">
                            <button type="button" aria-label={`${item.name} 수량 줄이기`} disabled={terminalAmountLocked || quantity < 1} onClick={() => changeCheckoutAddOn(item.code, -1)}>−</button>
                            <b>{quantity}</b>
                            <button type="button" aria-label={`${item.name} 수량 늘리기`} disabled={terminalAmountLocked} onClick={() => changeCheckoutAddOn(item.code, 1)}>＋</button>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {catalogAddOnAmount > 0 ? (
                  <div className="quick-attached-addons-total">
                    <span>게임비 {won(amount)}원 · 부가상품 {won(catalogAddOnAmount)}원{manualAddOnAmount ? ` · 기타 추가 ${won(manualAddOnAmount)}원` : ""}</span>
                    <strong>할인 전 합계 {won(amount + addOnAmount)}원</strong>
                  </div>
                ) : null}
              </div>
              <div className="quick-payment-grid">
                <label><span>기타 추가 금액</span><input type="number" min="0" step="500" disabled={Boolean(isCancelled) || terminalAmountLocked || attachedAddOnLoading} value={manualAddOnAmount} onChange={(event) => setManualAddOnAmount(Math.max(0, Number(event.target.value) || 0))} /></label>
                <label><span>할인 금액</span><input type="number" min="0" step="500" disabled={Boolean(isCancelled) || terminalAmountLocked} value={discountAmount} onChange={(event) => setDiscountAmount(Math.max(0, Number(event.target.value) || 0))} /></label>
                {terminalAmountLocked ? <p className="payment-amount-lock-hint">승인 내역이 있어 추가·할인 금액이 잠겼습니다. 모든 승인 건을 취소하면 다시 수정할 수 있습니다.</p> : null}
              </div>
              {grossPaymentAmount > 0 ? (
                <TerminalPaymentControls
                  reservation={reservation}
                  amount={grossPaymentAmount}
                  prepaidDepositAmount={depositAmount}
                  addOnAmount={addOnAmount}
                  addOnSale={addOnSaleSelection}
                  discountAmount={discountAmount}
                  pricing={pricing}
                  participantCounts={{ adult: adultCount, youth: youthCount }}
                  disabled={Boolean(paymentBusy) || Boolean(isCancelled) || attachedAddOnLoading}
                  beforePay={async () => {
                    if (hasUnsavedReservationChanges) await persistDetails();
                  }}
                  onSettled={syncPaymentReservation}
                  onAmountLockChange={setTerminalAmountLocked}
                />
              ) : (
                <button type="button" className="quick-payment-save" disabled={Boolean(paymentBusy) || Boolean(isCancelled) || attachedAddOnLoading} onClick={() => void savePayment()}>{paymentBusy ? "결제 저장 중…" : "결제 저장"}</button>
              )}
            </div>
          </div>
        ) : (
          <p className="quick-control-hint">예약 칸을 저장하면 이 창에서 결제와 게임 제어를 바로 할 수 있습니다.</p>
        )}
        {error ? <p className="quick-booking-error" role="alert">{error}</p> : null}
        {notice ? <p className="quick-booking-notice" role="status">{notice}</p> : null}

        <div className="quick-booking-actions">
          {reservation && isClosed ? <button type="button" className="quick-delete-button" disabled={reservationControlBusy} onClick={() => void deleteRecord()}>{reservationBusy === "delete" ? "삭제 중…" : "완료·취소 기록 삭제"}</button> : null}
          {reservation && !isClosed ? <button type="button" className="quick-clear-button" disabled={reservationControlBusy} onClick={() => void clearCell()}>{reservationBusy === "cancel" ? "처리 중…" : "칸 비우기"}</button> : null}
          {reservation && reservation.status !== "cancelled" && nextOperatingSlot(reservation.scheduledTime) ? <button type="button" className="quick-copy-button" disabled={reservationControlBusy} onClick={() => void copyNextGame()}>{reservationBusy === "copy" ? "복사 중…" : `한판 더 · ${nextOperatingSlot(reservation.scheduledTime)}`}</button> : null}
          <button type="button" className="quick-cancel-button" onClick={onClose}>닫기</button>
          <button type="button" className="quick-save-button" disabled={reservationControlBusy || Boolean(isCancelled)} onClick={() => void save()}>{reservationBusy === "save" ? "저장 중…" : reservation ? "예약 내용 저장" : "예약 칸 추가"}</button>
        </div>
      </section>
    </div>
  );
}

function expectedAmount(reservation: ReservationRecord) {
  return Math.max(
    0,
    reservation.baseAmount + reservation.addOnAmount - reservation.discountAmount,
  );
}

function isCurrentSlot(date: string, selectedDate: string, time: string) {
  if (date !== selectedDate) return false;
  return currentOperatingSlot(timeInSeoul(), OPERATING_SLOTS) === time;
}

export function RemoteControlPanel({
  status,
  reservations,
  error,
  busy,
  notice,
  manualStartMode,
  controlPinned,
  serverClockOffsetMs,
  onCommand,
  onStartNeedsInfo,
  onRefresh,
  onTogglePin,
}: {
  status: StatusResponse | null;
  reservations: ReservationRecord[];
  error: string;
  busy: string;
  notice: string;
  manualStartMode: boolean;
  controlPinned: boolean;
  serverClockOffsetMs: number;
  onCommand: (room: Room | null, action: ControlAction) => Promise<void>;
  onStartNeedsInfo: (roomCode: string) => void;
  onRefresh: () => Promise<void>;
  onTogglePin: () => void;
}) {
  const [clientNow, setClientNow] = useState(() => Date.now());
  const hasRunningRoom = Boolean(
    status?.rooms.some((room) => room.status === "running"),
  );
  useEffect(() => {
    const updateClock = () => setClientNow(Date.now());
    updateClock();
    const interval = window.setInterval(
      updateClock,
      hasRunningRoom ? 1_000 : 30_000,
    );
    window.addEventListener("focus", updateClock);
    document.addEventListener("visibilitychange", updateClock);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", updateClock);
      document.removeEventListener("visibilitychange", updateClock);
    };
  }, [hasRunningRoom]);

  const serverNow = clientNow + serverClockOffsetMs;
  const runningCount = status?.rooms.filter((room) => room.status === "running").length ?? 0;
  const bridgeOnline = status?.store.agentOnline === true;
  const controlState = status?.store.controlState ?? "IDLE";
  const agentReady = Boolean(
    bridgeOnline &&
      status?.store.controlArmed &&
      status?.store.managerVisible &&
      controlState !== "BUSY",
  );
  const connectionLabel = !bridgeOnline
    ? "매장 오프라인"
    : controlState === "BUSY"
      ? "제어 처리 중"
      : controlState === "ERROR" || controlState === "DEGRADED"
        ? status?.store.currentControlAction === "stop"
          ? "정지 확인 필요"
          : "관리자 프로그램 응답 지연"
        : !status?.store.managerVisible
          ? "관리자 창 없음"
          : status?.store.controlArmed
            ? `매장 연결 · ${runningCount}개 진행 중`
            : "연결됨 · 안전 잠금";
  return (
    <section className="integrated-control-panel" id="live-control">
      <div className="integrated-section-heading">
        <div>
          <p className="eyebrow">LIVE CONTROL</p>
          <h2>매장 실시간 원격제어</h2>
          <p>현재 매장 상태가 표시됩니다. 00:00이 되어도 자동 종료되지 않으며 정지 버튼으로 종료합니다.</p>
        </div>
        <div className="control-heading-actions">
          <button
            type="button"
            className={`control-pin-toggle ${controlPinned ? "is-enabled" : ""}`}
            aria-pressed={controlPinned}
            onClick={onTogglePin}
          >
            {controlPinned ? "고정 해제" : "상단 고정"}
          </button>
          <span className={`connection-pill ${bridgeOnline ? "is-online" : "is-offline"}`}>
            <span className="status-dot" />
            {connectionLabel}
          </span>
          <button type="button" className="control-refresh" onClick={() => void onRefresh()}>
            상태 새로고침
          </button>
          <button
            type="button"
            className="integrated-all-stop"
            disabled={!agentReady || runningCount === 0 || Boolean(busy)}
            onClick={() => void onCommand(null, "all_stop")}
          >
            전체 정지
          </button>
        </div>
      </div>

      {error ? <div className="control-inline-error">{error}</div> : null}
      {notice ? <div className="control-inline-notice" role="status">{notice}</div> : null}

      <div className="integrated-room-grid">
        {SCHEDULE_ROOM_CODES.map((roomCode) => {
          const config = getRoom(roomCode);
          const room = status?.rooms.find((item) => item.roomId === config?.roomId);
          const roomBusy = Boolean(room && busy.startsWith(`${room.roomId}:`));
          const roomRunning = room?.status === "running";
          const roomProblem = !status
            ? ""
            : !status.store.agentOnline
              ? "매장 연결 문제"
              : status.store.controlState === "BUSY"
                ? "제어 처리 중"
                : status.store.controlState === "ERROR" || status.store.controlState === "DEGRADED"
                  ? status.store.currentControlAction === "stop"
                    ? "정지 확인이 필요합니다"
                    : "관리자 프로그램 응답 지연"
                  : !status.store.managerVisible
                    ? "관리자 프로그램 확인 필요"
                    : !room || room.status === "offline"
                      ? "방 연결 문제"
                      : room.status === "error"
                        ? "방 오류 발생"
                        : "";
          const liveRemainingSeconds = roomRunning && room
            ? correctedRemainingSeconds(room, serverNow)
            : 0;
          const liveRoom = room
            ? { ...room, remainingSeconds: liveRemainingSeconds }
            : undefined;
          const availability = roomProblem
            ? null
            : estimateAvailability(liveRoom, roomCode, reservations, serverNow);
          const availabilityMinutes = availability
            ? Math.ceil(availability.availableSeconds / 60)
            : 0;
          const queuedMinutes =
            (availability?.queuedReservations ?? 0) * GAME_DURATION_MINUTES;
          const missingStartInfo = Boolean(
            room && (
              manualStartMode
                ? !room.teamName
                : !room.teamName || !room.mapIndex || !room.people
            ),
          );
          return (
            <article className={`integrated-room-card room-${room?.status ?? "offline"}`} key={roomCode}>
              <div className="integrated-room-head">
                <div><small>{config?.size}</small><strong>{config?.name}</strong></div>
                <span>{room ? ROOM_STATUS_LABELS[room.status] : "불러오는 중"}</span>
              </div>
              <div className="integrated-room-timer">
                <span>실제 남은시간</span>
                <strong>{roomRunning ? formatRemaining(liveRemainingSeconds) : "00:00"}</strong>
              </div>
              <div className={`room-availability ${roomProblem ? "is-unknown" : !status ? "is-loading" : availabilityMinutes ? "is-later" : "is-now"}`}>
                <span>이용 가능 예상</span>
                <strong>
                  <span>
                    {roomProblem
                      ? roomProblem
                      : !status
                        ? "상태 확인 중"
                        : !availability
                          ? "이용 가능 확인 중"
                      : availabilityMinutes > 0
                        ? `${availabilityMinutes}분 후 이용 가능`
                        : "지금 이용 가능"}
                  </span>
                  {availability && availabilityMinutes > 0 ? (
                    <b>{availability.availableAt} 예상</b>
                  ) : null}
                </strong>
                {roomProblem ? (
                  <small>매장 연결과 관리자 프로그램 상태를 확인해주세요.</small>
                ) : availability ? (
                  <small>
                    {availabilityMinutes > 0
                      ? availability.basis === "schedule"
                        ? `다음 예약 ${availability.nextReservationTime} 반영`
                        : `실제 남은 ${Math.ceil(liveRemainingSeconds / 60)}분${queuedMinutes ? ` + 다음 예약 게임 ${queuedMinutes}분` : ""}`
                      : availability.nextReservationTime
                        ? `다음 예약 ${availability.nextReservationTime}`
                        : "이후 예약 없음"}
                  </small>
                ) : null}
              </div>
              <div className="integrated-room-info">
                <span><small>팀명</small><b>{room?.teamName || "—"}</b></span>
                <span><small>맵</small><b>{room?.mapName || room?.level || "—"}</b></span>
                <span><small>인원</small><b>{room?.people ? `${room.people}명` : "—"}</b></span>
              </div>
              <div className="integrated-room-actions">
                <button
                  type="button"
                  className="integrated-start"
                  disabled={
                    !agentReady ||
                    !room ||
                    room.status === "running" ||
                    roomBusy
                  }
                  onClick={() => {
                    if (!room) return;
                    if (missingStartInfo) onStartNeedsInfo(roomCode);
                    else void onCommand(room, "start");
                  }}
                  title={
                    missingStartInfo
                      ? `예약 칸을 열어 ${manualStartMode ? "팀명" : "팀명·난이도·인원"}을 입력합니다.`
                      : manualStartMode
                        ? "팀명만 빠르게 입력하고 매장에서 난이도를 선택해 수동으로 시작합니다."
                        : "게임 시작"
                  }
                >
                  {manualStartMode ? "게임 시작 · 수동" : "게임 시작"}
                </button>
                <button
                  type="button"
                  className="integrated-stop"
                  disabled={!agentReady || !room || room.status !== "running" || roomBusy}
                  onClick={() => room && void onCommand(room, "stop")}
                >
                  정지
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function ScheduleBoard({
  selectedDate,
  today,
  reservations,
  onSelect,
  onMove,
  onCopy,
  onStatusChange,
  onParkingRegister,
  parkingAutoEnabled = false,
  cancellationFeeAmount,
  standalone = false,
}: {
  selectedDate: string;
  today: string;
  reservations: ReservationRecord[];
  onSelect: (selection: ScheduleSelection) => void;
  onMove: (reservation: ReservationRecord, time: string, roomCode: string) => Promise<void>;
  onCopy: (reservation: ReservationRecord, time: string, roomCode: string) => Promise<void>;
  onStatusChange: (
    reservation: ReservationRecord,
    action: "arrive" | "undo_arrive",
  ) => Promise<void>;
  onParkingRegister?: (reservation: ReservationRecord) => Promise<void>;
  parkingAutoEnabled?: boolean;
  cancellationFeeAmount: number;
  standalone?: boolean;
}) {
  const [dragTarget, setDragTarget] = useState("");
  const [movingId, setMovingId] = useState("");
  const [dragMode, setDragMode] = useState<"move" | "copy" | "">("");
  const [moveNotice, setMoveNotice] = useState("");
  const [statusBusyId, setStatusBusyId] = useState("");
  const [parkingBusyId, setParkingBusyId] = useState("");
  const [hidePastSlots, setHidePastSlots] = useState(true);
  const suppressSelectionUntil = useRef(0);
  const pointerDrag = useRef<{
    reservation: ReservationRecord;
    pointerId: number;
    targetKey: string;
    mode: "move" | "copy";
  } | null>(null);
  const scheduleReservations = reservations.filter(
    (reservation) => reservation.status !== "cancelled" && reservation.roomCode,
  );
  const cellMap = new Map<string, ReservationRecord[]>();
  scheduleReservations.forEach((reservation) => {
    const key = `${reservation.scheduledTime}|${reservation.roomCode}`;
    const values = cellMap.get(key) ?? [];
    values.push(reservation);
    cellMap.set(key, values);
  });
  const unassignedByTime = new Map<string, ReservationRecord[]>();
  reservations
    .filter((reservation) => reservation.status !== "cancelled" && !reservation.roomCode)
    .forEach((reservation) => {
      const list = unassignedByTime.get(reservation.scheduledTime) ?? [];
      list.push(reservation);
      unassignedByTime.set(reservation.scheduledTime, list);
    });
  const currentSlot =
    selectedDate === today
      ? currentOperatingSlot(timeInSeoul(), OPERATING_SLOTS)
      : "";
  const currentSlotIndex = OPERATING_SLOTS.indexOf(currentSlot);
  const visibleOperatingSlots =
    hidePastSlots && currentSlotIndex >= 0
      ? OPERATING_SLOTS.slice(Math.max(0, currentSlotIndex - 1))
      : OPERATING_SLOTS;

  async function registerParking(reservation: ReservationRecord) {
    if (!onParkingRegister || parkingBusyId || parkingRegistrationComplete(reservation)) return;
    setParkingBusyId(reservation.id);
    setMoveNotice("");
    try {
      await onParkingRegister(reservation);
      setMoveNotice(`${reservation.teamName || reservation.customerName || "예약"} 차량의 주차등록을 시작했습니다.`);
    } catch (error) {
      setMoveNotice(error instanceof Error ? error.message : "주차등록을 시작하지 못했습니다.");
    } finally {
      setParkingBusyId("");
    }
  }

  function finishPointerDrag() {
    suppressSelectionUntil.current = Date.now() + 350;
    pointerDrag.current = null;
    setMovingId("");
    setDragMode("");
    setDragTarget("");
  }

  function beginPointerDrag(
    event: React.PointerEvent<HTMLElement>,
    reservation: ReservationRecord,
    mode: "move" | "copy" = "move",
  ) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    suppressSelectionUntil.current = Date.now() + 5_000;
    pointerDrag.current = {
      reservation,
      pointerId: event.pointerId,
      targetKey: `${reservation.scheduledTime}|${reservation.roomCode}`,
      mode,
    };
    setMovingId(reservation.id);
    setDragMode(mode);
    setDragTarget(`${reservation.scheduledTime}|${reservation.roomCode}`);
    setMoveNotice("");
  }

  function trackPointerDrag(event: React.PointerEvent<HTMLElement>) {
    const active = pointerDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-schedule-drop-key]");
    const targetKey = target?.dataset.scheduleDropKey ?? "";
    active.targetKey = targetKey;
    setDragTarget(targetKey);
  }

  function selectReservation(
    event: React.MouseEvent<HTMLButtonElement>,
    selection: ScheduleSelection,
  ) {
    if (Date.now() < suppressSelectionUntil.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onSelect(selection);
  }

  async function moveReservationTo(
    reservation: ReservationRecord,
    time: string,
    roomCode: string,
  ) {
    suppressSelectionUntil.current = Date.now() + 350;
    if (reservation.status === "completed" || reservation.status === "cancelled") return;
    if (reservation.scheduledTime === time && reservation.roomCode === roomCode) {
      setMoveNotice("이미 같은 칸에 있는 예약입니다.");
      return;
    }
    try {
      await onMove(reservation, time, roomCode);
      setMoveNotice(`${reservation.teamName || reservation.customerName || "예약"}을(를) ${time} ${getRoom(roomCode)?.name}으로 이동했습니다.`);
    } catch (reason) {
      setMoveNotice(reason instanceof Error ? reason.message : "예약을 이동하지 못했습니다.");
    }
  }

  async function copyReservationTo(
    reservation: ReservationRecord,
    time: string,
    roomCode: string,
  ) {
    suppressSelectionUntil.current = Date.now() + 350;
    if (reservation.status === "cancelled") return;
    try {
      await onCopy(reservation, time, roomCode);
      setMoveNotice(`${reservation.teamName || reservation.customerName || "예약"}을(를) ${time} ${getRoom(roomCode)?.name}에 복사했습니다. 원본 예약은 그대로 유지됩니다.`);
    } catch (reason) {
      setMoveNotice(reason instanceof Error ? reason.message : "예약을 복사하지 못했습니다.");
    }
  }

  function endPointerDrag(event: React.PointerEvent<HTMLElement>) {
    const active = pointerDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const { reservation, targetKey, mode } = active;
    finishPointerDrag();
    if (!targetKey) return;
    const separator = targetKey.indexOf("|");
    const time = targetKey.slice(0, separator);
    const roomCode = targetKey.slice(separator + 1);
    if (separator > 0 && time && roomCode) {
      if (mode === "copy") {
        void copyReservationTo(reservation, time, roomCode);
      } else {
        void moveReservationTo(reservation, time, roomCode);
      }
    }
  }

  function cancelPointerDrag(event: React.PointerEvent<HTMLElement>) {
    if (pointerDrag.current?.pointerId !== event.pointerId) return;
    finishPointerDrag();
  }

  async function toggleArrival(reservation: ReservationRecord) {
    const action = reservation.status === "arrived" ? "undo_arrive" : "arrive";
    setStatusBusyId(reservation.id);
    setMoveNotice("");
    try {
      await onStatusChange(reservation, action);
      setMoveNotice(
        action === "arrive"
          ? `${reservation.teamName || reservation.customerName || "예약"}을(를) 입장 처리했습니다.`
          : `${reservation.teamName || reservation.customerName || "예약"}의 입장 처리를 원복했습니다.`,
      );
    } catch (reason) {
      setMoveNotice(reason instanceof Error ? reason.message : "입장 상태를 변경하지 못했습니다.");
    } finally {
      setStatusBusyId("");
    }
  }

  return (
    <section className="schedule-panel" id="full-schedule">
      <div className="integrated-section-heading schedule-heading">
        <div className="schedule-heading-copy">
          <p className="eyebrow">FULL DAY SCHEDULE</p>
          <h2>전체 시간대별 예약 현황</h2>
          <p>예약 카드의 ‘이동’ 손잡이를 끌어 원하는 시간·방으로 옮길 수 있습니다. 같은 칸에 여러 예약도 배치할 수 있습니다.</p>
        </div>
        <div className="schedule-heading-tools">
          {!standalone ? (
            <a
              className="schedule-expand-link"
              href={`/admin/schedule?date=${encodeURIComponent(selectedDate)}`}
              target="_blank"
              rel="noreferrer"
            >
              <span aria-hidden="true">↗</span> 크게 보기
            </a>
          ) : null}
          <label className={`schedule-past-toggle ${hidePastSlots ? "is-enabled" : ""}`}>
            <input
              type="checkbox"
              checked={hidePastSlots}
              disabled={selectedDate !== today}
              onChange={(event) => setHidePastSlots(event.target.checked)}
            />
            <span>지난 시간 숨김</span>
          </label>
          <div className="schedule-legend" aria-label="시간표 상태 안내">
            <span className="legend-booked">예약</span>
            <span className="legend-arrived">입장</span>
            <span className="legend-completed">완료</span>
            <span className="legend-paid">결제완료</span>
          </div>
        </div>
      </div>
      {moveNotice ? <p className="schedule-move-notice" role="status">{moveNotice}</p> : null}

      <div className="schedule-scroll">
        <table className="schedule-table">
          <thead>
            <tr>
              <th className="schedule-time-column">시간</th>
              {SCHEDULE_ROOM_CODES.map((code) => (
                <th key={code}>
                  <strong>{getRoom(code)?.name}</strong>
                  <small>{getRoom(code)?.min}~{getRoom(code)?.max}명</small>
                </th>
              ))}
              <th className="schedule-total-column">합계</th>
            </tr>
          </thead>
          <tbody>
            {visibleOperatingSlots.map((time) => {
              const rowReservations = SCHEDULE_ROOM_CODES.flatMap((roomCode) =>
                cellMap.get(`${time}|${roomCode}`) ?? [],
              );
              const unassigned = unassignedByTime.get(time) ?? [];
              const allAtTime = [...rowReservations, ...unassigned];
              const rowAmount = allAtTime.reduce(
                (sum, reservation) =>
                  sum + scheduleRevenueAmount(reservation, cancellationFeeAmount),
                0,
              );
              const current = isCurrentSlot(today, selectedDate, time);
              return (
                <tr className={current ? "is-current-slot" : ""} key={time}>
                  <th className="schedule-time-column">
                    <strong>{time}</strong>
                    {current ? <span>현재</span> : null}
                  </th>
                  {SCHEDULE_ROOM_CODES.map((roomCode) => {
                    const key = `${time}|${roomCode}`;
                    const cellReservations = cellMap.get(key) ?? [];
                    if (cellReservations.length === 0) {
                      return (
                        <td
                          className={`schedule-empty schedule-drop-zone ${dragTarget === key ? (dragMode === "copy" ? "is-copy-target" : "is-drag-target") : ""}`}
                          key={roomCode}
                          data-schedule-drop-key={key}
                        >
                          <button type="button" onClick={() => onSelect({ time, roomCode })}>
                            <strong>＋</strong><span>직접 입력</span>
                          </button>
                        </td>
                      );
                    }
                    return (
                      <td
                        className={`schedule-filled schedule-drop-zone ${cellReservations.length > 1 ? "has-overlap" : ""} ${dragTarget === key ? (dragMode === "copy" ? "is-copy-target" : "is-drag-target") : ""}`}
                        key={roomCode}
                        data-schedule-drop-key={key}
                      >
                        <div className="schedule-cell-stack">
                          {cellReservations.map((reservation) => {
                            const amount = scheduleRevenueAmount(
                              reservation,
                              cancellationFeeAmount,
                            );
                            return (
                              <article
                                className={`schedule-reservation-item cell-${reservation.status}`}
                                key={reservation.id}
                              >
                                <button
                                  type="button"
                                  className={`schedule-reservation-chip ${movingId === reservation.id ? (dragMode === "copy" ? "is-copying" : "is-dragging") : ""}`}
                                  onClick={(event) =>
                                    selectReservation(event, {
                                      time,
                                      roomCode,
                                      reservation,
                                    })
                                  }
                                  title={reservation.status === "completed" ? "완료된 예약" : "클릭하여 상세 관리"}
                                >
                                  <span
                                    className={`schedule-copy-handle ${reservation.status === "completed" ? "is-only" : ""}`}
                                    onPointerDown={(event) => beginPointerDrag(event, reservation, "copy")}
                                    onPointerMove={trackPointerDrag}
                                    onPointerUp={endPointerDrag}
                                    onPointerCancel={cancelPointerDrag}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                    }}
                                    title="끌어서 예약 복사"
                                  >
                                    <b aria-hidden="true">＋</b>
                                    <small>복사</small>
                                  </span>
                                  {reservation.status !== "completed" ? (
                                      <span
                                        className="schedule-drag-handle"
                                        onPointerDown={(event) => beginPointerDrag(event, reservation, "move")}
                                        onPointerMove={trackPointerDrag}
                                        onPointerUp={endPointerDrag}
                                        onPointerCancel={cancelPointerDrag}
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                        }}
                                        title="끌어서 예약 이동"
                                      >
                                        <b aria-hidden="true">⠿</b>
                                        <small>이동</small>
                                      </span>
                                  ) : null}
                                  <span className="schedule-cell-top">
                                    <b>{reservation.teamName || reservation.customerName || "팀명 미정"}</b>
                                  </span>
                                  <span className="schedule-source-row">
                                    <span className={`schedule-source source-${reservation.source}`}>
                                      {sourceLabel(reservation.source)}
                                    </span>
                                    {reservation.source === "naver" && reservation.customerName ? (
                                      <strong className="schedule-naver-customer">
                                        예약자 {reservation.customerName}
                                      </strong>
                                    ) : null}
                                    {naverSameDayCancellationFee(
                                      reservation,
                                      cancellationFeeAmount,
                                    ) ? (
                                      <strong className="schedule-cancellation-fee">
                                        당일 취소 수수료 {won(cancellationFeeAmount)}원
                                      </strong>
                                    ) : null}
                                    {reservation.vehicleLast4 ? (
                                      <span className="schedule-vehicle-badge">
                                        차량 {reservation.vehicleLast4}
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className="schedule-cell-bottom">
                                    <small>{reservation.difficultyLabel || "난이도 미정"}</small>
                                    <b>{won(amount)}원</b>
                                    <em className={reservation.paymentStatus === "paid" ? "is-paid" : "is-unpaid"}>
                                      {reservation.paymentStatus === "paid" ? "결제" : "미결제"}
                                    </em>
                                    <span className="schedule-people-count">
                                      {reservation.totalCount ? `${reservation.totalCount}명` : "미정"}
                                    </span>
                                  </span>
                                </button>
                                {reservation.vehicleLast4 ? (
                                  <button
                                    type="button"
                                    className={`schedule-parking-register ${parkingRegistrationComplete(reservation) ? "is-complete" : parkingRegistrationNeedsManual(reservation) ? "is-manual-required" : ""}`}
                                    disabled={
                                      !onParkingRegister ||
                                      (parkingAutoEnabled && !parkingRegistrationNeedsManual(reservation)) ||
                                      parkingBusyId === reservation.id ||
                                      parkingRegistrationPending(reservation) ||
                                      parkingRegistrationComplete(reservation)
                                    }
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void registerParking(reservation);
                                    }}
                                  >
                                    {parkingRegistrationComplete(reservation)
                                      ? "주차등록완료"
                                      : parkingRegistrationNeedsManual(reservation)
                                        ? "수동등록필요"
                                      : parkingBusyId === reservation.id || parkingRegistrationPending(reservation)
                                        ? "등록 중…"
                                        : parkingAutoEnabled
                                          ? "자동등록"
                                          : "주차등록"}
                                  </button>
                                ) : null}
                                {reservation.status === "booked" || reservation.status === "arrived" ? (
                                  <button
                                    type="button"
                                    className={`schedule-arrival-toggle ${reservation.status === "arrived" ? "is-arrived" : ""}`}
                                    disabled={statusBusyId === reservation.id}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void toggleArrival(reservation);
                                    }}
                                  >
                                    {statusBusyId === reservation.id
                                      ? "처리 중…"
                                      : reservation.status === "arrived"
                                        ? "● 입장 완료 · 원복"
                                        : "입장 처리"}
                                  </button>
                                ) : null}
                              </article>
                            );
                          })}
                          <button type="button" className="schedule-add-overlap" onClick={() => onSelect({ time, roomCode })}>＋ 같은 칸 추가</button>
                        </div>
                      </td>
                    );
                  })}
                  <td className="schedule-row-total">
                    <strong>{rowReservations.length}건</strong>
                    <small>{rowAmount ? `${won(rowAmount)}원` : "—"}</small>
                    <div className="overflow-cell-list">
                      {unassigned.map((reservation, index) => (
                        <button
                          type="button"
                          key={reservation.id}
                          onClick={(event) =>
                            selectReservation(event, {
                              time,
                              roomCode: "",
                              reservation,
                            })
                          }
                        >
                          {reservation.status !== "completed" ? (
                            <span
                              className="schedule-drag-handle schedule-drag-handle-compact"
                              onPointerDown={(event) => beginPointerDrag(event, reservation)}
                              onPointerMove={trackPointerDrag}
                              onPointerUp={endPointerDrag}
                              onPointerCancel={cancelPointerDrag}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                              title="끌어서 예약 이동"
                            >
                              <b aria-hidden="true">⠿</b>
                            </span>
                          ) : null}
                          대기 {index + 1}
                          {reservation.vehicleLast4
                            ? ` · 차량 ${reservation.vehicleLast4}`
                            : ""}
                        </button>
                      ))}
                      <button type="button" className="add-overflow-cell" onClick={() => onSelect({ time, roomCode: "" })}>
                        ＋ 추가·대기
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReservationCard({
  reservation,
  manualStartMode,
  onChanged,
  onEdit,
  onOpenCopied,
  pricing,
}: {
  reservation: ReservationRecord;
  manualStartMode: boolean;
  onChanged: (change: ReservationListChange) => Promise<void>;
  onEdit: () => void;
  onOpenCopied: (reservation: ReservationRecord) => void;
  pricing: PricingSettings;
}) {
  const [addOnAmount, setAddOnAmount] = useState(reservation.addOnAmount);
  const [discountAmount, setDiscountAmount] = useState(reservation.discountAmount);
  const [paymentMethod, setPaymentMethod] = useState(reservation.paymentMethod || "card");
  const [terminalAmountLocked, setTerminalAmountLocked] = useState(false);
  const [mixedPayment, setMixedPayment] = useState<PaymentSplit>({
    card: reservation.paymentCardAmount,
    cash: reservation.paymentCashAmount,
    account: reservation.paymentAccountAmount,
  });
  const [memo, setMemo] = useState(reservation.memo);
  const [assignedRoom, setAssignedRoom] = useState(reservation.roomCode);
  const { operations, startOperation, finishOperation } = useBookingOperationLocks();
  const controlBusy = operations.control;
  const paymentBusy = operations.payment;
  const reservationBusy = operations.reservation;
  const memoBusy = operations.memo;
  const [notice, setNotice] = useState("");
  const room = getRoom(reservation.roomCode);
  const nextSlot = nextOperatingSlot(reservation.scheduledTime);
  const grossPaymentAmount = Math.max(
    0,
    reservation.baseAmount + addOnAmount - discountAmount,
  );
  const depositAmount = reservationDeposit(
    reservation.source,
    grossPaymentAmount,
    pricing.naverDepositAmount,
  );
  const paymentDue = Math.max(0, grossPaymentAmount - depositAmount);
  const isClosed = reservation.status === "cancelled" || reservation.status === "completed";
  const reservationControlBusy = Boolean(reservationBusy || controlBusy);

  useEffect(() => {
    setAssignedRoom(reservation.roomCode);
  }, [reservation.id, reservation.roomCode]);

  async function patchReservation(command: Mutation) {
    const response = await fetch("/api/admin/reservations", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: reservation.id, ...command }),
    });
    const data = (await response.json()) as {
      reservation?: ReservationRecord;
      error?: string;
    };
    if (!response.ok || !data.reservation) {
      throw new Error(data.error ?? "처리하지 못했습니다.");
    }
    await onChanged({ type: "upsert", reservation: data.reservation });
    return data.reservation;
  }

  async function mutate(command: Mutation, success: string) {
    const domain = mutationOperationDomain(command);
    if (!startOperation(domain, command.action)) return;
    setNotice("");
    try {
      await patchReservation(command);
      setNotice(success);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "처리하지 못했습니다.");
    } finally {
      finishOperation(domain, command.action);
    }
  }

  async function saveSettlement() {
    const split = paymentSplitForSave(paymentMethod, paymentDue, mixedPayment);
    if (paymentMethod === "mixed" && paymentSplitTotal(split) !== paymentDue) {
      setNotice(
        `복합결제 합계가 맞지 않습니다. 현재 ${won(paymentSplitTotal(split))}원 / 필요 ${won(paymentDue)}원`,
      );
      return;
    }
    await mutate(
      {
        action: "payment",
        addOnAmount,
        discountAmount,
        paymentAmount: grossPaymentAmount,
        paymentCardAmount: split.card,
        paymentCashAmount: split.cash,
        paymentAccountAmount: split.account,
        paymentMethod,
      },
      "결제 내역을 저장했습니다.",
    );
  }

  async function syncTerminalSettlement() {
    const updated = await reloadReservation(
      reservation.scheduledDate,
      reservation.id,
    );
    if (updated) {
      await onChanged({ type: "upsert", reservation: updated });
    }
  }

  async function copyNextGame() {
    if (!nextSlot || !window.confirm(
      `${reservation.teamName} 팀 정보를 ${nextSlot} 같은 방에 복사할까요?\n결제는 복사하지 않고 미결제로 만듭니다.`,
    )) return;
    const action = "copy";
    if (!startOperation("reservation", action)) return;
    setNotice("");
    try {
      const response = await fetch("/api/admin/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ copyFromId: reservation.id }),
      });
      const data = (await response.json()) as {
        reservation?: ReservationRecord;
        error?: string;
      };
      if (!response.ok || !data.reservation) {
        throw new Error(data.error ?? "다음 타임 예약을 만들지 못했습니다.");
      }
      setNotice(`${data.reservation.scheduledTime} 같은 방에 미결제로 복사했습니다.`);
      await onChanged({ type: "upsert", reservation: data.reservation });
      onOpenCopied(data.reservation);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "다음 타임 예약을 만들지 못했습니다.");
    } finally {
      finishOperation("reservation", action);
    }
  }

  async function deleteRecord() {
    if (!isClosed || !window.confirm(
      `${reservation.teamName || "이 예약"}의 ${STATUS_LABELS[reservation.status] ?? reservation.status} 기록을 완전히 삭제할까요?`,
    )) return;
    const action = "delete";
    if (!startOperation("reservation", action)) return;
    setNotice("");
    try {
      const response = await fetch("/api/admin/reservations", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: reservation.id }),
      });
      const data = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !data.id) {
        throw new Error(data.error ?? "예약 기록을 삭제하지 못했습니다.");
      }
      await onChanged({ type: "remove", id: data.id });
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "예약 기록을 삭제하지 못했습니다.");
    } finally {
      finishOperation("reservation", action);
    }
  }

  async function sendManager(action: "set_info" | "start") {
    if (!room || !reservation.mapIndex || !reservation.teamName.trim()) {
      setNotice("팀명, 방, 난이도 정보가 있어야 관리자 프로그램에 입력할 수 있습니다.");
      return;
    }
    const manualStartOnly = action === "start" && manualStartMode;
    const informationOnly = action === "set_info" || manualStartOnly;
    if (
      action === "start" &&
      !manualStartMode &&
      !window.confirm(
        `${room.name}에서 ${reservation.teamName} 팀 게임을 시작할까요?\n16:00부터 카운트다운됩니다.`,
      )
    ) return;

    if (!startOperation("control", action)) return;
    setNotice("");
    try {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomId: room.roomId,
          action: informationOnly ? "set_info" : "start",
          teamName: reservation.teamName,
          mapIndex: manualStartOnly ? 0 : reservation.mapIndex,
          people: 0,
          skipPeople: true,
          durationMinutes: GAME_DURATION_MINUTES,
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "관리자 프로그램 명령을 보내지 못했습니다.");
      if (informationOnly) {
        await patchReservation({ action: "manager_loaded" });
        setNotice(
          manualStartMode && action === "start"
            ? "팀명만 빠르게 입력했습니다. 매장에서 난이도를 선택하고 시작 버튼을 눌러주세요."
            : "관리자 프로그램에 팀명·난이도를 빠르게 입력했습니다. 인원은 변경하지 않았습니다.",
        );
      } else {
        setNotice(`${room.name} 게임 시작 명령을 보냈습니다.`);
      }
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "관리자 프로그램 명령을 보내지 못했습니다.");
    } finally {
      finishOperation("control", action);
    }
  }

  return (
    <article
      className={`booking-card booking-${reservation.status}`}
      id={`booking-${reservation.id}`}
    >
      <div className="booking-time-block">
        <strong>{reservation.scheduledTime || "시간 미정"}</strong>
        <span>{room?.name ?? (reservation.roomCode || "방 미정")}</span>
      </div>
      <div className="booking-main">
        <div className="booking-title-row">
          <div>
            <span className={`booking-status status-${reservation.status}`}>
              {STATUS_LABELS[reservation.status] ?? reservation.status}
            </span>
            <span className={`booking-source source-${reservation.source}`}>
              {sourceLabel(reservation.source)}
            </span>
            <h3>{reservation.teamName || reservation.customerName || "팀명 미입력"}</h3>
          </div>
          <strong className="booking-total">
            {reservation.totalCount ? `${reservation.totalCount}명` : "인원 미정"}
          </strong>
        </div>
        <div className="booking-facts">
          <span>난이도 <b>{reservation.difficultyLabel || "미정"}</b></span>
          <span>성인 {reservation.adultCount} · 청소년 {reservation.youthCount}</span>
          {reservation.vehicleLast4 ? <span>차량 {reservation.vehicleLast4}</span> : null}
          {reservation.customerName ? <span>예약자 {reservation.customerName}</span> : null}
          {reservation.customerPhone ? <span>연락처 {reservation.customerPhone}</span> : null}
          <span>예약번호 {reservation.bookingCode}</span>
        </div>
        <div className="booking-actions">
          <button
            type="button"
            className={reservation.status === "arrived" ? "undo-arrive-button" : "arrive-button"}
            disabled={isClosed || reservationControlBusy}
            onClick={() =>
              void mutate(
                { action: reservation.status === "arrived" ? "undo_arrive" : "arrive" },
                reservation.status === "arrived"
                  ? "입장 처리를 원복했습니다."
                  : "입장 처리했습니다.",
              )
            }
          >{reservation.status === "arrived" ? "입장 원복" : "입장 처리"}</button>
          <button
            className="manager-load-button"
            type="button"
            disabled={isClosed || reservationControlBusy}
            onClick={() => void sendManager("set_info")}
          >
            {controlBusy === "set_info"
              ? "입력 중…"
              : reservation.managerLoadedAt
                ? "관리자에 다시 입력"
                : "관리자에 입력"}
          </button>
          <button
            className="game-start-button"
            type="button"
            disabled={isClosed || reservationControlBusy}
            onClick={() => void sendManager("start")}
          >{controlBusy === "start" ? "전송 중…" : manualStartMode ? "게임 시작 · 수동" : "게임 시작"}</button>
          {reservation.status !== "cancelled" && nextSlot ? (
            <button
              className="repeat-booking-button"
              type="button"
              disabled={reservationControlBusy}
              onClick={() => void copyNextGame()}
            >{reservationBusy === "copy" ? "복사 중…" : `한판 더 · ${nextSlot}`}</button>
          ) : null}
        </div>
        <div className="room-assignment-row">
          <label>
            <span>방 배정</span>
            <select value={assignedRoom} onChange={(event) => setAssignedRoom(event.target.value)}>
              <option value="">선택</option>
              {ROOM_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>{option.name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!assignedRoom || reservationControlBusy || isClosed || assignedRoom === reservation.roomCode}
            onClick={() => void mutate({ action: "assign", roomCode: assignedRoom }, "방 배정을 저장했습니다.")}
          >배정 저장</button>
        </div>
        <details className="booking-settlement" open={reservation.paymentStatus !== "paid" && !isClosed}>
          <summary>
            결제·메모
            <span>
              {reservation.paymentStatus === "paid"
                ? `${PAYMENT_LABELS[reservation.paymentMethod] ?? "결제"} ${won(reservation.paymentAmount)}원`
                : `미결제 · 기본 ${won(reservation.baseAmount)}원`}
            </span>
          </summary>
          <div className="settlement-grid">
            <label><span>추가 금액</span><input type="number" min="0" step="500" disabled={terminalAmountLocked} value={addOnAmount} onChange={(event) => setAddOnAmount(Math.max(0, Number(event.target.value) || 0))} /></label>
            <label><span>할인 금액</span><input type="number" min="0" step="500" disabled={terminalAmountLocked} value={discountAmount} onChange={(event) => setDiscountAmount(Math.max(0, Number(event.target.value) || 0))} /></label>
            {terminalAmountLocked ? <p className="payment-amount-lock-hint">승인 내역이 있어 추가·할인 금액이 잠겼습니다. 모든 승인 건을 취소하면 다시 수정할 수 있습니다.</p> : null}
          </div>
          {grossPaymentAmount <= 0 ? (
            <div className="settlement-total">
              <span>최종 결제금액</span><strong>0원</strong>
              <button type="button" disabled={Boolean(paymentBusy)} onClick={() => void saveSettlement()}>{paymentBusy ? "결제 저장 중…" : "결제 저장"}</button>
            </div>
          ) : null}
          {grossPaymentAmount > 0 ? (
            <TerminalPaymentControls
              reservation={reservation}
              amount={grossPaymentAmount}
              prepaidDepositAmount={depositAmount}
              addOnAmount={addOnAmount}
              discountAmount={discountAmount}
              pricing={pricing}
              disabled={Boolean(paymentBusy) || reservation.status === "cancelled"}
              onSettled={syncTerminalSettlement}
              onAmountLockChange={setTerminalAmountLocked}
            />
          ) : null}
          <div className="memo-row">
            <textarea rows={2} maxLength={500} value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="메모" />
            <button type="button" disabled={Boolean(memoBusy)} onClick={() => void mutate({ action: "memo", memo }, "메모를 저장했습니다.")}>{memoBusy ? "저장 중…" : "메모 저장"}</button>
          </div>
        </details>
        <div className="booking-footer-row">
          {notice
            ? <p role="status">{notice}</p>
            : <span>{reservation.managerLoadedAt ? "관리자 프로그램 입력 완료" : "게임은 자동 시작되지 않습니다."}</span>}
          {isClosed ? (
            <div className="closed-booking-actions">
              {reservation.status === "completed" ? (
                <button
                  className="edit-completed-booking"
                  type="button"
                  disabled={reservationBusy === "delete"}
                  onClick={onEdit}
                >완료 예약 수정</button>
              ) : null}
              <button
                className="delete-booking"
                type="button"
                disabled={reservationControlBusy}
                onClick={() => void deleteRecord()}
              >{reservationBusy === "delete" ? "삭제 중…" : "기록 삭제"}</button>
            </div>
          ) : (
            <button
              className="cancel-booking"
              type="button"
              disabled={reservationControlBusy}
              onClick={() => {
                if (window.confirm("이 예약을 취소할까요?")) {
                  void mutate({ action: "cancel" }, "예약을 취소했습니다.");
                }
              }}
            >예약 취소</button>
          )}
        </div>
      </div>
    </article>
  );
}

export { ReservationCard as ReservationDetailCard };

export default function ReservationsAdmin({
  operatorName,
  initialDate,
  initialSelectedDate,
  pricing,
  scheduleOnly = false,
}: {
  operatorName: string;
  initialDate: string;
  initialSelectedDate?: string;
  pricing: PricingSettings;
  scheduleOnly?: boolean;
}) {
  const startingDate = initialSelectedDate ?? initialDate;
  const unitPrices = useMemo(() => sharedSalesUnitPrices(pricing), [pricing]);
  const [date, setDate] = useState(startingDate);
  const [reservations, setReservations] = useState<ReservationRecord[]>([]);
  const [todayReservations, setTodayReservations] = useState<ReservationRecord[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0);
  const [controlBusy, setControlBusy] = useState("");
  const [controlNotice, setControlNotice] = useState("");
  const [filter, setFilter] = useState<BookingFilter>("all");
  const [scheduleSelection, setScheduleSelection] = useState<ScheduleSelection | null>(null);
  const [manualStartMode, setManualStartMode] = useState(true);
  const [parkingAutoEnabled, setParkingAutoEnabled] = useState(false);
  const [controlPinned, setControlPinned] = useState(false);
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  const [sharedSalesEditMode, setSharedSalesEditMode] = useState(false);
  const [sharedSales, setSharedSales] = useState<DailySharedSales>(() =>
    emptySharedSales(startingDate),
  );
  const [sharedSalesDraft, setSharedSalesDraft] = useState<DailySharedSales>(() =>
    emptySharedSales(startingDate),
  );
  const [sharedSalesLoading, setSharedSalesLoading] = useState(true);
  const [sharedSalesSaving, setSharedSalesSaving] = useState(false);
  const [sharedSalesNotice, setSharedSalesNotice] = useState("");
  const selectedDateRef = useRef(date);
  const reservationRefreshDatesInFlight = useRef(new Set<string>());
  const todayRefreshInFlight = useRef(false);
  const statusRefreshInFlight = useRef(false);
  const pendingControlTrace = useRef<FrontendControlTrace | null>(null);
  useEffect(() => {
    selectedDateRef.current = date;
  }, [date]);
  useEffect(() => {
    const wideScreen = window.matchMedia("(min-width: 1400px)");
    const applySavedPreference = () => {
      if (!wideScreen.matches) {
        setControlPinned(false);
        return;
      }
      setControlPinned(
        window.localStorage.getItem(CONTROL_PIN_STORAGE_KEY) !== "false",
      );
    };
    applySavedPreference();
    wideScreen.addEventListener("change", applySavedPreference);
    return () => wideScreen.removeEventListener("change", applySavedPreference);
  }, []);

  const refreshReservations = useCallback(async (quiet = false) => {
    const requestedDate = date;
    if (reservationRefreshDatesInFlight.current.has(requestedDate)) return;
    reservationRefreshDatesInFlight.current.add(requestedDate);
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(
        `/api/admin/reservations?date=${encodeURIComponent(requestedDate)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        reservations?: ReservationRecord[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "예약 목록을 불러오지 못했습니다.");
      const nextReservations = data.reservations ?? [];
      if (selectedDateRef.current === requestedDate) {
        setReservations((current) =>
          sameReservationSnapshot(current, nextReservations)
            ? current
            : nextReservations,
        );
      }
      if (requestedDate === initialDate) {
        setTodayReservations((current) =>
          sameReservationSnapshot(current, nextReservations)
            ? current
            : nextReservations,
        );
      }
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "예약 목록을 불러오지 못했습니다.");
    } finally {
      reservationRefreshDatesInFlight.current.delete(requestedDate);
      if (!quiet) setLoading(false);
    }
  }, [date, initialDate]);

  const refreshStatus = useCallback(async () => {
    if (statusRefreshInFlight.current) return;
    statusRefreshInFlight.current = true;
    try {
      const requestedAt = Date.now();
      const response = await fetch("/api/status", { cache: "no-store" });
      const data = (await response.json()) as StatusResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "매장 상태를 불러오지 못했습니다.");
      const receivedAt = Date.now();
      const generatedAt = Date.parse(data.generatedAt);
      if (Number.isFinite(generatedAt)) {
        const measuredOffset = generatedAt - (requestedAt + receivedAt) / 2;
        setServerClockOffsetMs(Math.round(measuredOffset));
      }
      setStatus(data);
      setStatusError("");
      const pending = pendingControlTrace.current;
      if (pending) {
        const completed = data.recentCommands.find(
          (command) => command.id === pending.commandId,
        );
        if (completed && ["completed", "failed"].includes(completed.status)) {
          pending.stages.FE_STATE_UPDATED = performance.now() - pending.startedAt;
          console.info("[CONTROL PERF]", JSON.stringify({
            trace_id: pending.traceId,
            component: "frontend",
            stage: "FE_STATE_UPDATED",
            total_ms: Number(pending.stages.FE_STATE_UPDATED.toFixed(3)),
            command_status: completed.status,
            stages: pending.stages,
          }));
          pendingControlTrace.current = null;
          window.requestAnimationFrame(() => {
            console.info("[CONTROL PERF]", JSON.stringify({
              trace_id: pending.traceId,
              component: "frontend",
              stage: "FE_RENDER_DONE",
              total_ms: Number((performance.now() - pending.startedAt).toFixed(3)),
            }));
          });
        }
      }
    } catch (reason) {
      setStatusError(reason instanceof Error ? reason.message : "매장 상태를 불러오지 못했습니다.");
    } finally {
      statusRefreshInFlight.current = false;
    }
  }, []);

  const refreshTodayReservations = useCallback(async () => {
    if (todayRefreshInFlight.current) return;
    todayRefreshInFlight.current = true;
    try {
      const response = await fetch(
        `/api/admin/reservations?date=${encodeURIComponent(initialDate)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        reservations?: ReservationRecord[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "오늘 예약을 불러오지 못했습니다.");
      const nextReservations = data.reservations ?? [];
      setTodayReservations((current) =>
        sameReservationSnapshot(current, nextReservations)
          ? current
          : nextReservations,
      );
    } catch {
      // 상세 예약 목록 오류와 중복 표시하지 않고 다음 주기에 다시 시도한다.
    } finally {
      todayRefreshInFlight.current = false;
    }
  }, [initialDate]);

  const refreshSharedSales = useCallback(async () => {
    setSharedSalesLoading(true);
    setSharedSalesNotice("");
    try {
      const response = await fetch(
        `/api/admin/daily-sales?date=${encodeURIComponent(date)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        sales?: DailySharedSales;
        error?: string;
      };
      if (!response.ok || !data.sales) {
        throw new Error(data.error ?? "공용 매출을 불러오지 못했습니다.");
      }
      setSharedSales(data.sales);
    } catch (reason) {
      setSharedSales(emptySharedSales(date));
      setSharedSalesNotice(
        reason instanceof Error ? reason.message : "공용 매출을 불러오지 못했습니다.",
      );
    } finally {
      setSharedSalesLoading(false);
    }
  }, [date]);

  useEffect(() => {
    const refreshVisibleReservations = () => {
      if (!document.hidden) void refreshReservations(true);
    };
    const initialRefresh = window.setTimeout(() => void refreshReservations(), 0);
    const interval = window.setInterval(refreshVisibleReservations, 3_000);
    window.addEventListener("focus", refreshVisibleReservations);
    document.addEventListener("visibilitychange", refreshVisibleReservations);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisibleReservations);
      document.removeEventListener("visibilitychange", refreshVisibleReservations);
    };
  }, [refreshReservations]);
  useEffect(() => {
    const refreshVisibleStatus = () => {
      if (!document.hidden) void refreshStatus();
    };
    const initialRefresh = window.setTimeout(() => void refreshStatus(), 0);
    const interval = window.setInterval(refreshVisibleStatus, 1_000);
    window.addEventListener("focus", refreshVisibleStatus);
    document.addEventListener("visibilitychange", refreshVisibleStatus);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisibleStatus);
      document.removeEventListener("visibilitychange", refreshVisibleStatus);
    };
  }, [refreshStatus]);
  useEffect(() => {
    if (date === initialDate) return;
    const refreshVisibleTodayReservations = () => {
      if (!document.hidden) void refreshTodayReservations();
    };
    const initialRefresh = window.setTimeout(
      () => void refreshTodayReservations(),
      0,
    );
    const interval = window.setInterval(refreshVisibleTodayReservations, 3_000);
    window.addEventListener("focus", refreshVisibleTodayReservations);
    document.addEventListener("visibilitychange", refreshVisibleTodayReservations);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisibleTodayReservations);
      document.removeEventListener("visibilitychange", refreshVisibleTodayReservations);
    };
  }, [date, initialDate, refreshTodayReservations]);

  const commitReservationChange = useCallback(
    async (change: ReservationListChange) => {
      setReservations((current) =>
        applyReservationListChange(current, change, date),
      );
      setTodayReservations((current) =>
        applyReservationListChange(current, change, initialDate),
      );

      void refreshReservations(true);
      if (date !== initialDate) void refreshTodayReservations();
    },
    [date, initialDate, refreshReservations, refreshTodayReservations],
  );
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/settings", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as {
          parking?: { autoRegistrationEnabled?: boolean };
        };
        if (response.ok) setParkingAutoEnabled(data.parking?.autoRegistrationEnabled === true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const registerParkingFromSchedule = useCallback(
    async (reservation: ReservationRecord) => {
      const response = await fetch("/api/parking-discount/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reservationId: reservation.id,
          carLast4: reservation.vehicleLast4,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const data = await response.json() as {
        reservation?: ReservationRecord | null;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "주차등록을 시작하지 못했습니다.");
      if (data.reservation) {
        await commitReservationChange({ type: "upsert", reservation: data.reservation });
      }
    },
    [commitReservationChange],
  );
  useEffect(() => {
    const task = window.setTimeout(() => {
      setSharedSales(emptySharedSales(date));
      setSharedSalesDraft(emptySharedSales(date));
      setSharedSalesEditMode(false);
      void refreshSharedSales();
    }, 0);
    return () => window.clearTimeout(task);
  }, [date, refreshSharedSales]);

  function changeManualStartMode(enabled: boolean) {
    setManualStartMode(enabled);
    setControlNotice(
      enabled
        ? "수동 시작 모드: 게임 시작 버튼은 팀명만 빠르게 입력합니다."
        : "원격 시작 모드: 게임 시작 버튼이 16분 카운트다운을 시작합니다.",
    );
  }

  function toggleControlPin() {
    setControlPinned((current) => {
      const next = !current;
      window.localStorage.setItem(CONTROL_PIN_STORAGE_KEY, String(next));
      return next;
    });
  }

  function changeSharedSales(
    category: SharedSalesCategory,
    method: SharedPaymentMethod,
    count: number,
  ) {
    setSharedSalesDraft((current) => ({
      ...current,
      [category]: { ...current[category], [method]: count },
    }));
    setSharedSalesNotice("");
  }

  async function saveSharedSales() {
    if (
      !sharedSalesEditMode &&
      sharedSalesCount(sharedSalesDraft, unitPrices) === 0
    ) {
      setSharedSalesNotice("판매 개수를 입력해주세요.");
      return;
    }
    setSharedSalesSaving(true);
    setSharedSalesNotice("");
    try {
      const response = await fetch("/api/admin/daily-sales", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...sharedSalesDraft,
          mode: sharedSalesEditMode ? "replace" : "add",
        }),
      });
      const data = (await response.json()) as {
        sales?: DailySharedSales;
        error?: string;
      };
      if (!response.ok || !data.sales) {
        throw new Error(data.error ?? "공용 매출을 저장하지 못했습니다.");
      }
      setSharedSales(data.sales);
      setSharedSalesDraft(emptySharedSales(date));
      setSharedSalesEditMode(false);
      setSharedSalesNotice(
        sharedSalesEditMode
          ? "누적 판매 내역을 수정했습니다."
          : "누적 저장 완료 · 입력값을 0으로 초기화했습니다.",
      );
    } catch (reason) {
      setSharedSalesNotice(
        reason instanceof Error ? reason.message : "공용 매출을 저장하지 못했습니다.",
      );
    } finally {
      setSharedSalesSaving(false);
    }
  }

  function startSharedSalesEdit() {
    setSharedSalesDraft({
      ...sharedSales,
      slush: { ...sharedSales.slush },
      beverage: { ...sharedSales.beverage },
      other: { ...sharedSales.other },
      youthPass10: { ...sharedSales.youthPass10 },
      youthPass20: { ...sharedSales.youthPass20 },
      adultPass10: { ...sharedSales.adultPass10 },
      adultPass20: { ...sharedSales.adultPass20 },
    });
    setSharedSalesEditMode(true);
    setSharedSalesNotice("");
  }

  function cancelSharedSalesEdit() {
    setSharedSalesDraft(emptySharedSales(date));
    setSharedSalesEditMode(false);
    setSharedSalesNotice("");
  }

  async function sendControl(room: Room | null, action: ControlAction) {
    const frontendStartedAt = performance.now();
    const frontendStages: Record<string, number> = { FE_CLICK: 0 };
    const informationOnly = action === "start" && manualStartMode;
    if (action === "start" && room && !informationOnly) {
      if (!window.confirm(`${room.name}의 ${room.teamName} 팀 게임을 시작할까요?\n16:00부터 카운트다운됩니다.`)) return;
    }
    if (action === "stop" && room && !window.confirm(`${room.name} 게임을 정지할까요?`)) return;
    if (action === "all_stop" && !window.confirm("현재 진행 중인 모든 게임을 정지할까요?")) return;

    const roomId = action === "all_stop" ? "ALL" : room?.roomId ?? "";
    frontendStages.FE_VALIDATION_DONE = performance.now() - frontendStartedAt;
    setControlBusy(`${roomId}:${action}`);
    setControlNotice("");
    try {
      const serializeStartedAt = performance.now();
      const requestBody = JSON.stringify({
        roomId,
        action: informationOnly ? "set_info" : action,
        teamName: room?.teamName ?? "",
        mapIndex: informationOnly ? 0 : room?.mapIndex ?? 0,
        people: 0,
        skipPeople: true,
        durationMinutes: GAME_DURATION_MINUTES,
      });
      frontendStages.FE_SERIALIZE = performance.now() - serializeStartedAt;
      frontendStages.FE_API_START = performance.now() - frontendStartedAt;
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });
      frontendStages.FE_API_RESPONSE_HEADERS = performance.now() - frontendStartedAt;
      const data = (await response.json()) as { id?: string; error?: string };
      frontendStages.FE_API_RESPONSE_BODY = performance.now() - frontendStartedAt;
      if (!response.ok) throw new Error(data.error ?? "원격 명령을 보내지 못했습니다.");
      if (data.id) {
        const traceId = response.headers.get("x-control-trace-id") || `CTRL-${data.id}`;
        pendingControlTrace.current = {
          traceId,
          commandId: data.id,
          startedAt: frontendStartedAt,
          stages: frontendStages,
        };
        console.info("[CONTROL PERF]", JSON.stringify({
          trace_id: traceId,
          component: "frontend",
          stage: "FE_COMMAND_QUEUED",
          total_ms: Number((performance.now() - frontendStartedAt).toFixed(3)),
          server_timing: response.headers.get("server-timing") || "",
          stages: frontendStages,
        }));
      }
      setControlNotice(
        action === "all_stop"
          ? "전체 정지 명령을 보냈습니다."
          : informationOnly
            ? `${room?.name} 팀명만 빠르게 입력했습니다. 매장에서 난이도를 선택하고 시작 버튼을 눌러주세요.`
          : `${room?.name} ${action === "start" ? "시작" : "정지"} 명령을 보냈습니다.`,
      );
      window.setTimeout(() => void refreshStatus(), 650);
      window.setTimeout(() => void refreshStatus(), 1_500);
    } catch (reason) {
      setControlNotice(reason instanceof Error ? reason.message : "원격 명령을 보내지 못했습니다.");
    } finally {
      setControlBusy("");
    }
  }

  function openRoomReservation(roomCode: string) {
    const nowTime = timeInSeoul();
    const [nowHour, nowMinute] = nowTime.split(":").map(Number);
    const nowTotal = nowHour * 60 + nowMinute;
    const todayItems = (date === initialDate ? reservations : todayReservations)
      .filter(
        (reservation) =>
          reservation.roomCode === roomCode &&
          reservation.status !== "cancelled" &&
          reservation.status !== "completed",
      )
      .map((reservation) => {
        const [hour, minute] = reservation.scheduledTime.split(":").map(Number);
        return { reservation, startsAt: hour * 60 + minute };
      })
      .sort((left, right) => left.startsAt - right.startsAt);
    const selected =
      todayItems.find(
        (item) => item.startsAt <= nowTotal && nowTotal < item.startsAt + SLOT_INTERVAL_MINUTES,
      ) ??
      todayItems.find((item) => item.startsAt >= nowTotal) ??
      todayItems.at(-1);

    setDate(initialDate);
    if (selected) {
      setScheduleSelection({
        time: selected.reservation.scheduledTime,
        roomCode,
        reservation: selected.reservation,
      });
      setControlNotice(`${getRoom(roomCode)?.name ?? roomCode} 예약 관리창을 열었습니다. 정보 확인 후 바로 시작하세요.`);
      return;
    }

    const currentSlot = OPERATING_SLOTS.find((time, index) => {
      const [hour, minute] = time.split(":").map(Number);
      const startsAt = hour * 60 + minute;
      const next = OPERATING_SLOTS[index + 1];
      const nextStartsAt = next
        ? Number(next.slice(0, 2)) * 60 + Number(next.slice(3, 5))
        : startsAt + SLOT_INTERVAL_MINUTES;
      return startsAt <= nowTotal && nowTotal < nextStartsAt;
    }) ?? OPERATING_SLOTS.find((time) => {
      const [hour, minute] = time.split(":").map(Number);
      return hour * 60 + minute >= nowTotal;
    }) ?? OPERATING_SLOTS[0];
    setScheduleSelection({ time: currentSlot, roomCode });
    setControlNotice("등록된 예약이 없어 현재 시간의 새 예약 입력창을 열었습니다.");
  }

  function openCopiedReservation(reservation: ReservationRecord) {
    if (reservation.scheduledDate !== date) {
      setDate(reservation.scheduledDate);
    }
    setScheduleSelection({
      time: reservation.scheduledTime,
      roomCode: reservation.roomCode,
      reservation,
    });
  }

  async function moveReservation(
    reservation: ReservationRecord,
    scheduledTime: string,
    roomCode: string,
  ) {
    const response = await fetch("/api/admin/reservations", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: reservation.id,
        action: "move",
        scheduledDate: date,
        scheduledTime,
        roomCode,
      }),
    });
    const data = (await response.json()) as {
      reservation?: ReservationRecord;
      error?: string;
    };
    if (!response.ok || !data.reservation) {
      throw new Error(data.error ?? "예약을 이동하지 못했습니다.");
    }
    await commitReservationChange({
      type: "upsert",
      reservation: data.reservation,
    });
  }

  async function copyReservation(
    reservation: ReservationRecord,
    scheduledTime: string,
    roomCode: string,
  ) {
    const response = await fetch("/api/admin/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        copyFromId: reservation.id,
        scheduledDate: date,
        scheduledTime,
        roomCode,
      }),
    });
    const data = (await response.json()) as {
      reservation?: ReservationRecord;
      error?: string;
    };
    if (!response.ok || !data.reservation) {
      throw new Error(data.error ?? "예약을 복사하지 못했습니다.");
    }
    await commitReservationChange({
      type: "upsert",
      reservation: data.reservation,
    });
  }

  async function changeReservationArrival(
    reservation: ReservationRecord,
    action: "arrive" | "undo_arrive",
  ) {
    const response = await fetch("/api/admin/reservations", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: reservation.id, action }),
    });
    const data = (await response.json()) as {
      reservation?: ReservationRecord;
      error?: string;
    };
    if (!response.ok || !data.reservation) {
      throw new Error(data.error ?? "입장 상태를 변경하지 못했습니다.");
    }
    await commitReservationChange({
      type: "upsert",
      reservation: data.reservation,
    });
  }

  const summary = useMemo(() => {
    const notCancelled = reservations.filter((item) => item.status !== "cancelled");
    const cancellationFee = reservations.reduce(
      (sum, item) =>
        sum +
        naverSameDayCancellationFee(
          item,
          pricing.naverCancellationFeeAmount,
        ),
      0,
    );
    const expected = notCancelled.reduce((sum, item) => sum + expectedAmount(item), 0);
    const reservationSales = notCancelled.reduce(
      (totals, item) => {
        const deposit = reservationDeposit(
          item.source,
          expectedAmount(item),
          pricing.naverDepositAmount,
        );
        totals.deposit += deposit;
        if (item.paymentStatus === "paid") {
          totals.card += item.paymentCardAmount;
          totals.cash += item.paymentCashAmount;
          totals.account += item.paymentAccountAmount;
          totals.other += unclassifiedReservationPaymentAmount({
            paymentAmount: item.paymentAmount,
            depositAmount: deposit,
            cardAmount: item.paymentCardAmount,
            cashAmount: item.paymentCashAmount,
            accountAmount: item.paymentAccountAmount,
            couponAmount: item.paymentCouponAmount,
          });
        }
        return totals;
      },
      { card: 0, cash: 0, account: 0, deposit: 0, other: 0 },
    );
    const slush = sharedSalesCategoryTotal(sharedSales, "slush", unitPrices);
    const beverage = sharedSalesCategoryTotal(sharedSales, "beverage", unitPrices);
    const sharedOther = sharedSalesCategoryTotal(sharedSales, "other", unitPrices);
    const passes =
      sharedSalesCategoryTotal(sharedSales, "youthPass10", unitPrices) +
      sharedSalesCategoryTotal(sharedSales, "youthPass20", unitPrices) +
      sharedSalesCategoryTotal(sharedSales, "adultPass10", unitPrices) +
      sharedSalesCategoryTotal(sharedSales, "adultPass20", unitPrices);
    const card =
      reservationSales.card +
      sharedSalesAmountByMethod(sharedSales, "card", unitPrices);
    const cash =
      reservationSales.cash +
      sharedSalesAmountByMethod(sharedSales, "cash", unitPrices);
    const account =
      reservationSales.account +
      sharedSalesAmountByMethod(sharedSales, "account", unitPrices);
    const paid =
      card +
      cash +
      account +
      reservationSales.deposit +
      reservationSales.other +
      cancellationFee;
    return {
      games: notCancelled.length,
      people: notCancelled.reduce((sum, item) => sum + item.totalCount, 0),
      occupiedPercent: Math.round((notCancelled.filter((item) => item.roomCode).length / (OPERATING_SLOTS.length * 4)) * 100),
      expected: expected + slush + beverage + sharedOther + passes + cancellationFee,
      paid,
      card,
      cash,
      account,
      deposit: reservationSales.deposit,
      cancellationFee,
      other: reservationSales.other,
      slush,
      beverage,
      sharedOther,
      passes,
      unpaid: notCancelled.filter((item) => item.paymentStatus !== "paid").length,
      unassigned: notCancelled.filter((item) => !item.roomCode).length,
    };
  }, [pricing, reservations, sharedSales, unitPrices]);

  const filteredReservations = useMemo(() => {
    if (filter === "unpaid") return reservations.filter((item) => item.status !== "cancelled" && item.paymentStatus !== "paid");
    if (filter === "arrived") return reservations.filter((item) => item.status === "arrived");
    if (filter === "unassigned") return reservations.filter((item) => item.status !== "cancelled" && !item.roomCode);
    if (filter === "cancelled") return reservations.filter((item) => item.status === "cancelled");
    return reservations;
  }, [filter, reservations]);

  if (scheduleOnly) {
    return (
      <main className="admin-shell admin-schedule-only-shell">
        <nav className="schedule-only-navigation" aria-label="예약 현황 크게 보기 메뉴">
          <a className="schedule-only-return" href="/admin">← 통합 운영 관리</a>
          <div className="schedule-only-actions">
            <label htmlFor="schedule-only-date">
              <span>운영 날짜</span>
              <input
                id="schedule-only-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => void refreshReservations()}
              disabled={loading}
            >
              {loading ? "불러오는 중…" : "예약 새로고침"}
            </button>
          </div>
        </nav>

        <ScheduleBoard
          selectedDate={date}
          today={initialDate}
          reservations={reservations}
          onSelect={setScheduleSelection}
          onMove={moveReservation}
          onCopy={copyReservation}
          onStatusChange={changeReservationArrival}
          onParkingRegister={registerParkingFromSchedule}
          parkingAutoEnabled={parkingAutoEnabled}
          cancellationFeeAmount={pricing.naverCancellationFeeAmount}
          standalone
        />

        {error ? <div className="alert error-alert">{error}</div> : null}
        {scheduleSelection ? (
          <QuickBookingModal
            key={`${scheduleSelection.time}|${scheduleSelection.roomCode}|${scheduleSelection.reservation?.id ?? "new"}`}
            date={date}
            selection={scheduleSelection}
            status={status}
            manualStartMode={manualStartMode}
            onClose={() => setScheduleSelection(null)}
            onSaved={commitReservationChange}
            onOpenCopied={openCopiedReservation}
            onRefreshStatus={refreshStatus}
            pricing={pricing}
          />
        ) : null}
      </main>
    );
  }

  return (
    <main className={`admin-shell admin-integrated-shell ${controlPinned ? "is-control-pinned" : ""}`}>
      <header className="topbar admin-topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">JB</div>
          <div><p className="eyebrow">JUMPING BATTLE · CONTROL OFFICE</p><h1>통합 운영 관리</h1></div>
        </div>
        <div className="admin-topbar-right">
          <nav className="admin-nav" aria-label="운영 메뉴">
            <a href="/admin/v2">POS V2</a>
            <a href="/admin/remote">모바일 무인운영</a>
            <a href="/">상세 원격제어</a>
            <a href="/admin/game-history">게임 기록</a>
            <a href="/admin/analytics">매출 분석</a>
            <a href="/admin/notifications">매출 알림</a>
            <a href="/admin/settings">가격 설정</a>
            <a href="/reserve" target="_blank" rel="noreferrer">고객 예약 화면</a>
            <span>{operatorName}</span>
          </nav>
          <div className="admin-topbar-tools">
            <label className={`manual-start-toggle topbar-manual-start ${manualStartMode ? "is-enabled" : ""}`}>
              <input
                type="checkbox"
                checked={manualStartMode}
                onChange={(event) => changeManualStartMode(event.target.checked)}
              />
              <span className="manual-start-switch" aria-hidden="true"><i /></span>
              <span className="manual-start-copy">
                <strong>매장 수동 시작</strong>
                <small>{manualStartMode ? "팀명만 빠르게 전송" : "원격으로 즉시 시작"}</small>
              </span>
            </label>
            <button
              type="button"
              className="topbar-reservation-refresh"
              onClick={() => void refreshReservations()}
              disabled={loading}
            >
              {loading ? "불러오는 중…" : "예약 새로고침"}
            </button>
          </div>
        </div>
      </header>

      <div className="admin-workspace">
        <aside className="admin-side-rail" aria-label="운영 바로가기 및 공용 부가매출">
          <nav className="admin-side-nav" aria-label="관리자 화면 바로가기">
            <p className="eyebrow">QUICK NAVIGATION</p>
            <strong>운영 바로가기</strong>
            <a href="/admin/v2"><span>V2</span>새 POS 화면</a>
            <a href="/admin/remote"><span>M</span>모바일 무인운영</a>
            <a href="#admin-overview"><span>01</span>운영 KPI</a>
            <a href="#live-control"><span>02</span>매장 원격제어</a>
            <a href="#full-schedule"><span>03</span>전체 예약 현황</a>
            <a href="#reservation-details"><span>04</span>예약·결제 수정</a>
            <a href="/admin/game-history"><span>05</span>게임 기록</a>
            <a href="/admin/analytics"><span>06</span>매출 분석</a>
            <a href="/admin/notifications"><span>07</span>매출 알림</a>
            <a href="/admin/settings"><span>08</span>가격 설정</a>
          </nav>
          <SharedSalesPanel
            sales={sharedSalesDraft}
            totalSales={sharedSales}
            editMode={sharedSalesEditMode}
            loading={sharedSalesLoading}
            saving={sharedSalesSaving}
            notice={sharedSalesNotice}
            unitPrices={unitPrices}
            onChange={changeSharedSales}
            onSave={saveSharedSales}
            onStartEdit={startSharedSalesEdit}
            onCancelEdit={cancelSharedSalesEdit}
          />
          <p className="admin-side-help">
            예약 매출은 시간표의 예약 카드를 눌러 결제 내역을 다시 저장하면 수정됩니다.
            이용 완료된 예약도 수정할 수 있습니다.
          </p>
        </aside>

        <div className={`admin-main-column ${controlPinned ? "is-control-pinned" : ""}`}>
      <div className="admin-control-stack">
        <section className="admin-overview-strip" id="admin-overview" aria-label="운영 날짜 및 하루 운영 요약">
          <div className="admin-overview-date">
            <label htmlFor="admin-date">운영 날짜</label>
            <input id="admin-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
          <article><span>예약금</span><strong>{won(summary.deposit)}원</strong><small>네이버 선결제</small></article>
          <article><span>취소 수수료</span><strong>{won(summary.cancellationFee)}원</strong><small>네이버 당일 취소</small></article>
          <article><span>카드</span><strong>{won(summary.card)}원</strong><small>예약 + 부가매출</small></article>
          <article><span>현금</span><strong>{won(summary.cash)}원</strong><small>예약 + 부가매출</small></article>
          <article><span>계좌</span><strong>{won(summary.account)}원</strong><small>예약 + 부가매출</small></article>
          <article className="kpi-total"><span>총 매출</span><strong>{won(summary.paid)}원</strong><small>예상 매출 {won(summary.expected)}원</small></article>
          <article><span>게임건수</span><strong>{summary.games}건</strong><small>점유 {summary.occupiedPercent}%</small></article>
          <article><span>인원</span><strong>{summary.people}명</strong><small>총 이용 인원</small></article>
        </section>

        <RemoteControlPanel
        status={status}
        reservations={date === initialDate ? reservations : todayReservations}
        error={statusError}
        busy={controlBusy}
        notice={controlNotice}
        manualStartMode={manualStartMode}
        controlPinned={controlPinned}
        serverClockOffsetMs={serverClockOffsetMs}
        onCommand={sendControl}
        onStartNeedsInfo={openRoomReservation}
        onRefresh={refreshStatus}
        onTogglePin={toggleControlPin}
      />
      </div>

      <ScheduleBoard
        selectedDate={date}
        today={initialDate}
        reservations={reservations}
        onSelect={setScheduleSelection}
        onMove={moveReservation}
        onCopy={copyReservation}
        onStatusChange={changeReservationArrival}
        onParkingRegister={registerParkingFromSchedule}
        parkingAutoEnabled={parkingAutoEnabled}
        cancellationFeeAmount={pricing.naverCancellationFeeAmount}
      />

      {error ? <div className="alert error-alert">{error}</div> : null}
      <section
        className={`reservation-detail-panel ${detailPanelOpen ? "" : "is-collapsed"}`}
        id="reservation-details"
      >
        <div className="integrated-section-heading">
          <div>
            <p className="eyebrow">RESERVATION DETAILS</p>
            <h2>예약·결제 상세 관리</h2>
            <p>시간표에서 예약을 누르면 해당 카드로 바로 이동합니다.</p>
          </div>
          <button
            type="button"
            className="reservation-detail-toggle"
            aria-expanded={detailPanelOpen}
            aria-controls="reservation-detail-content"
            onClick={() => setDetailPanelOpen((current) => !current)}
          >
            <span>{detailPanelOpen ? "상세 관리 접기" : "상세 관리 펼치기"}</span>
            <b aria-hidden="true">{detailPanelOpen ? "⌃" : "⌄"}</b>
          </button>
        </div>
        <div
          id="reservation-detail-content"
          className="reservation-detail-content"
          hidden={!detailPanelOpen}
        >
          <div className="booking-filter-row" role="group" aria-label="예약 필터">
            {([
              ["all", `전체 ${reservations.length}`],
              ["unpaid", `미결제 ${summary.unpaid}`],
              ["arrived", "입장"],
              ["unassigned", `미배정 ${summary.unassigned}`],
              ["cancelled", "취소"],
            ] as Array<[BookingFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={filter === value ? "is-active" : ""}
                onClick={() => setFilter(value)}
              >{label}</button>
            ))}
          </div>
          <div className="admin-safe-note">
            <strong>안전 운영</strong>
            <span>{manualStartMode ? "수동 시작 모드입니다. 게임 시작 버튼은 팀명만 입력하며, 직원이 매장 관리자 프로그램에서 난이도를 선택하고 시작 버튼을 직접 누릅니다." : "원격 시작 모드입니다. 게임 시작 버튼을 누르면 매장 관리자 프로그램에서 16분 카운트다운이 시작됩니다."}</span>
          </div>
          <div className="booking-list" aria-live="polite">
            {!loading && filteredReservations.length === 0 ? (
              <div className="admin-empty"><strong>조건에 맞는 예약이 없습니다.</strong><span>다른 필터나 날짜를 선택해주세요.</span></div>
            ) : null}
            {filteredReservations.map((reservation) => (
              <ReservationCard
                key={reservation.id}
                reservation={reservation}
                manualStartMode={manualStartMode}
                onChanged={commitReservationChange}
                onOpenCopied={openCopiedReservation}
                pricing={pricing}
                onEdit={() =>
                  setScheduleSelection({
                    time: reservation.scheduledTime,
                    roomCode: reservation.roomCode,
                    reservation,
                  })
                }
              />
            ))}
          </div>
        </div>
      </section>
        </div>
      </div>

      <footer>
        <span>구글시트와 기존 관리자 프로그램 원본은 변경하지 않습니다.</span>
        <form method="post" action="/api/pin-logout"><button type="submit">로그아웃</button></form>
      </footer>
      {scheduleSelection ? (
        <QuickBookingModal
          key={`${scheduleSelection.time}|${scheduleSelection.roomCode}|${scheduleSelection.reservation?.id ?? "new"}`}
          date={date}
          selection={scheduleSelection}
          status={status}
          manualStartMode={manualStartMode}
          onClose={() => setScheduleSelection(null)}
          onSaved={commitReservationChange}
          onOpenCopied={openCopiedReservation}
          onRefreshStatus={refreshStatus}
          pricing={pricing}
        />
      ) : null}
    </main>
  );
}
