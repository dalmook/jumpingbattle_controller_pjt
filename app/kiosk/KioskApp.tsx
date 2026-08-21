"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  kioskSlotStartsAfterRunningGame,
  parkingSessionPhase,
  splitKioskEqualAmount,
  type KioskPaymentMethod,
  type KioskPaymentMode,
} from "./domain";
import { createPartyPersistenceCoordinator, runPartyTransitionFirst } from "./party-persistence";
import { useTouchFeedbackRoot } from "../useTouchFeedback";
import { formatKoreanPhone, KioskInput, useKioskKeyboard } from "./KioskKeyboard";

type Room = {
  code: string; name: string; size: string; recommended: string; max: number; selectable: boolean;
  status: string; remainingSeconds: number; slots: string[];
  startedAt?: string; endsAt?: string; updatedAt?: string; preparedVisitId?: string;
  preparationState?: string; preparationTime?: string;
};
type Product = { code: string; name: string; price: number; status: string };
type Difficulty = { code: string; label: string; stars: string; description: string };
type Visit = {
  id: string; flowType: string; status: string; partyCount: number; adultCount: number; youthCount: number;
  gameCount?: number;
  draftVersion?: number;
  memberId: string; customerName: string; teamName: string; scheduledDate: string; scheduledTime: string;
  roomCode: string; difficultyCode: string; difficultyLabel: string; reservationId: string;
  addOns: Record<string, unknown>; settlement: Record<string, unknown>;
  amounts: { base: number; addOn: number; discount: number; final: number };
  hold: { id: string; date: string; time: string; roomCode: string; state: string; expiresAt: string } | null;
  error: { code: string; message: string } | null;
  startToken?: string;
  members?: Array<{ memberId: string; name: string; role: string }>;
  games?: Array<{
    id: string; sequence: number; status: string; scheduledDate: string; scheduledTime: string;
    roomCode: string; roomSize: KioskRoomSize; difficultyCode: string; difficultyLabel: string;
    mapIndex: number; adultCount: number; youthCount: number; partyCount: number; baseAmount: number;
    reservationId: string; expiresAt: string;
  }>;
};
type Member = {
  member: { id: string; name: string; phone: string; teamName: string };
  stamp: { balance: number; goal: number };
  passes: Array<{ id: string; productName: string; remainingUses: number; usable: boolean; expiresAt: string }>;
  coupons: Array<{ id: string; productName: string; usable: boolean; expiresAt: string; conditions: string }>;
};
type Bootstrap = {
  store: { name: string; today: string };
  rooms: Room[];
  products: Product[];
  difficulties: Record<string, Difficulty[]>;
  guidance: Array<{
    id: string; placement: string; title: string; summary: string; content: string;
    agreementText: string; required: boolean; version: number; sortOrder: number; active: boolean;
  }>;
  displaySettings: { homeTitle: string; homeSubtitle: string };
  roomRecommendation: { primarySize: KioskRoomSize; secondarySize: KioskRoomSize | ""; ruleId: string };
  parking: { enabled: boolean; registrationUrl: string; sessionMaxSeconds: number };
  paymentSettings: {
    operationMode: "STAFFED" | "UNMANNED";
    methods: Record<KioskPaymentMethod | "pass" | "coupon", boolean>;
    bankTransferConfirmationMode: "STAFF_CONFIRM" | "AUTO_CONFIRM";
    unmannedStaffConfirmationWarning: boolean;
  };
};
type ReservationResult = { id: string; customerName: string; time: string; roomCode: string; teamName: string; difficultyLabel: string; totalCount: number; amount: number; source: string };
type PaymentItemInput = { amount: number; paymentMethod: KioskPaymentMethod };
type PaymentPlanItem = {
  id: string; splitIndex: number; amount: number; paymentMethod: KioskPaymentMethod | "coupon";
  status: string; responseMessage?: string; errorCode?: string;
};
type PaymentOverview = {
  payment?: { status: string; splitCount: number } | null;
  summary?: { remainingAmount: number; approvedAmount: number; currentSplitIndex: number | null; hasUnknown: boolean } | null;
  plan: PaymentPlanItem[];
};
type TransferGuidance = {
  token: string; url: string; amount: number; bankName: string; accountNumber: string;
  accountHolder: string; guideText: string; depositorGuide: string; expiresAt: string;
};

type KioskRoomSize = "SMALL" | "MEDIUM" | "LARGE";
type Screen = "home" | "parking-intro" | "parking-active" | "parking-error" | "party" | "participant-topup" | "guide" | "assigning" | "fastest" | "reservation-confirm" | "identity" | "login" | "signup" | "reservation-search" | "reservation-results" | "team" | "room" | "difficulty" | "benefits" | "addons" | "review" | "payment" | "staff-payment" | "prepare-guide" | "preparing" | "ready-select" | "ready" | "starting" | "done" | "help";
type RoomStatusPayload = {
  snapshotAt: string;
  devicePaired: boolean;
  rooms: Array<Pick<Room, "code" | "status" | "startedAt" | "endsAt" | "updatedAt" | "preparedVisitId" | "preparationState" | "preparationTime"> & { roomId: string }>;
};
type KioskDraft = {
  clientRevision: number;
  adultCount: number;
  youthCount: number;
  customerMode: "" | "GUEST" | "MEMBER";
  teamName: string;
  vehicleLast4: string;
  roomCode: string;
  scheduledTime: string;
  difficultyCode: string;
  passBenefit: { id: string; ownerId: string; uses: number };
  couponBenefit: { id: string; ownerId: string };
  addOns: Record<string, unknown>;
};
type KioskLatencyTrace = {
  traceId: string;
  action: string;
  startedAt: number;
  lastAt: number;
};
function emptyKioskDraft(): KioskDraft {
  return {
    clientRevision: 0,
    adultCount: 0,
    youthCount: 2,
    customerMode: "",
    teamName: "",
    vehicleLast4: "",
    roomCode: "",
    scheduledTime: "",
    difficultyCode: "",
    passBenefit: { id: "", ownerId: "", uses: 1 },
    couponBenefit: { id: "", ownerId: "" },
    addOns: {},
  };
}

const SESSION_KEY = "jumping_kiosk_session";
const money = (value: number) => `${Math.max(0, Math.trunc(Number(value) || 0)).toLocaleString("ko-KR")}원`;
const mmss = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
function beginKioskLatencyTrace(action: string, stage: string): KioskLatencyTrace {
  const startedAt = performance.now();
  const trace = { traceId: `KIOSK-UI-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, action, startedAt, lastAt: startedAt };
  console.info("[KIOSK_PERF_FE]", JSON.stringify({ traceId: trace.traceId, action, stage, elapsedMs: 0, durationMs: 0 }));
  return trace;
}
function markKioskLatencyTrace(trace: KioskLatencyTrace, stage: string, details: Record<string, unknown> = {}) {
  const now = performance.now();
  console.info("[KIOSK_PERF_FE]", JSON.stringify({
    traceId: trace.traceId,
    action: trace.action,
    stage,
    elapsedMs: Math.round((now - trace.startedAt) * 10) / 10,
    durationMs: Math.round((now - trace.lastAt) * 10) / 10,
    ...details,
  }));
  trace.lastAt = now;
}
const difficultyStars: Record<string, number> = {
  kids: 1, basic: 1, summer: 2, easy: 2, space: 3, normal: 3, santa: 4, hard: 4, challenger: 5,
};
const difficultyDisplayMeta: Record<string, { english: string; stages: string; description: string }> = {
  kids: { english: "Kids", stages: "20단계", description: "가장 쉬워요" },
  basic: { english: "Basic", stages: "21단계", description: "처음 방문 추천" },
  summer: { english: "Summer", stages: "22단계", description: "쉬운 테마맵" },
  easy: { english: "Easy", stages: "21단계", description: "적당한 도전" },
  space: { english: "Space", stages: "21단계", description: "인기 테마맵" },
  normal: { english: "Normal", stages: "19단계", description: "조금 어려워요" },
  santa: { english: "Santa", stages: "18단계", description: "어려운 테마맵" },
  hard: { english: "Hard", stages: "17단계", description: "매우 어려워요" },
  challenger: { english: "Challenger", stages: "15단계", description: "최고 난이도" },
};
const difficultyGroups = [
  { key: "easy", label: "쉬워요", description: "처음 방문도 편안하게", codes: ["kids", "basic", "summer"], minStars: 1, maxStars: 2 },
  { key: "normal", label: "보통이에요", description: "재미와 도전을 함께", codes: ["easy", "space", "normal"], minStars: 2, maxStars: 3 },
  { key: "hard", label: "어려워요", description: "숙련된 팀을 위한 도전", codes: ["santa", "hard", "challenger"], minStars: 4, maxStars: 5 },
] as const;
const roomSizeMeta: Record<KioskRoomSize, { label: string; ratio: string; recommended: string }> = {
  SMALL: { label: "소형", ratio: "12 × 16", recommended: "2~4명 추천" },
  MEDIUM: { label: "중형", ratio: "16 × 16", recommended: "2~6명 추천" },
  LARGE: { label: "대형", ratio: "16 × 22", recommended: "4~8명 추천" },
};

function StarRating({ value }: { value: number }) {
  return <span className="difficulty-stars" aria-label={`난이도 별 ${value}개`}>{Array.from({ length: 5 }, (_, index) => <span className={index < value ? "filled" : ""} key={index}>★</span>)}</span>;
}

function KioskLineIcon({ name }: { name: "reservation" | "walkin" | "repeat" | "topup" | "addon" | "parking" | "card" | "cash" | "account" }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "reservation") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M7 3v3m10-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" /><path {...common} d="m8 14 2 2 5-5" /></svg>;
  if (name === "walkin") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M5 19 19 5m-8 0h8v8" /></svg>;
  if (name === "repeat") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M20 7v5h-5M4 17v-5h5" /><path {...common} d="M6.1 9A7 7 0 0 1 18.2 7M17.9 15A7 7 0 0 1 5.8 17" /></svg>;
  if (name === "topup") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle {...common} cx="9" cy="8" r="3" /><path {...common} d="M3.5 19c.5-3.2 2.4-5 5.5-5 2.1 0 3.7.8 4.6 2.3M18 11v7m-3.5-3.5h7" /></svg>;
  if (name === "addon") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M6 3h12l1 4-2 14H7L5 7l1-4Z" /><path {...common} d="M5 7h14M9 11h6" /></svg>;
  if (name === "parking") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M10 17V7h3a3 3 0 0 1 0 6h-3" /></svg>;
  if (name === "cash") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect {...common} x="3" y="6" width="18" height="12" rx="2" /><circle {...common} cx="12" cy="12" r="2.5" /><path {...common} d="M7 9H5m14 6h-2" /></svg>;
  if (name === "account") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="m3 9 9-5 9 5M5 10v7m4-7v7m6-7v7m4-7v7M3 20h18" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect {...common} x="3" y="5" width="18" height="14" rx="2" /><path {...common} d="M3 10h18M7 15h4" /></svg>;
}

function Icon({ children }: { children: React.ReactNode }) { return <span className="kiosk-icon" aria-hidden="true">{children}</span>; }

function enabledPaymentMethods(settings: Bootstrap["paymentSettings"] | undefined): KioskPaymentMethod[] {
  const methods: KioskPaymentMethod[] = ["card", "cash", "account"];
  return methods.filter((method) => settings?.methods[method] !== false);
}

function firstPaymentMethod(settings: Bootstrap["paymentSettings"] | undefined): KioskPaymentMethod {
  return enabledPaymentMethods(settings)[0] ?? "card";
}

export default function KioskApp() {
  const touchFeedbackRoot = useTouchFeedbackRoot<HTMLElement>();
  const { close: closeKioskKeyboard } = useKioskKeyboard();
  const [screen, setScreen] = useState<Screen>("home");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [visit, setVisit] = useState<Visit | null>(null);
  const [activeFlowType, setActiveFlowType] = useState<"" | "WALK_IN" | "RESERVATION" | "ADD_ON_ONLY" | "PARTY_TOP_UP" | "REPEAT_GAME">("");
  const [member, setMember] = useState<Member | null>(null);
  const [linkedMembers, setLinkedMembers] = useState<Member[]>([]);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const [history, setHistory] = useState<Screen[]>([]);
  const [reservations, setReservations] = useState<ReservationResult[]>([]);
  const [adultCount, setAdultCount] = useState(0);
  const [youthCount, setYouthCount] = useState(2);
  const [additionalAdultCount, setAdditionalAdultCount] = useState(0);
  const [additionalYouthCount, setAdditionalYouthCount] = useState(0);
  const [teamName, setTeamName] = useState("");
  const [vehicleLast4, setVehicleLast4] = useState("");
  const [teamEditing, setTeamEditing] = useState(false);
  const [reservationTeamQuery, setReservationTeamQuery] = useState("");
  const [loginPhone, setLoginPhone] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [signup, setSignup] = useState({ name: "", phone: "", password: "", confirm: "", teamName: "", agreed: false });
  const [guidanceChecks, setGuidanceChecks] = useState<Record<string, boolean>>({});
  const [guidanceRefreshState, setGuidanceRefreshState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [roomRecommendation, setRoomRecommendation] = useState<Bootstrap["roomRecommendation"] | null>(null);
  const [selectedRoomSize, setSelectedRoomSize] = useState<KioskRoomSize | "">("");
  const [selectedDifficulty, setSelectedDifficulty] = useState("");
  const [reservationDifficultyChange, setReservationDifficultyChange] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState("");
  const [selectedTime, setSelectedTime] = useState("");
  const [passBenefit, setPassBenefit] = useState({ id: "", ownerId: "", uses: 1 });
  const [couponBenefit, setCouponBenefit] = useState({ id: "", ownerId: "" });
  const [extraMemberOpen, setExtraMemberOpen] = useState(false);
  const [extraPhone, setExtraPhone] = useState("");
  const [extraPassword, setExtraPassword] = useState("");
  const [addOnCounts, setAddOnCounts] = useState<Record<string, number>>({});
  const [paymentMode, setPaymentMode] = useState<KioskPaymentMode>("single");
  const [paymentCount, setPaymentCount] = useState(2);
  const [paymentItems, setPaymentItems] = useState<PaymentItemInput[]>([{ amount: 0, paymentMethod: "card" }]);
  const [paymentOverview, setPaymentOverview] = useState<PaymentOverview | null>(null);
  const [paymentMethodOverrides, setPaymentMethodOverrides] = useState<Record<number, KioskPaymentMethod>>({});
  const [startCountdown, setStartCountdown] = useState<number | null>(null);
  const [startChecklistChecks, setStartChecklistChecks] = useState<Record<string, boolean>>({});
  const [devicePaired, setDevicePaired] = useState(false);
  const [roomStatus, setRoomStatus] = useState<RoomStatusPayload["rooms"]>([]);
  const [roomStatusUpdatedAt, setRoomStatusUpdatedAt] = useState(0);
  const [roomStatusDelayed, setRoomStatusDelayed] = useState(false);
  const [attemptId, setAttemptId] = useState("");
  const [transferGuidance, setTransferGuidance] = useState<TransferGuidance | null>(null);
  const [parkingEndsAt, setParkingEndsAt] = useState(0);
  const [parkingWarning, setParkingWarning] = useState(false);
  const [parkingNotice, setParkingNotice] = useState("");
  const [holdPending, setHoldPending] = useState(false);
  const [assignmentCanRetry, setAssignmentCanRetry] = useState(false);
  const [quotePending, setQuotePending] = useState(false);
  const [draftSyncState, setDraftSyncState] = useState<"idle" | "saving" | "retrying">("idle");
  const [cancelDialogMode, setCancelDialogMode] = useState<"progress" | "payment" | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const idleRef = useRef<number | null>(null);
  const roomStatusRequestRef = useRef<AbortController | null>(null);
  const stateRequestInFlightRef = useRef(false);
  const startRequestInFlightRef = useRef(false);
  const pendingTraceRef = useRef<{ traceId: string; action: string; startedAt: number; responseAt: number } | null>(null);
  const parkingPopupRef = useRef<Window | null>(null);
  const parkingTimeoutRef = useRef<number | null>(null);
  const parkingFinishingRef = useRef(false);
  const recommendationAbortRef = useRef<AbortController | null>(null);
  const staffMenuTimerRef = useRef<number | null>(null);
  const screenRef = useRef<Screen>("home");
  const tokenRef = useRef("");
  const flowGenerationRef = useRef(0);
  const assignmentAttemptRef = useRef(0);
  const assignmentAbortRef = useRef<AbortController | null>(null);
  const sessionPromiseRef = useRef<Promise<{ token: string; visit: Visit }> | null>(null);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const partyBarrierRef = useRef<ReturnType<typeof createPartyPersistenceCoordinator> | null>(null);
  if (!partyBarrierRef.current) partyBarrierRef.current = createPartyPersistenceCoordinator(0);
  const draftRef = useRef<KioskDraft>(emptyKioskDraft());
  const queuedDraftRef = useRef<KioskDraft | null>(null);
  const draftDrainRef = useRef<Promise<void> | null>(null);
  const draftAbortRef = useRef<AbortController | null>(null);
  const draftRetryTimerRef = useRef<number | null>(null);
  const drainDraftQueueRef = useRef<() => Promise<void>>(async () => undefined);

  const request = useCallback(async <T,>(
    body: Record<string, unknown>,
    currentToken = token,
    options: { signal?: AbortSignal; background?: boolean; trace?: KioskLatencyTrace } = {},
  ): Promise<T> => {
    const action = String(body.action ?? "unknown");
    const traceId = options.trace?.traceId ?? `KIOSK-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const startedAt = performance.now();
    console.info("[KIOSK_PERF_FE]", JSON.stringify({
      traceId,
      action,
      stage: options.background ? "FE_API_START" : "FE_CLICK",
      elapsedMs: options.trace ? Math.round((startedAt - options.trace.startedAt) * 10) / 10 : 0,
      durationMs: 0,
    }));
    const response = await fetch("/api/kiosk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kiosk-trace-id": traceId,
        ...(currentToken ? { "x-customer-session": currentToken } : {}),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    const payload = await response.json() as T & { error?: string; code?: string };
    const responseAt = performance.now();
    console.info("[KIOSK_PERF_FE]", JSON.stringify({
      traceId,
      action,
      stage: "FE_API_RESPONSE_BODY",
      elapsedMs: Math.round((responseAt - (options.trace?.startedAt ?? startedAt)) * 10) / 10,
      durationMs: Math.round((responseAt - startedAt) * 10) / 10,
      serverTiming: response.headers.get("server-timing") ?? "",
    }));
    if (!response.ok) throw new Error(payload.error || payload.code || "처리하지 못했습니다.");
    if (!options.background) pendingTraceRef.current = { traceId, action, startedAt: options.trace?.startedAt ?? startedAt, responseAt };
    return payload;
  }, [token]);

  const callStaff = useCallback(async () => {
    setError("직원을 호출했습니다. 잠시만 기다려주세요.");
    const currentToken = tokenRef.current;
    if (!currentToken) return;
    try {
      await request<{ ok: boolean }>({ action: "staff_help" }, currentToken, { background: true });
    } catch {
      setError("직원 호출을 전송하지 못했습니다. 잠시 후 다시 눌러주세요.");
    }
  }, [request]);

  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { closeKioskKeyboard(); }, [closeKioskKeyboard, screen]);
  useEffect(() => { screenRef.current = screen; }, [screen]);

  const markAfterRender = useCallback((trace: KioskLatencyTrace, stage: string, expectedScreen: Screen, generation: number) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (generation !== flowGenerationRef.current || screenRef.current !== expectedScreen) return;
      markKioskLatencyTrace(trace, stage, { screen: expectedScreen });
    }));
  }, []);

  useEffect(() => {
    const pending = pendingTraceRef.current;
    if (!pending) return;
    const first = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (pendingTraceRef.current !== pending) return;
        console.info("[KIOSK_PERF_FE]", JSON.stringify({
          traceId: pending.traceId,
          action: pending.action,
          stage: "FE_RENDER_DONE",
          elapsedMs: Math.round((performance.now() - pending.startedAt) * 10) / 10,
          renderAfterResponseMs: Math.round((performance.now() - pending.responseAt) * 10) / 10,
          screen,
        }));
        pendingTraceRef.current = null;
      });
    });
    return () => window.cancelAnimationFrame(first);
  }, [screen]);

  const requireSessionToken = useCallback(async () => {
    if (tokenRef.current) return tokenRef.current;
    const pending = sessionPromiseRef.current;
    if (!pending) throw new Error("KIOSK_SESSION_NOT_FOUND");
    const result = await pending;
    return result.token;
  }, []);

  const drainDraftQueue = useCallback(async () => {
    if (draftDrainRef.current) return draftDrainRef.current;
    const generation = flowGenerationRef.current;
    const run = (async () => {
      while (generation === flowGenerationRef.current && queuedDraftRef.current) {
        const snapshot = queuedDraftRef.current;
        queuedDraftRef.current = null;
        const controller = new AbortController();
        draftAbortRef.current = controller;
        try {
          const sessionToken = await requireSessionToken();
          const result = await request<{ ok: boolean; draftVersion: number }>(
            { action: "sync_draft", draft: snapshot },
            sessionToken,
            { signal: controller.signal, background: true },
          );
          if (generation !== flowGenerationRef.current) return;
          if (result.draftVersion < snapshot.clientRevision) {
            throw new Error("KIOSK_DRAFT_VERSION_NOT_CONFIRMED");
          }
          console.info("[KIOSK_PERF_FE]", JSON.stringify({
            action: "sync_draft",
            stage: "DRAFT_SYNC_DONE",
            clientRevision: snapshot.clientRevision,
            draftVersion: result.draftVersion,
            queueDepth: queuedDraftRef.current ? 1 : 0,
          }));
        } catch (reason) {
          if (generation !== flowGenerationRef.current || (reason instanceof DOMException && reason.name === "AbortError")) return;
          const queuedAfterFailure = queuedDraftRef.current as KioskDraft | null;
          if (!queuedAfterFailure || queuedAfterFailure.clientRevision < snapshot.clientRevision) {
            queuedDraftRef.current = snapshot;
          }
          setDraftSyncState("retrying");
          if (draftRetryTimerRef.current === null) {
            draftRetryTimerRef.current = window.setTimeout(() => {
              draftRetryTimerRef.current = null;
              void drainDraftQueueRef.current().catch(() => undefined);
            }, 1_200);
          }
          throw reason;
        } finally {
          if (draftAbortRef.current === controller) draftAbortRef.current = null;
        }
      }
      if (generation === flowGenerationRef.current) setDraftSyncState("idle");
    })();
    draftDrainRef.current = run;
    try {
      await run;
    } finally {
      if (draftDrainRef.current === run) draftDrainRef.current = null;
      if (generation === flowGenerationRef.current && queuedDraftRef.current && draftRetryTimerRef.current === null) {
        queueMicrotask(() => void drainDraftQueueRef.current().catch(() => undefined));
      }
    }
  }, [request, requireSessionToken]);

  useEffect(() => { drainDraftQueueRef.current = drainDraftQueue; }, [drainDraftQueue]);

  const nextDraftSnapshot = useCallback((patch: Partial<Omit<KioskDraft, "clientRevision">>) => {
    const next: KioskDraft = {
      ...draftRef.current,
      ...patch,
      clientRevision: draftRef.current.clientRevision + 1,
    };
    draftRef.current = next;
    return next;
  }, []);

  const queueDraftSnapshot = useCallback((snapshot: KioskDraft) => {
    if (!queuedDraftRef.current || queuedDraftRef.current.clientRevision <= snapshot.clientRevision) {
      queuedDraftRef.current = snapshot;
    }
    console.info("[KIOSK_PERF_FE]", JSON.stringify({
      action: "sync_draft",
      stage: "DRAFT_QUEUED",
      clientRevision: snapshot.clientRevision,
      queueDepth: 1 + (draftDrainRef.current ? 1 : 0),
    }));
    setDraftSyncState("saving");
    void drainDraftQueueRef.current().catch(() => undefined);
  }, []);

  const waitForDraftBarrier = useCallback(async () => {
    const startedAt = performance.now();
    console.info("[KIOSK_PERF_FE]", JSON.stringify({ action: "draft_barrier", stage: "BARRIER_WAIT_START", queueDepth: (queuedDraftRef.current ? 1 : 0) + (draftDrainRef.current ? 1 : 0) }));
    for (;;) {
      if (queuedDraftRef.current && !draftDrainRef.current) void drainDraftQueueRef.current().catch(() => undefined);
      const pending = draftDrainRef.current;
      if (!pending) {
        if (!queuedDraftRef.current) {
          console.info("[KIOSK_PERF_FE]", JSON.stringify({ action: "draft_barrier", stage: "BARRIER_WAIT_DONE", elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10 }));
          return;
        }
        throw new Error("입력 내용을 저장하고 있습니다. 잠시 후 다시 눌러주세요.");
      }
      try { await pending; }
      catch { throw new Error("입력 내용을 저장하고 있습니다. 잠시 후 다시 눌러주세요."); }
    }
  }, []);

  const enqueuePartyPersistence = useCallback((input: {
    generation: number;
    inputKey: string;
    adultCount: number;
    youthCount: number;
    snapshot: KioskDraft;
    trace: KioskLatencyTrace;
  }) => {
    const coordinator = partyBarrierRef.current;
    if (!coordinator) throw new Error("PARTY_PERSISTENCE_NOT_READY");
    return coordinator.enqueue({
      generation: input.generation,
      inputKey: input.inputKey,
      revision: input.snapshot.clientRevision,
      execute: async ({ signal, isGenerationActive, isLatest }) => {
        markKioskLatencyTrace(input.trace, "PARTY_BACKGROUND_START", { revision: input.snapshot.clientRevision });
        const sessionToken = await requireSessionToken();
        if (!isGenerationActive()) return;
        const result = await request<Visit & { roomRecommendation: Bootstrap["roomRecommendation"] }>(
          { action: "party", adultCount: input.adultCount, youthCount: input.youthCount },
          sessionToken,
          { signal, background: true, trace: input.trace },
        );
        if (!isGenerationActive()) return;
        markKioskLatencyTrace(input.trace, "PARTY_API_DONE", { revision: input.snapshot.clientRevision });
        if (isLatest()) {
          setVisit((current) => current ? {
            ...current,
            adultCount: result.adultCount,
            youthCount: result.youthCount,
            partyCount: result.partyCount,
            draftVersion: Math.max(current.draftVersion || 0, result.draftVersion || 0),
            amounts: result.amounts,
            error: result.error,
          } : result);
          setRoomRecommendation(result.roomRecommendation);
          draftRef.current = {
            ...draftRef.current,
            clientRevision: Math.max(draftRef.current.clientRevision, result.draftVersion || input.snapshot.clientRevision),
          };
        }
      },
      onDone: () => markKioskLatencyTrace(input.trace, "PARTY_BARRIER_DONE", { revision: input.snapshot.clientRevision }),
      onFailed: () => markKioskLatencyTrace(input.trace, "PARTY_BARRIER_FAILED", { revision: input.snapshot.clientRevision }),
    });
  }, [request, requireSessionToken]);

  const waitForPartyBarrier = useCallback(async (trace?: KioskLatencyTrace) => {
    const coordinator = partyBarrierRef.current;
    const pending = coordinator?.peek();
    if (trace) markKioskLatencyTrace(trace, "PARTY_BARRIER_WAIT_START", { status: pending?.status ?? "none" });
    if (!coordinator) return;
    await coordinator.wait();
    const completed = coordinator.peek();
    if (trace) markKioskLatencyTrace(trace, "PARTY_BARRIER_WAIT_DONE", { status: completed?.status ?? "none", revision: completed?.revision });
  }, []);

  const cancelDraftWork = useCallback(() => {
    flowGenerationRef.current += 1;
    assignmentAttemptRef.current += 1;
    assignmentAbortRef.current?.abort();
    assignmentAbortRef.current = null;
    recommendationAbortRef.current?.abort();
    recommendationAbortRef.current = null;
    sessionAbortRef.current?.abort();
    sessionAbortRef.current = null;
    partyBarrierRef.current?.reset(flowGenerationRef.current);
    draftAbortRef.current?.abort();
    draftAbortRef.current = null;
    if (draftRetryTimerRef.current !== null) window.clearTimeout(draftRetryTimerRef.current);
    draftRetryTimerRef.current = null;
    sessionPromiseRef.current = null;
    queuedDraftRef.current = null;
    draftDrainRef.current = null;
    draftRef.current = emptyKioskDraft();
    setDraftSyncState("idle");
    setHoldPending(false);
    setAssignmentCanRetry(false);
    setQuotePending(false);
    return flowGenerationRef.current;
  }, []);

  const loadBootstrap = useCallback(async () => {
    const response = await fetch("/api/kiosk", { cache: "no-store" });
    const payload = await response.json() as Bootstrap & { error?: string };
    if (!response.ok) throw new Error(payload.error || "매장 정보를 불러오지 못했습니다.");
    setBootstrap(payload);
  }, []);

  useEffect(() => { void loadBootstrap().catch((reason) => setError(reason instanceof Error ? reason.message : "연결을 확인해주세요.")); }, [loadBootstrap]);
  useEffect(() => {
    if (screen !== "guide") return;
    let active = true;
    setGuidanceChecks({});
    setGuidanceRefreshState("loading");
    void loadBootstrap()
      .then(() => { if (active) setGuidanceRefreshState("ready"); })
      .catch((reason) => {
        if (!active) return;
        setGuidanceRefreshState("error");
        setError(reason instanceof Error ? reason.message : "필수 안내를 다시 확인하지 못했습니다.");
      });
    return () => { active = false; };
  }, [loadBootstrap, screen]);
  useEffect(() => {
    const initial = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!["home", "room", "ready-select"].includes(screen)) return;
    let active = true;
    let timer: number | null = null;
    const schedule = () => {
      if (!active || document.hidden) return;
      timer = window.setTimeout(() => void refresh(), 2_000);
    };
    const refresh = async () => {
      if (!active || document.hidden || roomStatusRequestRef.current) return;
      const controller = new AbortController();
      roomStatusRequestRef.current = controller;
      try {
        const response = await fetch("/api/kiosk?scope=room_status", { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as RoomStatusPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error || "방 상태를 확인하지 못했습니다.");
        if (!active) return;
        setRoomStatus(payload.rooms);
        setDevicePaired(payload.devicePaired === true);
        setRoomStatusUpdatedAt(Date.parse(payload.snapshotAt) || Date.now());
        setRoomStatusDelayed(false);
      } catch (reason) {
        if (active && !(reason instanceof DOMException && reason.name === "AbortError")) setRoomStatusDelayed(true);
      } finally {
        if (roomStatusRequestRef.current === controller) roomStatusRequestRef.current = null;
        schedule();
      }
    };
    const visibility = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (document.hidden) roomStatusRequestRef.current?.abort();
      else void refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    void refresh();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      roomStatusRequestRef.current?.abort();
      roomStatusRequestRef.current = null;
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [screen]);

  useEffect(() => {
    const flowType = visit?.flowType || activeFlowType;
    if (screen !== "party" || flowType !== "WALK_IN") return;
    recommendationAbortRef.current?.abort();
    if (adultCount + youthCount < 1) {
      setRoomRecommendation(null);
      return;
    }
    const controller = new AbortController();
    recommendationAbortRef.current = controller;
    const timer = window.setTimeout(async () => {
      try {
        const search = new URLSearchParams({
          scope: "room_recommendation",
          adultCount: String(adultCount),
          youthCount: String(youthCount),
        });
        const response = await fetch(`/api/kiosk?${search.toString()}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { roomRecommendation?: Bootstrap["roomRecommendation"]; error?: string };
        if (!response.ok) throw new Error(payload.error || "추천 방을 확인하지 못했습니다.");
        if (payload.roomRecommendation) setRoomRecommendation(payload.roomRecommendation);
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) setRoomRecommendation(null);
      }
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (recommendationAbortRef.current === controller) recommendationAbortRef.current = null;
    };
  }, [activeFlowType, adultCount, screen, visit?.flowType, youthCount]);

  const clearParkingTimeout = useCallback(() => {
    if (parkingTimeoutRef.current === null) return;
    window.clearTimeout(parkingTimeoutRef.current);
    parkingTimeoutRef.current = null;
  }, []);

  const closeParkingPopup = useCallback(() => {
    const popup = parkingPopupRef.current;
    try {
      popup?.close();
    } catch {
      // A cross-origin popup can detach its WindowProxy. Local cleanup must still continue.
    } finally {
      parkingPopupRef.current = null;
    }
  }, []);

  const clearLocalHome = useCallback(() => {
    closeKioskKeyboard();
    cancelDraftWork();
    clearParkingTimeout();
    closeParkingPopup();
    setParkingEndsAt(0);
    setParkingWarning(false);
    sessionStorage.removeItem(SESSION_KEY);
    tokenRef.current = "";
    screenRef.current = "home";
    setToken(""); setVisit(null); setActiveFlowType(""); setMember(null); setHistory([]); setScreen("home"); setError("");
    setReservations([]); setAdultCount(0); setYouthCount(2); setAdditionalAdultCount(0); setAdditionalYouthCount(0); setTeamName(""); setVehicleLast4("");
    setTeamEditing(false);
    setReservationTeamQuery(""); setLoginPhone(""); setLoginPassword(""); setSignup({ name: "", phone: "", password: "", confirm: "", teamName: "", agreed: false }); setSelectedRoom(""); setSelectedTime("");
    setGuidanceChecks({}); setRoomRecommendation(null); setSelectedRoomSize(""); setSelectedDifficulty(""); setReservationDifficultyChange(false);
    setPassBenefit({ id: "", ownerId: "", uses: 1 }); setCouponBenefit({ id: "", ownerId: "" }); setAddOnCounts({}); setAttemptId("");
    setTransferGuidance(null);
    setPaymentMode("single"); setPaymentCount(2); setPaymentItems([{ amount: 0, paymentMethod: "card" }]);
    setPaymentOverview(null); setPaymentMethodOverrides({}); setStartCountdown(null); setStartChecklistChecks({});
    startRequestInFlightRef.current = false;
    setLinkedMembers([]); setExtraMemberOpen(false); setExtraPhone(""); setExtraPassword("");
    setCancelDialogMode(null); setCancelBusy(false);
    void loadBootstrap().catch(() => undefined);
  }, [cancelDraftWork, clearParkingTimeout, closeKioskKeyboard, closeParkingPopup, loadBootstrap]);

  const resetHome = useCallback(async (release = true) => {
    const previousToken = tokenRef.current || token;
    const criticalStatus = ["PAYMENT_PENDING", "WAITING_STAFF_CONFIRMATION", "STAFF_REVIEW", "PREPARING", "READY_TO_PLAY", "PLAYING"].includes(visit?.status || "");
    if (release && previousToken) {
      if (criticalStatus) {
        setError("진행 중인 결제나 게임 상태를 먼저 확인해주세요.");
        return false;
      }
      try {
        await request({ action: "reset" }, previousToken, { background: true });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "진행 중인 내용을 정리하지 못했습니다. 직원에게 알려주세요.");
        return false;
      }
    }
    clearLocalHome();
    return true;
  }, [clearLocalHome, request, token, visit?.status]);

  useEffect(() => {
    const touch = () => {
      if (idleRef.current) window.clearTimeout(idleRef.current);
      if (!token || ["payment", "staff-payment", "prepare-guide", "preparing", "ready", "starting"].includes(screen)) return;
      idleRef.current = window.setTimeout(() => void resetHome(), 90_000);
    };
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    touch();
    return () => { window.removeEventListener("pointerdown", touch); window.removeEventListener("keydown", touch); if (idleRef.current) window.clearTimeout(idleRef.current); };
  }, [resetHome, screen, token]);

  useEffect(() => () => {
    if (staffMenuTimerRef.current !== null) window.clearTimeout(staffMenuTimerRef.current);
  }, []);

  const go = useCallback((next: Screen) => { setHistory((current) => [...current, screen]); screenRef.current = next; setScreen(next); setError(""); window.scrollTo(0, 0); }, [screen]);
  const goInstant = useCallback((next: Screen, action: string, options: {
    trace?: KioskLatencyTrace;
    renderStage?: string;
    generation?: number;
    replace?: boolean;
  } = {}) => {
    const traceId = options.trace ? "" : `KIOSK-UI-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const startedAt = performance.now();
    if (!options.trace) console.info("[KIOSK_PERF_FE]", JSON.stringify({ traceId, action, stage: "FE_CLICK", elapsedMs: 0 }));
    if (options.replace) {
      screenRef.current = next;
      setScreen(next);
      setError("");
      window.scrollTo(0, 0);
    } else {
      go(next);
    }
    if (options.trace) {
      markAfterRender(options.trace, options.renderStage ?? "FE_RENDER_DONE", next, options.generation ?? flowGenerationRef.current);
      return;
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      console.info("[KIOSK_PERF_FE]", JSON.stringify({
        traceId,
        action,
        stage: "FE_RENDER_DONE",
        elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
        screen: next,
        optimistic: true,
      }));
    }));
  }, [go, markAfterRender]);
  const back = () => {
    if (screenRef.current === "assigning") {
      returnToDifficultyFromAssignment();
      return;
    }
    const next = history.at(-1) ?? "home";
    if (next === "home") {
      void resetHome();
      return;
    }
    setHistory((current) => current.slice(0, -1));
    screenRef.current = next;
    setScreen(next);
    setError("");
  };

  const finishParking = useCallback((reason: "closed" | "completed" | "timeout") => {
    if (parkingFinishingRef.current) return;
    parkingFinishingRef.current = true;
    const popup = parkingPopupRef.current;
    try {
      popup?.close();
    } catch {
      // Closing can fail after a cross-origin WindowProxy is detached.
    } finally {
      parkingPopupRef.current = null;
      clearParkingTimeout();
      setParkingEndsAt(0);
      setParkingWarning(false);
      setParkingNotice(reason === "timeout" ? "주차등록 이용시간이 끝나 처음 화면으로 돌아왔어요." : "주차등록 화면을 종료하고 처음 화면으로 돌아왔어요.");
      void resetHome(false);
    }
  }, [clearParkingTimeout, resetHome]);

  function startParkingRegistration() {
    const parking = bootstrap?.parking;
    setError("");
    setParkingNotice("");
    if (!parking?.enabled) {
      setScreen("parking-error");
      setError("현재 주차등록을 사용할 수 없습니다.");
      return;
    }
    let target: URL;
    try {
      target = new URL(parking.registrationUrl);
      if (target.protocol !== "https:" || target.hostname !== "parking.example.com" || !target.pathname.startsWith("/discount/registration")) {
        throw new Error("PARKING_URL_NOT_ALLOWED");
      }
    } catch {
      setScreen("parking-error");
      setError("주차등록 주소를 확인할 수 없습니다.");
      return;
    }
    const width = Math.max(900, window.screen.availWidth || window.innerWidth);
    const height = Math.max(700, window.screen.availHeight || window.innerHeight);
    const popup = window.open("about:blank", "jumping-parking-registration", `popup=yes,width=${width},height=${height},left=0,top=0,toolbar=no,menubar=no,location=no,status=no,scrollbars=yes,resizable=yes`);
    if (!popup) {
      setScreen("parking-error");
      setError("주차등록 전용창을 열지 못했습니다. 직원에게 알려주세요.");
      return;
    }
    try {
      popup.opener = null;
      popup.location.replace(target.toString());
      popup.moveTo(0, 0);
      popup.resizeTo(width, height);
      popup.focus();
    } catch {
      popup.close();
      setScreen("parking-error");
      setError("주차등록 화면에 연결하지 못했습니다.");
      return;
    }
    parkingPopupRef.current = popup;
    parkingFinishingRef.current = false;
    const endsAt = Date.now() + parking.sessionMaxSeconds * 1_000;
    setParkingEndsAt(endsAt);
    setParkingWarning(false);
    setScreen("parking-active");
    clearParkingTimeout();
    const expire = () => {
      const remaining = endsAt - Date.now();
      if (remaining > 0) {
        parkingTimeoutRef.current = window.setTimeout(expire, remaining);
        return;
      }
      finishParking("timeout");
    };
    parkingTimeoutRef.current = window.setTimeout(expire, Math.max(0, endsAt - Date.now()));
  }

  useEffect(() => {
    if (screen !== "parking-active" || !parkingEndsAt) return;
    const checkSession = () => {
      const popup = parkingPopupRef.current;
      if (!popup) {
        finishParking("closed");
        return;
      }
      const phase = parkingSessionPhase(Date.now(), parkingEndsAt);
      if (phase.expired) {
        finishParking("timeout");
        return;
      }
      let popupClosed = false;
      try {
        popupClosed = popup.closed;
      } catch {
        // Keep the deadline alive when the external page detaches its WindowProxy.
      }
      if (popupClosed && !document.hidden) {
        finishParking("closed");
        return;
      }
      setParkingWarning(phase.warning);
    };
    const check = window.setInterval(checkSession, 500);
    const checkOnVisibility = () => {
      if (!document.hidden) checkSession();
    };
    const closeOnExit = () => {
      clearParkingTimeout();
      closeParkingPopup();
    };
    document.addEventListener("visibilitychange", checkOnVisibility);
    window.addEventListener("focus", checkSession);
    window.addEventListener("pagehide", closeOnExit);
    return () => {
      window.clearInterval(check);
      document.removeEventListener("visibilitychange", checkOnVisibility);
      window.removeEventListener("focus", checkSession);
      window.removeEventListener("pagehide", closeOnExit);
    };
  }, [clearParkingTimeout, closeParkingPopup, finishParking, parkingEndsAt, screen]);

  function begin(flowType: "WALK_IN" | "RESERVATION" | "ADD_ON_ONLY" | "PARTY_TOP_UP" | "REPEAT_GAME") {
    if (sessionPromiseRef.current || tokenRef.current) return;
    const generation = cancelDraftWork();
    setError("");
    setParkingNotice("");
    setActiveFlowType(flowType);
    draftRef.current = { ...emptyKioskDraft(), adultCount, youthCount };
    const nextScreen = ["RESERVATION", "PARTY_TOP_UP", "REPEAT_GAME"].includes(flowType)
      ? "reservation-search"
      : flowType === "ADD_ON_ONLY" ? "addons" : "party";
    goInstant(nextScreen, "create_session_transition");

    const controller = new AbortController();
    sessionAbortRef.current = controller;
    const pending = request<{ token: string; visit: Visit }>(
      { action: "create_session", kioskId: "store-kiosk-1", flowType },
      "",
      { signal: controller.signal, background: true },
    );
    sessionPromiseRef.current = pending;
    void pending.then((result) => {
      if (generation !== flowGenerationRef.current) return;
      sessionAbortRef.current = null;
      tokenRef.current = result.token;
      setToken(result.token);
      sessionStorage.setItem(SESSION_KEY, result.token);
      const local = draftRef.current;
      setVisit({
        ...result.visit,
        partyCount: flowType === "ADD_ON_ONLY" ? 0 : local.adultCount + local.youthCount,
        adultCount: local.adultCount,
        youthCount: local.youthCount,
        teamName: local.teamName,
      });
      if (queuedDraftRef.current) void drainDraftQueueRef.current().catch(() => undefined);
    }).catch((reason) => {
      if (generation !== flowGenerationRef.current || (reason instanceof DOMException && reason.name === "AbortError")) return;
      sessionPromiseRef.current = null;
      queuedDraftRef.current = null;
      setDraftSyncState("idle");
      setHistory([]);
      setScreen("home");
      setError(reason instanceof Error ? reason.message : "시작하지 못했습니다.");
    });
  }

  async function saveParty() {
    if (adultCount + youthCount < 1 || adultCount + youthCount > 10) {
      setError("이용 인원을 1명 이상 10명 이하로 선택해주세요.");
      return;
    }
    if (currentFlowType === "WALK_IN" && !selectedRoomSize) {
      setError("이용할 방 크기를 선택해주세요.");
      return;
    }
    if (screenRef.current !== "party") return;
    const trace = beginKioskLatencyTrace("party_transition", "PARTY_CLICK");
    const generation = flowGenerationRef.current;
    const inputKey = JSON.stringify({ adultCount, youthCount, roomSize: currentFlowType === "WALK_IN" ? selectedRoomSize : "" });
    const existing = partyBarrierRef.current?.peek();
    const nextScreen: Screen = currentFlowType === "RESERVATION" ? "reservation-confirm" : "difficulty";
    if (existing && existing.generation === generation && existing.inputKey === inputKey && !["failed", "cancelled"].includes(existing.status)) {
      go(nextScreen);
      markKioskLatencyTrace(trace, "PARTY_NEXT_SCREEN_SET", { screen: nextScreen, reusedBarrier: true });
      markAfterRender(trace, nextScreen === "difficulty" ? "DIFFICULTY_RENDER" : "RESERVATION_CONFIRM_RENDER", nextScreen, generation);
      return;
    }
    setError("");
    let snapshot = draftRef.current;
    runPartyTransitionFirst({
      applyLocal: () => {
        snapshot = nextDraftSnapshot({ adultCount, youthCount });
        setVisit((current) => current ? { ...current, adultCount, youthCount, partyCount: adultCount + youthCount } : current);
        markKioskLatencyTrace(trace, "PARTY_LOCAL_APPLIED", { revision: snapshot.clientRevision });
      },
      transition: () => {
        goInstant(nextScreen, "party_and_guidance_transition", {
          trace,
          renderStage: nextScreen === "difficulty" ? "DIFFICULTY_RENDER" : "RESERVATION_CONFIRM_RENDER",
          generation,
        });
        markKioskLatencyTrace(trace, "PARTY_NEXT_SCREEN_SET", { screen: nextScreen });
      },
      enqueue: () => enqueuePartyPersistence({ generation, inputKey, adultCount, youthCount, snapshot, trace }),
    });
  }

  async function acceptGuidance() {
    if (guidanceRefreshState !== "ready") {
      setError("최신 필수 안내를 확인한 뒤 다시 시도해주세요.");
      return;
    }
    const requiredGuidance = (bootstrap?.guidance ?? []).filter((item) => item.active && item.placement === "REQUIRED_AGREEMENT" && item.required);
    if (requiredGuidance.some((item) => !guidanceChecks[item.id])) {
      setError("필수 안내를 확인하고 동의해주세요.");
      return;
    }
    setBusy(true); setError("");
    try {
      await request({
        action: "accept_guidance",
        guidanceIds: (bootstrap?.guidance ?? [])
          .filter((item) => item.active && item.placement === "REQUIRED_AGREEMENT" && guidanceChecks[item.id])
          .map((item) => item.id),
      }, await requireSessionToken());
      await quote("review");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "필수 안내 동의를 저장하지 못했습니다."); }
    finally { setBusy(false); }
  }

  function asGuest() {
    setError("");
    const snapshot = nextDraftSnapshot({ customerMode: "GUEST" });
    setVisit((current) => current ? { ...current, customerName: "현장 고객" } : current);
    setTeamEditing(true);
    goInstant("team", "guest_transition");
    queueDraftSnapshot(snapshot);
  }

  async function login() {
    setBusy(true); setError("");
    try {
      await waitForPartyBarrier();
      await waitForDraftBarrier();
      const sessionToken = await requireSessionToken();
      const result = await request<{ visit: Visit; member: Member }>({ action: "login", phone: loginPhone, password: loginPassword }, sessionToken);
      draftRef.current = { ...draftRef.current, customerMode: "MEMBER", teamName: result.visit.teamName || result.member.member.teamName };
      setVisit(result.visit); setMember(result.member); setLinkedMembers([result.member]); setTeamName(result.visit.teamName || result.member.member.teamName); setTeamEditing(false); go("team");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "로그인하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function register() {
    if (!signup.password || signup.password !== signup.confirm) { setError("비밀번호 확인이 일치하지 않습니다."); return; }
    setBusy(true); setError("");
    try {
      await waitForPartyBarrier();
      await waitForDraftBarrier();
      const sessionToken = await requireSessionToken();
      const result = await request<{ visit: Visit; member: Member }>({ action: "register", ...signup }, sessionToken);
      draftRef.current = { ...draftRef.current, customerMode: "MEMBER", teamName: result.visit.teamName || signup.teamName };
      setVisit(result.visit); setMember(result.member); setLinkedMembers([result.member]); setTeamName(result.visit.teamName || signup.teamName); setTeamEditing(!(result.visit.teamName || signup.teamName)); go("team");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "가입하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function searchReservation() {
    setBusy(true); setError("");
    try {
      const participantTopUp = currentFlowType === "PARTY_TOP_UP";
      const repeatGame = currentFlowType === "REPEAT_GAME";
      const result = await request<{ reservations: ReservationResult[] }>({
        action: "find_reservations",
        ...(participantTopUp || repeatGame ? { teamName: reservationTeamQuery.trim() } : { phone: loginPhone }),
      }, await requireSessionToken());
      setReservations(result.reservations);
      if (!result.reservations.length) {
        setError(participantTopUp
          ? "오늘 결제가 완료된 게임을 찾지 못했습니다. 팀명을 확인해주세요."
          : repeatGame ? "방금 완료한 게임을 찾지 못했습니다. 팀명을 확인해주세요."
          : "오늘 이용할 예약을 찾지 못했습니다. 휴대폰 번호를 확인해주세요.");
      }
      else go("reservation-results");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "예약을 찾지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function chooseReservation(id: string) {
    setBusy(true); setError("");
    try {
      const result = await request<Visit & { repeatMember?: Member | null }>({ action: "select_reservation", reservationId: id }, await requireSessionToken());
      if (result.flowType === "REPEAT_GAME") {
        const repeatedSize: KioskRoomSize = result.roomCode === "B1"
          ? result.difficultyCode.startsWith("b1-medium-") ? "MEDIUM" : "LARGE"
          : result.roomCode === "A1" ? "MEDIUM" : "SMALL";
        setActiveFlowType("REPEAT_GAME");
        setVisit(result);
        setAdultCount(result.adultCount);
        setYouthCount(result.youthCount);
        setTeamName(result.teamName);
        setSelectedRoomSize(repeatedSize);
        setSelectedDifficulty("");
        if (result.repeatMember) {
          setMember(result.repeatMember);
          setLinkedMembers([result.repeatMember]);
        } else {
          setMember(null);
          setLinkedMembers([]);
        }
        go("difficulty");
        return;
      }
      if (result.flowType === "PARTY_TOP_UP") {
        setActiveFlowType("PARTY_TOP_UP");
        setVisit(result);
        setAdultCount(result.adultCount);
        setYouthCount(result.youthCount);
        setAdditionalAdultCount(0);
        setAdditionalYouthCount(0);
        go("participant-topup");
        return;
      }
      setActiveFlowType("RESERVATION");
      draftRef.current = {
        ...draftRef.current,
        clientRevision: result.draftVersion || draftRef.current.clientRevision,
        adultCount: result.adultCount,
        youthCount: result.youthCount,
        teamName: result.teamName,
        roomCode: result.roomCode,
        scheduledTime: result.scheduledTime,
        difficultyCode: result.difficultyCode,
      };
      setVisit(result); setTeamName(result.teamName); setAdultCount(result.adultCount); setYouthCount(result.youthCount);
      go("party");
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "예약을 선택하지 못했습니다."); }
    finally { setBusy(false); }
  }

  function saveTeam(selectedTeam = teamName) {
    const normalizedTeam = selectedTeam.trim();
    const validVehicleLast4 = vehicleLast4.length === 0 || vehicleLast4.length === 4;
    setError("");
    if (!validVehicleLast4) {
      setError("차량번호는 뒤 4자리를 모두 입력하거나 비워주세요.");
      return;
    }
    const snapshot = nextDraftSnapshot({ teamName: normalizedTeam, vehicleLast4 });
    setVisit((current) => current ? { ...current, teamName: normalizedTeam } : current);
    goInstant("benefits", "team_transition");
    queueDraftSnapshot(snapshot);
  }

  async function chooseSlot(roomCode: string, time: string) {
    setSelectedRoom(roomCode); setSelectedTime(time); setError(""); setHoldPending(true);
    const generation = flowGenerationRef.current;
    setVisit((current) => current ? { ...current, roomCode, scheduledTime: time, difficultyCode: "", difficultyLabel: "" } : current);
    goInstant("difficulty", "hold_transition");
    try {
      await waitForPartyBarrier();
      const snapshot = nextDraftSnapshot({ roomCode, scheduledTime: time, difficultyCode: "" });
      const sessionToken = await requireSessionToken();
      const result = await request<Visit>({ action: "hold", date: bootstrap?.store.today, time, roomCode, draft: snapshot }, sessionToken, { background: true });
      if (generation !== flowGenerationRef.current) return;
      setVisit(result);
      setHoldPending(false);
    } catch (reason) {
      if (generation !== flowGenerationRef.current) return;
      setHoldPending(false);
      setHistory((current) => current.at(-1) === "room" ? current.slice(0, -1) : current);
      setScreen("room");
      setError(reason instanceof Error ? reason.message : "시간을 선택하지 못했습니다.");
      await loadBootstrap().catch(() => undefined);
    }
  }

  async function chooseDifficulty(code: string) {
    if (holdPending || assignmentAbortRef.current) return;
    setError(""); setSelectedDifficulty(code);
    const difficulty = (bootstrap?.difficulties.A1 ?? []).find((item) => item.code === code)
      ?? Object.values(bootstrap?.difficulties ?? {}).flat().find((item) => item.code === code);
    if (currentFlowType === "RESERVATION" && reservationDifficultyChange) {
      setBusy(true);
      try {
        await waitForPartyBarrier();
        const result = await request<Visit>({ action: "difficulty", difficultyCode: code }, await requireSessionToken());
        setVisit(result);
        setReservationDifficultyChange(false);
        go("identity");
      } catch (reason) { setError(reason instanceof Error ? reason.message : "난이도를 변경하지 못했습니다."); }
      finally { setBusy(false); }
      return;
    }
    if (!selectedRoomSize) {
      setError("방 크기를 먼저 선택해주세요.");
      return;
    }
    const trace = beginKioskLatencyTrace("auto_assign_transition", "DIFFICULTY_CLICK");
    const generation = flowGenerationRef.current;
    const assignmentAttempt = assignmentAttemptRef.current + 1;
    assignmentAttemptRef.current = assignmentAttempt;
    const controller = new AbortController();
    assignmentAbortRef.current = controller;
    setHoldPending(true);
    setAssignmentCanRetry(false);
    if (screenRef.current !== "assigning") goInstant("assigning", "auto_assign_transition", { trace, renderStage: "ASSIGNING_RENDER", generation });
    markKioskLatencyTrace(trace, "ASSIGNING_SCREEN_SET", { screen: "assigning" });
    let partyBarrierPassed = false;
    try {
      await waitForPartyBarrier(trace);
      partyBarrierPassed = true;
      if (generation !== flowGenerationRef.current || assignmentAttempt !== assignmentAttemptRef.current) return;
      const snapshot = nextDraftSnapshot({ difficultyCode: code });
      markKioskLatencyTrace(trace, "AUTO_ASSIGN_START", { appendGame: false, revision: snapshot.clientRevision });
      const result = await request<{ visit: Visit; assigned: { roomCode: string; time: string; difficulty: Difficulty } }>({
        action: "auto_assign", roomSize: selectedRoomSize, difficultyCode: code,
        appendGame: false,
        afterTime: "",
        draft: snapshot,
      }, await requireSessionToken(), { signal: controller.signal, background: true, trace });
      if (generation !== flowGenerationRef.current || assignmentAttempt !== assignmentAttemptRef.current) return;
      markKioskLatencyTrace(trace, "AUTO_ASSIGN_DONE", { roomAssigned: true });
      setVisit(result.visit);
      setSelectedRoom(result.assigned.roomCode);
      setSelectedTime(result.assigned.time);
      setVisit((current) => current ? {
        ...current,
        difficultyCode: result.assigned.difficulty.code,
        difficultyLabel: result.assigned.difficulty.label || difficulty?.label || current.difficultyLabel,
      } : current);
      goInstant("fastest", "auto_assign_transition", { trace, renderStage: "FASTEST_RENDER", generation, replace: true });
      markKioskLatencyTrace(trace, "FASTEST_SCREEN_SET", { screen: "fastest" });
    } catch (reason) {
      if (generation !== flowGenerationRef.current || assignmentAttempt !== assignmentAttemptRef.current || (reason instanceof DOMException && reason.name === "AbortError")) return;
      setAssignmentCanRetry(partyBarrierPassed);
      setError(reason instanceof Error ? reason.message : "가장 빠른 방과 시간을 배정하지 못했습니다.");
    }
    finally {
      if (assignmentAbortRef.current === controller) assignmentAbortRef.current = null;
      if (generation === flowGenerationRef.current && assignmentAttempt === assignmentAttemptRef.current) setHoldPending(false);
    }
  }

  function returnToPartyFromAssignment() {
    assignmentAttemptRef.current += 1;
    assignmentAbortRef.current?.abort();
    assignmentAbortRef.current = null;
    setHoldPending(false);
    setAssignmentCanRetry(false);
    setHistory((current) => {
      const partyIndex = current.lastIndexOf("party");
      return partyIndex >= 0 ? current.slice(0, partyIndex) : current;
    });
    screenRef.current = "party";
    setScreen("party");
    setError("");
  }

  function returnToDifficultyFromAssignment() {
    assignmentAttemptRef.current += 1;
    assignmentAbortRef.current?.abort();
    assignmentAbortRef.current = null;
    setHoldPending(false);
    setAssignmentCanRetry(false);
    setHistory((current) => current.at(-1) === "difficulty" ? current.slice(0, -1) : current);
    screenRef.current = "difficulty";
    setScreen("difficulty");
    setError("");
  }

  const addOns = useMemo(() => {
    const fixed = { slush: 0, beverage: 0, other: 0 };
    const items: Array<{ code: string; quantity: number }> = [];
    for (const [code, quantity] of Object.entries(addOnCounts)) {
      if (code in fixed) fixed[code as keyof typeof fixed] = quantity;
      else items.push({ code, quantity });
    }
    return { ...fixed, items };
  }, [addOnCounts]);

  async function quote(next: Screen) {
    setError(""); setQuotePending(true);
    const generation = flowGenerationRef.current;
    goInstant(next, "quote_transition");
    try {
      await waitForPartyBarrier();
      const snapshot = nextDraftSnapshot({ addOns, passBenefit, couponBenefit });
      const sessionToken = await requireSessionToken();
      const result = await request<{ visit: Visit }>({
        action: "quote", addOns,
        vehicleLast4,
        passId: passBenefit.id, passMemberId: passBenefit.ownerId, passUses: passBenefit.uses,
        couponId: couponBenefit.id, couponMemberId: couponBenefit.ownerId,
        draft: snapshot,
      }, sessionToken, { background: true });
      if (generation !== flowGenerationRef.current) return;
      setVisit(result.visit); setPaymentMode("single"); setPaymentCount(2);
      setPaymentItems([{ amount: result.visit.amounts.final, paymentMethod: firstPaymentMethod(bootstrap?.paymentSettings) }]);
      setPaymentOverview(null); setPaymentMethodOverrides({}); setQuotePending(false);
    } catch (reason) {
      if (generation !== flowGenerationRef.current) return;
      setQuotePending(false);
      setError(reason instanceof Error ? reason.message : "금액을 계산하지 못했습니다.");
    }
  }

  async function quoteParticipantTopUp() {
    setError(""); setQuotePending(true);
    const generation = flowGenerationRef.current;
    goInstant("review", "participant_top_up_quote_transition");
    try {
      const sessionToken = await requireSessionToken();
      const result = await request<{ visit: Visit }>({
        action: "participant_top_up_quote",
        additionalAdultCount,
        additionalYouthCount,
      }, sessionToken, { background: true });
      if (generation !== flowGenerationRef.current) return;
      setVisit(result.visit);
      setPaymentMode("single");
      setPaymentCount(2);
      setPaymentItems([{ amount: result.visit.amounts.final, paymentMethod: firstPaymentMethod(bootstrap?.paymentSettings) }]);
      setPaymentOverview(null);
      setPaymentMethodOverrides({});
      setQuotePending(false);
    } catch (reason) {
      if (generation !== flowGenerationRef.current) return;
      setQuotePending(false);
      setHistory((current) => current.at(-1) === "participant-topup" ? current.slice(0, -1) : current);
      setScreen("participant-topup");
      setError(reason instanceof Error ? reason.message : "추가 결제금액을 계산하지 못했습니다.");
    }
  }

  async function addMember() {
    setBusy(true); setError("");
    try {
      await waitForPartyBarrier();
      const result = await request<{ visit: Visit; member: Member }>({ action: "add_member", phone: extraPhone, password: extraPassword });
      setVisit(result.visit);
      setLinkedMembers((current) => current.some((item) => item.member.id === result.member.member.id) ? current : [...current, result.member]);
      setExtraMemberOpen(false); setExtraPhone(""); setExtraPassword("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "회원을 추가하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function checkout() {
    setBusy(true); setError(""); setAttemptId("");
    setScreen(paymentTotal > 0 ? "payment" : "prepare-guide");
    try {
      await waitForPartyBarrier();
      const result = await request<{ visit: Visit; attempt: { id: string } | null; startToken: string; overview: PaymentOverview; transfer?: TransferGuidance | null }>({ action: "checkout", requestKey: `kiosk-plan:${visit?.id}`, paymentMode, paymentItems });
      setVisit(result.visit);
      setPaymentOverview(result.overview);
      setTransferGuidance(result.transfer ?? null);
      if (result.attempt?.id) { setAttemptId(result.attempt.id); setScreen("payment"); }
      else if (result.visit.status === "COMPLETED") setScreen("done");
      else if (result.visit.status === "WAITING_STAFF_CONFIRMATION") setScreen("staff-payment");
      else if (result.visit.status === "PAYMENT_PENDING") setScreen("payment");
      else setScreen("prepare-guide");
    } catch (reason) { setScreen("review"); setError(reason instanceof Error ? reason.message : "결제를 시작하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function processCurrentPayment(transaction: PaymentPlanItem, paymentMethod: KioskPaymentMethod) {
    setBusy(true); setError("");
    try {
      const requestKey = crypto.randomUUID();
      const result = await request<{ visit: Visit; attempt: { id: string } | null; startToken: string; overview: PaymentOverview; transfer?: TransferGuidance | null }>({
        action: "process_payment", transactionId: transaction.id, paymentMethod, requestKey,
      });
      setVisit(result.visit); setPaymentOverview(result.overview); setTransferGuidance(result.transfer ?? null);
      if (result.attempt?.id) { setAttemptId(result.attempt.id); setScreen("payment"); }
      else if (result.visit.status === "WAITING_STAFF_CONFIRMATION") setScreen("staff-payment");
      else if (result.visit.status === "COMPLETED") setScreen("done");
      else setScreen("payment");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "결제를 시작하지 못했습니다.");
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (screen !== "payment" || !attemptId || !token) return;
    let cancelled = false;
    async function wait() {
      try {
        const response = await fetch(`/api/kiosk/payment/wait?attemptId=${encodeURIComponent(attemptId)}`, { headers: { "x-customer-session": token }, cache: "no-store" });
        const payload = await response.json() as { changed?: boolean; visit?: Visit; startToken?: string; error?: string; overview?: PaymentOverview };
        if (cancelled) return;
        if (!response.ok) throw new Error(payload.error || "결제 결과를 확인하지 못했습니다.");
        if (payload.visit) setVisit(payload.visit);
        if (payload.overview) setPaymentOverview(payload.overview);
        if (payload.visit?.status === "COMPLETED") setScreen("done");
        else if (payload.visit?.status === "PREPARING") setScreen("prepare-guide");
        else if (payload.visit?.status === "WAITING_STAFF_CONFIRMATION") setScreen("staff-payment");
        else if (payload.visit?.status === "STAFF_REVIEW") { setScreen("help"); setError("결제 결과를 직원이 확인하고 있습니다."); }
        else if (!payload.changed) void wait();
        else if (payload.overview?.summary?.hasUnknown) { setScreen("help"); setError("결제 결과를 직원이 확인하고 있습니다."); }
        else { setAttemptId(""); setScreen("payment"); }
      } catch (reason) { if (!cancelled) { setScreen("help"); setError(reason instanceof Error ? reason.message : "결제 결과를 확인하지 못했습니다."); } }
    }
    void wait(); return () => { cancelled = true; };
  }, [attemptId, screen, token]);

  useEffect(() => {
    const shouldPollState = ["staff-payment", "preparing", "ready", "starting"].includes(screen) || (screen === "payment" && !attemptId);
    if (!shouldPollState || !token) return;
    const timer = window.setInterval(async () => {
      if (stateRequestInFlightRef.current || document.hidden) return;
      stateRequestInFlightRef.current = true;
      try {
        const response = await fetch("/api/kiosk?scope=state", { headers: { "x-customer-session": token }, cache: "no-store" });
        const payload = await response.json() as { visit?: Visit; overview?: PaymentOverview | null; transfer?: TransferGuidance | null };
        if (!payload.visit) return;
        setVisit(payload.visit);
        if (payload.overview) setPaymentOverview(payload.overview);
        setTransferGuidance(payload.transfer ?? null);
        if (payload.visit.status === "PREPARING" && screen === "staff-payment") setScreen("prepare-guide");
        if (payload.visit.status === "PAYMENT_PENDING" && screen === "staff-payment") setScreen("payment");
        if (payload.visit.status === "COMPLETED") setScreen("done");
        if (payload.visit.status === "READY_TO_PLAY" && screen !== "staff-payment") setScreen("ready");
        if (payload.visit.status === "PLAYING") setScreen("done");
        if (["START_FAILED", "ERROR", "STAFF_REVIEW"].includes(payload.visit.status)) { setScreen("help"); setError(payload.visit.error?.message || "직원 확인이 필요합니다."); }
      } catch { /* next tick retries */ }
      finally { stateRequestInFlightRef.current = false; }
    }, 1000);
    return () => { window.clearInterval(timer); stateRequestInFlightRef.current = false; };
  }, [attemptId, screen, token]);

  async function startGame() {
    if (startRequestInFlightRef.current) return;
    startRequestInFlightRef.current = true;
    setBusy(true); setError("");
    try {
      if (!visit?.id) throw new Error("시작할 방 정보를 찾지 못했습니다.");
      await request({ action: "start_ready_game", visitId: visit.id }, "");
      setScreen("starting");
    }
    catch (reason) {
      setStartCountdown(null);
      setError(reason instanceof Error ? reason.message : "게임을 시작하지 못했습니다.");
    }
    finally {
      startRequestInFlightRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (screen !== "ready" || startCountdown === null) return;
    if (startCountdown > 0) {
      const timer = window.setTimeout(() => setStartCountdown((value) => value === null ? null : value - 1), 1_000);
      return () => window.clearTimeout(timer);
    }
    void startGame();
  }, [screen, startCountdown]);

  useEffect(() => {
    if (screen !== "starting") return;
    const timer = window.setTimeout(() => void resetHome(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [resetHome, screen]);

  async function openReadyRoom(room: Room) {
    setBusy(true); setError("");
    try {
      if (!devicePaired) throw new Error("직원 메뉴에서 이 기기를 매장 키오스크로 한 번 등록해주세요.");
      if (!room.preparedVisitId || room.preparationState !== "READY_TO_PLAY") throw new Error("아직 게임 시작 준비가 끝나지 않았습니다.");
      const payload = await request<{ visit: Visit }>({ action: "open_ready_room", visitId: room.preparedVisitId }, "");
      setToken(""); sessionStorage.removeItem(SESSION_KEY); setVisit(payload.visit); setStartCountdown(null); setStartChecklistChecks({});
      setHistory((current) => current.length > 0 ? current : ["home"]);
      setScreen("ready");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "준비 상태를 찾지 못했습니다."); }
    finally { setBusy(false); }
  }

  const holdSeconds = visit?.hold ? Math.max(0, Math.ceil((Date.parse(visit.hold.expiresAt) - now) / 1000)) : 0;
  const currentFlowType = visit?.flowType || activeFlowType;
  const participantTopUp = (visit?.settlement?.participantTopUp || {}) as {
    expectedAdultCount?: number; expectedYouthCount?: number;
    additionalAdultCount?: number; additionalYouthCount?: number;
    targetAdultCount?: number; targetYouthCount?: number; amount?: number; firstSplitIndex?: number;
  };
  const addOnTotal = bootstrap?.products.reduce((sum, product) => sum + (addOnCounts[product.code] || 0) * product.price, 0) ?? 0;
  const availablePaymentMethods = enabledPaymentMethods(bootstrap?.paymentSettings);
  const paymentTotal = paymentItems.reduce((sum, item) => sum + Math.max(0, Math.trunc(item.amount || 0)), 0);
  const paymentMatches = paymentItems.length > 0 && availablePaymentMethods.length > 0 && paymentItems.every((item) => item.amount > 0 && availablePaymentMethods.includes(item.paymentMethod)) && paymentTotal === (visit?.amounts.final || 0);
  const paymentTotalsByMethod = paymentItems.reduce<Record<KioskPaymentMethod, number>>((totals, item) => {
    totals[item.paymentMethod] += Math.max(0, Math.trunc(item.amount || 0));
    return totals;
  }, { card: 0, cash: 0, account: 0 });
  const visiblePaymentOverview = paymentOverview && currentFlowType === "PARTY_TOP_UP" && participantTopUp.firstSplitIndex
    ? { ...paymentOverview, plan: paymentOverview.plan.filter((item) => item.splitIndex >= Number(participantTopUp.firstSplitIndex)) }
    : paymentOverview;
  const activePayment = visiblePaymentOverview?.plan.find((item) => !["APPROVED", "COMPLETED"].includes(item.status)) ?? null;
  const splitPaymentActive = (visiblePaymentOverview?.plan.length ?? 0) > 1;
  const activePaymentMethod = activePayment && activePayment.paymentMethod !== "coupon"
    ? paymentMethodOverrides[activePayment.splitIndex]
      ?? (!splitPaymentActive || activePayment.status === "PROCESSING" ? activePayment.paymentMethod : null)
    : null;
  const stampBreakdown = (visit?.settlement?.stampBreakdown || {}) as { total?: number; paid?: number; pass?: number; coupon?: number };
  const afterPaymentGuidance = (bootstrap?.guidance ?? []).filter((item) => item.placement === "AFTER_PAYMENT" && item.active);
  const requiredGuidance = (bootstrap?.guidance ?? []).filter((item) => item.placement === "REQUIRED_AGREEMENT" && item.active);
  const beforeStartGuidance = (bootstrap?.guidance ?? []).filter((item) => item.placement === "BEFORE_GAME_START" && item.active);
  const afterGameGuidance = (bootstrap?.guidance ?? []).filter((item) => item.placement === "AFTER_GAME" && item.active);
  const selectedGames = visit?.games ?? [];
  const latestSelectedGame = selectedGames.at(-1);
  const savedTeamName = (member?.member.teamName || (currentFlowType === "RESERVATION" ? visit?.teamName : "") || "").trim();
  const difficultyChoices = (bootstrap?.difficulties.A1 ?? [])
    .filter((item) => Object.prototype.hasOwnProperty.call(difficultyStars, item.code))
    .sort((left, right) => Object.keys(difficultyStars).indexOf(left.code) - Object.keys(difficultyStars).indexOf(right.code));
  const currentTimeLabel = now ? new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now)) : "--:--";
  const liveRooms = useMemo(() => (bootstrap?.rooms ?? []).map((room) => {
    const live = roomStatus.find((item) => item.code === room.code);
    const status = live?.status ?? room.status;
    const remainingSeconds = status === "running" && live?.endsAt
      ? Math.max(0, Math.ceil((Date.parse(live.endsAt) - now) / 1_000))
      : status === "running" ? Math.max(0, room.remainingSeconds) : 0;
    const today = bootstrap?.store.today;
    const slots = today ? room.slots.filter((time) => kioskSlotStartsAfterRunningGame({
      roomStatus: status,
      slotStartAt: Date.parse(`${today}T${time}:00+09:00`),
      nowAt: now,
      remainingSeconds,
      endsAt: live?.endsAt,
    })) : room.slots;
    return { ...room, ...(live ?? {}), status, remainingSeconds, slots };
  }), [bootstrap?.rooms, bootstrap?.store.today, now, roomStatus]);
  const readyRooms = liveRooms.filter((room) => room.preparationState === "READY_TO_PLAY" && Boolean(room.preparedVisitId));
  const startChecklistItems = [
    ...beforeStartGuidance.map((item) => ({ id: `guidance:${item.id}`, content: item.content || item.summary || item.title })),
    { id: "visit:party", content: `입장 인원 ${visit?.partyCount || adultCount + youthCount}명을 확인했어요` },
    { id: "visit:difficulty", content: `${visit?.difficultyLabel || "선택한"} 난이도를 확인했어요` },
  ];
  const allStartChecksDone = startChecklistItems.every((item) => Boolean(startChecklistChecks[item.id]));

  function openGameStartFlow() {
    setError("");
    if (!devicePaired) {
      setError("직원 메뉴에서 이 기기를 매장 키오스크로 한 번 등록해주세요.");
      return;
    }
    if (readyRooms.length === 0) {
      setError("현재 시작할 수 있는 게임이 없어요.");
      return;
    }
    if (readyRooms.length === 1) {
      void openReadyRoom(readyRooms[0]);
      return;
    }
    go("ready-select");
  }

  const requiredConsentItems = requiredGuidance.filter((item) => item.required);
  const guidanceAgreementText = requiredConsentItems.find((item) => item.agreementText.trim())?.agreementText
    || "필수 이용안내를 모두 확인했고 동의합니다.";
  const guidanceAccepted = requiredConsentItems.every((item) => Boolean(guidanceChecks[item.id]));
  const reservationSearchReady = ["PARTY_TOP_UP", "REPEAT_GAME"].includes(currentFlowType)
    ? Boolean(reservationTeamQuery.trim())
    : loginPhone.replace(/\D/g, "").length >= 10;
  const paymentPlan = visiblePaymentOverview?.plan ?? [];
  const paymentHasUnknown = Boolean(visiblePaymentOverview?.summary?.hasUnknown || paymentPlan.some((item) => item.status === "UNKNOWN"));
  const paymentHasCompleted = Boolean((visiblePaymentOverview?.summary?.approvedAmount || 0) > 0 || paymentPlan.some((item) => ["APPROVED", "COMPLETED"].includes(item.status)));
  const paymentIsProcessing = Boolean(attemptId || busy || paymentPlan.some((item) => ["PROCESSING", "BUSY"].includes(item.status)));
  const paymentCanCancelBeforeExecution = screen === "payment"
    && !["PARTY_TOP_UP", "RESERVATION"].includes(currentFlowType)
    && visit?.status === "PAYMENT_PENDING"
    && (visit?.amounts.discount || 0) === 0
    && paymentPlan.length > 0
    && paymentPlan.every((item) => item.status === "PENDING")
    && !paymentHasUnknown
    && !paymentHasCompleted
    && !paymentIsProcessing;
  const paymentCancelBlockedReason = paymentIsProcessing
    ? "결제 결과가 확정될 때까지 취소하거나 처음으로 이동할 수 없어요."
    : paymentHasUnknown
      ? "결제 결과를 확인하고 있어요. 중복 결제 방지를 위해 직원 확인이 필요해요."
      : paymentHasCompleted
        ? "이미 완료된 결제가 있어요. 취소하려면 직원을 호출해주세요."
        : currentFlowType === "PARTY_TOP_UP"
          ? "기존 게임에 연결된 추가 결제는 직원 확인 후 취소할 수 있어요."
          : currentFlowType === "RESERVATION"
            ? "네이버 예약에 연결된 결제는 예약 보호를 위해 직원 확인 후 취소할 수 있어요."
            : (visit?.amounts.discount || 0) > 0
              ? "다회권이나 쿠폰이 적용된 결제는 혜택 보호를 위해 직원 확인 후 취소할 수 있어요."
          : "현재 결제 상태는 직원 확인이 필요해요.";
  const bottomNavHidden = ["home", "parking-active"].includes(screen);
  let bottomNext: { label: string; disabled: boolean; action: () => void } | null = null;
  if (screen === "party") bottomNext = {
    label: currentFlowType === "RESERVATION" ? "예약 정보 확인" : "난이도 선택",
    disabled: busy || adultCount + youthCount < 1 || adultCount + youthCount > 10 || (currentFlowType === "WALK_IN" && !selectedRoomSize),
    action: () => void saveParty(),
  };
  else if (screen === "difficulty") bottomNext = { label: reservationDifficultyChange ? "이 난이도로 변경" : "가장 빠른 시간 찾기", disabled: busy || holdPending || !selectedDifficulty, action: () => void chooseDifficulty(selectedDifficulty) };
  else if (screen === "fastest") bottomNext = { label: currentFlowType === "REPEAT_GAME" ? "이 게임 추가 결제" : "계속", disabled: busy || !visit?.hold, action: () => go(currentFlowType === "REPEAT_GAME" ? "benefits" : "identity") };
  else if (screen === "reservation-confirm") bottomNext = { label: "예약 정보 그대로 진행", disabled: busy, action: () => go("identity") };
  else if (screen === "login") bottomNext = { label: busy ? "확인 중" : "로그인", disabled: busy || !loginPhone || !loginPassword, action: () => void login() };
  else if (screen === "signup") bottomNext = { label: "동의하고 가입", disabled: busy || !signup.name || !signup.phone || !signup.password || !signup.agreed, action: () => void register() };
  else if (screen === "reservation-search") bottomNext = { label: busy ? "찾는 중" : currentFlowType === "PARTY_TOP_UP" ? "추가 결제할 게임 찾기" : currentFlowType === "REPEAT_GAME" ? "한 게임 더 할 팀 찾기" : "오늘 예약 찾기", disabled: busy || !reservationSearchReady, action: () => void searchReservation() };
  else if (screen === "participant-topup") bottomNext = { label: "추가 결제금액 확인", disabled: busy || quotePending || additionalAdultCount + additionalYouthCount < 1 || adultCount + youthCount + additionalAdultCount + additionalYouthCount > 10, action: () => void quoteParticipantTopUp() };
  else if (screen === "team") bottomNext = { label: "계속", disabled: busy || (vehicleLast4.length !== 0 && vehicleLast4.length !== 4), action: () => saveTeam(currentFlowType === "RESERVATION" ? visit?.teamName || teamName : teamName) };
  else if (screen === "benefits") bottomNext = { label: "필수 안내 확인", disabled: busy, action: () => { setGuidanceChecks({}); setGuidanceRefreshState("loading"); go("guide"); } };
  else if (screen === "guide") bottomNext = { label: guidanceRefreshState === "loading" ? "필수 안내 확인 중" : guidanceRefreshState === "error" ? "안내 새로고침 필요" : busy ? "동의 저장 중" : "동의하고 결제 확인", disabled: busy || guidanceRefreshState !== "ready" || !guidanceAccepted, action: () => void acceptGuidance() };
  else if (screen === "addons") bottomNext = { label: "결제 금액 확인", disabled: busy || quotePending || addOnTotal < 1, action: () => void quote("review") };
  else if (screen === "review") bottomNext = { label: quotePending ? "결제금액 확인 중" : (visit?.amounts.final || 0) > 0 ? `${money(visit?.amounts.final || 0)} 결제 진행` : "혜택 적용 완료", disabled: busy || quotePending || !paymentMatches, action: () => void checkout() };

  const navigationBackDisabled = holdPending
    || history.length === 0
    || ["payment", "staff-payment", "prepare-guide", "preparing", "ready", "starting", "done", "help"].includes(screen);
  const visitNavigationLocked = ["PAYMENT_PENDING", "WAITING_STAFF_CONFIRMATION", "STAFF_REVIEW", "PREPARING", "READY_TO_PLAY", "PLAYING"].includes(visit?.status || "");
  const navigationHomeDisabled = (screen === "ready" && busy)
    || (screen === "payment" && !paymentCanCancelBeforeExecution)
    || ["staff-payment", "starting"].includes(screen)
    || (screen === "assigning" && holdPending)
    || (screen === "help" && visitNavigationLocked);

  const requestHomeNavigation = () => {
    if (navigationHomeDisabled) return;
    if (["prepare-guide", "preparing", "ready-select", "ready", "done"].includes(screen)) {
      void resetHome(false);
      return;
    }
    setCancelDialogMode(screen === "payment" ? "payment" : "progress");
  };

  const confirmCancellationAndHome = async () => {
    if (!cancelDialogMode || cancelBusy) return;
    setCancelBusy(true);
    setError("");
    try {
      if (cancelDialogMode === "payment") {
        if (!paymentCanCancelBeforeExecution) throw new Error(paymentCancelBlockedReason);
        const currentToken = tokenRef.current || token;
        if (!currentToken) throw new Error("진행 중인 결제 정보를 찾지 못했습니다.");
        await request({ action: "cancel_checkout" }, currentToken);
        clearLocalHome();
      } else {
        const reset = await resetHome(true);
        if (!reset) return;
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "진행 중인 내용을 취소하지 못했습니다. 직원에게 알려주세요.");
    } finally {
      setCancelBusy(false);
    }
  };

  const startStaffMenuPress = () => {
    if (staffMenuTimerRef.current !== null) window.clearTimeout(staffMenuTimerRef.current);
    staffMenuTimerRef.current = window.setTimeout(() => {
      staffMenuTimerRef.current = null;
      window.location.assign("/admin/kiosk");
    }, 1_800);
  };
  const cancelStaffMenuPress = () => {
    if (staffMenuTimerRef.current !== null) window.clearTimeout(staffMenuTimerRef.current);
    staffMenuTimerRef.current = null;
  };
  return <main ref={touchFeedbackRoot} className={`kiosk-shell touch-feedback-scope ${bottomNavHidden ? "" : "has-bottom-nav"}`.trim()}>
    <header className="kiosk-header"><button className="kiosk-logo kiosk-brand-lockup" onPointerDown={startStaffMenuPress} onPointerUp={cancelStaffMenuPress} onPointerCancel={cancelStaffMenuPress} onPointerLeave={cancelStaffMenuPress} aria-label="점핑배틀"><img className="kiosk-brand-symbol" src="/jb-icon.png" alt="" /><img className="kiosk-brand-wordmark" src="/jb-logo-en.png" alt="JUMPING BATTLE" /><span className="kiosk-store-name">점핑배틀 화성병점점</span></button><div className="kiosk-mode"><span /> SELF SERVICE KIOSK</div><div className="kiosk-header-actions"><span className="kiosk-clock">오늘 {currentTimeLabel}</span>{draftSyncState === "retrying" ? <span className="hold-chip">입력 내용을 저장하고 있어요</span> : null}{visit?.hold && holdSeconds > 0 ? <span className="hold-chip">선택 시간 {mmss(holdSeconds)}</span> : null}</div></header>
    <section className="kiosk-stage">
      {error ? <div className="kiosk-error"><Icon>!</Icon><span>{error}</span></div> : null}

      {screen === "home" ? <div className={`home-screen home-operating ${bootstrap?.parking.enabled ? "parking-enabled" : ""}`}>
        <header className="home-copy"><p>SELF SERVICE KIOSK</p><h1>{bootstrap?.displaySettings.homeTitle || "오늘도 신나게 뛰어볼까요?"}</h1><span>{bootstrap?.displaySettings.homeSubtitle || "예약 확인 또는 현장 이용을 선택해주세요."}</span></header>
        <div className="home-primary-grid">
          <button className="home-card reservation" disabled={busy} onClick={() => void begin("RESERVATION")}><Icon><KioskLineIcon name="reservation" /></Icon><div><span>네이버 예약 고객</span><b>예약하고 왔어요</b><strong>예약을 확인하고 바로 시작할게요 <i>→</i></strong></div></button>
          <button className="home-card walkin" disabled={busy} onClick={() => void begin("WALK_IN")}><Icon><KioskLineIcon name="walkin" /></Icon><div><span>현장 방문 고객</span><b>현장에서 이용해요</b><strong>가장 빠른 방을 찾아드릴게요 <i>→</i></strong></div></button>
        </div>
        <div className="home-secondary-grid">
          <button className="home-card repeat-game" disabled={busy} onClick={() => void begin("REPEAT_GAME")}><Icon><KioskLineIcon name="repeat" /></Icon><div><b>한 게임 더 이용</b><span>방금 게임을 빠르게 다시 이용해요</span></div><i>→</i></button>
          <button className="home-card participant-topup" disabled={busy} onClick={() => void begin("PARTY_TOP_UP")}><Icon><KioskLineIcon name="topup" /></Icon><div><b>게임 인원 추가 결제</b><span>추가된 인원만 결제해요</span></div><i>→</i></button>
          <button className="home-card addon" disabled={busy} onClick={() => void begin("ADD_ON_ONLY")}><Icon><KioskLineIcon name="addon" /></Icon><div><b>부가상품 구매</b><span>음료·양말 등을 구매해요</span></div><i>→</i></button>
          <button className="home-card parking" disabled={busy} onClick={() => { setParkingNotice(""); go("parking-intro"); }}><Icon><KioskLineIcon name="parking" /></Icon><div><b>주차등록</b><span>차량 주차할인을 등록해요</span></div><i>→</i></button>
        </div>
        {parkingNotice ? <div className="parking-home-notice" role="status">{parkingNotice}</div> : null}
        <RoomStrip rooms={liveRooms} updatedAt={roomStatusUpdatedAt} delayed={roomStatusDelayed} />
        <button type="button" className="home-game-start-cta" disabled={busy} onClick={openGameStartFlow}>
          <Icon>▶</Icon><span><b>게임 시작</b><small>준비가 끝났다면 눌러주세요</small></span><i>→</i>
        </button>
      </div> : null}

      {screen === "parking-intro" ? <Step eyebrow="PARKING DISCOUNT" title="주차등록" description="차량번호를 조회한 뒤 주차 할인을 적용해주세요."><div className="parking-intro-guide"><Icon>Ⓟ</Icon><div><b>주차등록 창은 설정된 이용시간이 지나면 자동으로 닫힙니다.</b><span>등록을 먼저 마쳤다면 창을 닫아주세요. 운영자 로그인 화면이 보이거나 등록이 되지 않으면 입력하지 말고 직원을 호출해주세요.</span></div></div><Primary disabled={busy} onClick={startParkingRegistration}>주차등록 시작</Primary><button className="parking-cancel" onClick={() => setScreen("home")}>취소</button></Step> : null}

      {screen === "parking-active" ? <StatusScreen icon="Ⓟ" eyebrow="PARKING REGISTRATION" title="주차등록 전용창이 열렸어요" description="전용창에서 차량번호를 조회하고 할인을 적용해주세요."><div className={`parking-session-status ${parkingWarning ? "warning" : ""}`} role="status"><b>{parkingWarning ? "잠시 후 주차등록 화면이 자동으로 종료됩니다." : `최대 이용시간은 ${bootstrap?.parking.sessionMaxSeconds || 30}초입니다.`}</b><span>등록 완료 여부는 자동으로 확인하지 않습니다. 먼저 마쳤다면 창을 닫거나 아래 버튼으로 돌아와주세요.</span></div><button className="parking-refocus" onClick={() => parkingPopupRef.current?.focus()}>주차등록 창 다시 보기</button><button className="secondary-home" onClick={() => finishParking("completed")}>주차등록 창 닫기 · 점핑배틀로 돌아가기</button></StatusScreen> : null}

      {screen === "parking-error" ? <StatusScreen icon="!" eyebrow="PARKING HELP" title="주차등록을 처리할 수 없어요" description={error || "직원에게 차량번호를 말씀해주세요."}><button className="call-staff" onClick={() => void callStaff()}>직원 호출</button><button className="secondary-home" onClick={() => void resetHome(false)}>홈으로</button><small>기존 직원 수동 주차등록은 그대로 이용할 수 있어요.</small></StatusScreen> : null}

      {screen === "party" ? <Step wide className="people-room-step" eyebrow={currentFlowType === "RESERVATION" ? "NAVER · 인원 확인" : "WALK-IN · 인원과 방 크기"} title={currentFlowType === "RESERVATION" ? "이용 인원을 확인해주세요" : "인원과 방 크기를 선택해주세요"} description={currentFlowType === "RESERVATION" ? `${visit?.scheduledTime || "오늘"} · ${visit?.roomCode || "예약 방"}의 실제 이용 인원을 알려주세요.` : "인원에 맞는 추천 방을 확인하고 원하는 크기를 바로 선택할 수 있어요."}><div className={`people-room-layout ${currentFlowType === "RESERVATION" ? "reservation-only" : ""}`.trim()}><section className="people-count-panel"><h3>이용 인원</h3><Counter label="성인" description="1인 7,000원" value={adultCount} onChange={setAdultCount} /><Counter label="청소년·어린이" description="1인 5,000원" value={youthCount} onChange={setYouthCount} /><div className="selection-total"><span>총 이용 인원</span><b>{adultCount + youthCount}명</b></div></section>{currentFlowType === "WALK_IN" ? <section className="room-size-compact-panel"><header><h3>방 크기</h3><span>추가요금 없음</span></header><div className="room-size-compact-grid">{(["SMALL", "MEDIUM", "LARGE"] as KioskRoomSize[]).map((size) => { const meta = roomSizeMeta[size]; const recommended = roomRecommendation?.primarySize === size; const secondary = roomRecommendation?.secondarySize === size; return <button type="button" aria-pressed={selectedRoomSize === size} className={`${selectedRoomSize === size ? "selected" : ""} ${recommended ? "recommended" : secondary ? "secondary-recommended" : ""}`.trim()} key={size} onClick={() => { setSelectedRoomSize(size); setSelectedDifficulty(""); }}><span>{recommended ? "가장 추천" : secondary ? "추천" : "선택 가능"}</span><b>{meta.label}</b><i className={`room-size-visual ${size.toLowerCase()}`} aria-hidden="true"><span /></i><strong>{meta.ratio}</strong><small>{meta.recommended}</small><em>{selectedRoomSize === size ? "✓ 선택됨" : "선택"}</em></button>; })}</div><p>실제 방 번호와 시간은 난이도를 고른 뒤 가장 빠른 자리로 자동 배정해요.</p></section> : null}</div><div className="people-bottom-summary"><div><span>{adultCount + youthCount}명 기준 게임비</span><b>{money(adultCount * 7000 + youthCount * 5000)}</b>{currentFlowType === "RESERVATION" ? <small>결제 단계에서 네이버 예약금이 차감됩니다.</small> : <small>{selectedRoomSize ? `${roomSizeMeta[selectedRoomSize].label} 선택` : "방 크기를 선택해주세요."}</small>}</div></div></Step> : null}

      {screen === "guide" ? <Step className="guidance-inline-step" eyebrow="REQUIRED GUIDE" title="결제 전에 꼭 확인해주세요" description="안전한 이용을 위한 필수 안내입니다. 내용을 모두 확인한 뒤 동의해주세요.">
        {guidanceRefreshState === "loading" ? <div className="kiosk-inline-pending" role="status">최신 필수 안내를 불러오고 있어요.</div> : null}
        {guidanceRefreshState === "error" ? <div className="kiosk-inline-pending" role="alert">필수 안내를 불러오지 못했습니다. 이전 화면으로 돌아갔다가 다시 시도해주세요.</div> : null}
        {guidanceRefreshState === "ready" && requiredGuidance.length > 0 ? <div className="required-guidance-list guidance-inline-list">
          {requiredGuidance.map((item, index) => <article key={`${item.id}:${item.version}`}>
            <div>
              <span>{item.required ? `필수 안내 ${index + 1}` : `이용 안내 ${index + 1}`}</span>
              <b>{item.title || "안전 이용 안내"}</b>
              {item.summary.trim() && item.summary.trim() !== item.content.trim() ? <p className="guidance-inline-summary">{item.summary}</p> : null}
              <div className="guidance-inline-content"><small>상세 안내</small><p>{item.content || item.summary || "등록된 상세 안내가 없습니다."}</p></div>
            </div>
          </article>)}
          {requiredConsentItems.length > 0 ? <label className="guidance-inline-consent"><input type="checkbox" disabled={guidanceRefreshState !== "ready"} checked={guidanceAccepted} onChange={(event) => setGuidanceChecks(Object.fromEntries(requiredGuidance.map((item) => [item.id, item.required ? event.target.checked : Boolean(guidanceChecks[item.id])])))} /><span>{guidanceAgreementText}</span></label> : null}
        </div> : null}
        {guidanceRefreshState === "ready" && requiredGuidance.length === 0 ? <div className="kiosk-inline-pending" role="status">현재 확인할 필수 안내가 없습니다.</div> : null}
      </Step> : null}

      {screen === "fastest" ? <div className="centered-flow fastest-match-screen"><p className="step-eyebrow">FASTEST AVAILABLE</p><h2>가장 빠른 시간을 찾았어요.</h2><p>선택한 조건으로 바로 이용 가능한 실제 방과 시간이에요.</p><div className="condition-chips"><span>성인 {latestSelectedGame?.adultCount ?? adultCount} · 아이 {latestSelectedGame?.youthCount ?? youthCount}</span><span>{roomSizeMeta[latestSelectedGame?.roomSize || selectedRoomSize || "SMALL"].label}</span><span>{latestSelectedGame?.difficultyLabel || visit?.difficultyLabel} <StarRating value={difficultyStars[(latestSelectedGame?.difficultyCode || selectedDifficulty).replace(/^b1-medium-/, "")] || 1} /></span></div><article className="fastest-ticket"><span>가장 빠른 입장</span><strong>{latestSelectedGame?.scheduledTime || selectedTime}</strong><b>{roomSizeMeta[latestSelectedGame?.roomSize || selectedRoomSize || "SMALL"].label} · {latestSelectedGame?.difficultyLabel || visit?.difficultyLabel}</b><small>배정 방 <em>{latestSelectedGame?.roomCode || selectedRoom}</em> · 결제를 마칠 때까지 선택 시간을 잠시 확보했어요.</small></article></div> : null}

      {screen === "reservation-confirm" ? <Step eyebrow="RESERVATION CHECK" title="예약 정보를 확인해주세요" description="네이버 예약의 방과 시간은 그대로 유지하고 난이도만 필요할 때 변경해요."><div className="game-confirm-card reservation"><span>오늘 예약</span><strong>{visit?.scheduledTime}</strong><h3>{visit?.roomCode}</h3><p>{visit?.teamName || "팀명 없음"} · {visit?.difficultyLabel || "난이도 확인 필요"}</p><small>성인 {adultCount}명 · 청소년·어린이 {youthCount}명</small></div><div className="reservation-confirm-actions"><button onClick={() => { setReservationDifficultyChange(true); go("difficulty"); }}>난이도만 변경</button></div></Step> : null}

      {screen === "identity" ? <Step wide eyebrow="MEMBER BENEFIT" title="회원 혜택을 확인할까요?" description="회원은 다회권·무료 이용권·스탬프를 바로 적용할 수 있어요."><div className="identity-split"><section><span>회원</span><h3>혜택을 이어서 사용해요</h3><button onClick={() => go("login")}><Icon>◎</Icon><div><b>회원 로그인</b><small>휴대폰 번호와 비밀번호로 확인</small></div><i>→</i></button><button onClick={() => go("signup")}><Icon>＋</Icon><div><b>간단 회원가입</b><small>기존 회원 정보도 같은 번호로 연결</small></div><i>→</i></button></section><section className="guest"><span>비회원</span><h3>가입 없이 바로 이용해요</h3><button onClick={() => void asGuest()}><Icon>↗</Icon><div><b>비회원으로 계속</b><small>회원 혜택 없이 일반 결제로 진행</small></div><i>→</i></button></section></div></Step> : null}

      {screen === "login" ? <Step eyebrow="MEMBER LOGIN" title="회원 정보를 입력해주세요" description="공용 키오스크에는 로그인 정보가 저장되지 않아요."><Field label="휴대폰 번호"><KioskInput label="휴대폰 번호" kind="numeric" maxLength={11} enterKeyHint="next" value={loginPhone} onValueChange={(value) => setLoginPhone(value.replace(/\D/g, "").slice(0, 11))} formatter={formatKoreanPhone} placeholder="010-1234-5678" /></Field><Field label="비밀번호"><KioskInput label="비밀번호" kind="english" secure enterKeyHint="done" value={loginPassword} onValueChange={setLoginPassword} placeholder="비밀번호" /></Field></Step> : null}

      {screen === "signup" ? <Step eyebrow="QUICK SIGN UP" title="회원가입은 간단하게" description="가입 즉시 기존 다회권과 쿠폰을 확인할 수 있어요."><div className="form-grid"><Field label="이름"><KioskInput label="이름" kind="korean" allowDigits={false} maxLength={40} enterKeyHint="next" value={signup.name} onValueChange={(value) => setSignup((current) => ({ ...current, name: value }))} /></Field><Field label="휴대폰 번호"><KioskInput label="휴대폰 번호" kind="numeric" maxLength={11} enterKeyHint="next" value={signup.phone} onValueChange={(value) => setSignup((current) => ({ ...current, phone: value.replace(/\D/g, "").slice(0, 11) }))} formatter={formatKoreanPhone} placeholder="010-1234-5678" /></Field><Field label="비밀번호"><KioskInput label="비밀번호" kind="english" secure enterKeyHint="next" value={signup.password} onValueChange={(value) => setSignup((current) => ({ ...current, password: value }))} /></Field><Field label="비밀번호 확인"><KioskInput label="비밀번호 확인" kind="english" secure enterKeyHint="next" value={signup.confirm} onValueChange={(value) => setSignup((current) => ({ ...current, confirm: value }))} /></Field><Field label="팀명 (선택)"><KioskInput label="팀명 (선택)" kind="korean" maxLength={10} enterKeyHint="done" value={signup.teamName} onValueChange={(value) => setSignup((current) => ({ ...current, teamName: value }))} placeholder="입력하지 않아도 괜찮아요" /></Field></div><label className="agree"><input type="checkbox" checked={signup.agreed} onChange={(e) => setSignup((v) => ({ ...v, agreed: e.target.checked }))} /><span>서비스 이용약관 및 개인정보 수집·이용에 동의합니다.</span></label></Step> : null}

      {screen === "reservation-search" ? <Step eyebrow={currentFlowType === "REPEAT_GAME" ? "ONE MORE GAME" : "TODAY RESERVATION"} title={currentFlowType === "PARTY_TOP_UP" ? "인원을 추가할 게임을 찾아볼게요" : currentFlowType === "REPEAT_GAME" ? "방금 게임한 팀을 찾아볼게요" : "예약을 찾아볼게요"} description={currentFlowType === "PARTY_TOP_UP" ? "기존 게임에서 사용한 팀명을 입력해주세요." : currentFlowType === "REPEAT_GAME" ? "완료 후 15분 이내의 팀명으로 다음 게임을 빠르게 이어갈 수 있어요." : "네이버 예약에 입력한 휴대폰 번호를 입력해주세요."}>{["PARTY_TOP_UP", "REPEAT_GAME"].includes(currentFlowType) ? <Field label="팀명"><KioskInput label="팀명" kind="korean" maxLength={10} enterKeyHint="search" value={reservationTeamQuery} onValueChange={(value) => setReservationTeamQuery(value.slice(0, 10))} placeholder="예: 점핑히어로" /></Field> : <Field label="예약자 휴대폰 번호"><KioskInput label="예약자 휴대폰 번호" kind="numeric" maxLength={11} enterKeyHint="search" value={loginPhone} onValueChange={(value) => setLoginPhone(value.replace(/\D/g, "").slice(0, 11))} formatter={formatKoreanPhone} placeholder="010-1234-5678" /></Field>}</Step> : null}

      {screen === "reservation-results" ? <Step eyebrow={currentFlowType === "REPEAT_GAME" ? "LAST GAME FOUND" : "RESERVATION FOUND"} title={currentFlowType === "PARTY_TOP_UP" ? "인원을 추가할 게임이 맞나요?" : currentFlowType === "REPEAT_GAME" ? "방금 이용한 팀이 맞나요?" : "이 예약이 맞나요?"} description={currentFlowType === "PARTY_TOP_UP" ? "이미 결제가 끝난 게임만 표시됩니다. 인원을 추가할 게임을 선택해주세요." : currentFlowType === "REPEAT_GAME" ? "직전 인원과 팀명을 이어받고 새 게임의 혜택과 금액만 다시 계산해요." : "본인 예약을 선택하면 결제와 게임 준비를 이어서 도와드려요."}><div className="reservation-list">{reservations.map((item) => <button key={item.id} disabled={busy} onClick={() => void chooseReservation(item.id)}><time>{item.time}</time><div><b>{item.teamName || item.customerName}</b><span>{item.roomCode} · {item.totalCount > 0 ? `${item.totalCount}명` : "인원 확인 필요"} · {item.difficultyLabel}</span><small>{currentFlowType === "REPEAT_GAME" ? "정상 완료한 게임" : item.source === "naver" ? "네이버 예약" : "온라인 예약"}</small></div><strong>{currentFlowType === "PARTY_TOP_UP" || currentFlowType === "REPEAT_GAME" ? "선택" : item.amount > 0 ? money(item.amount) : "현장 확인"}</strong></button>)}</div></Step> : null}

      {screen === "participant-topup" ? <Step eyebrow="PARTICIPANT TOP-UP" title="추가로 이용할 인원을 선택해주세요" description="추가 인원은 정상 게임비로 결제되며 기존 게임 시간은 늘어나지 않아요."><div className="participant-topup-current"><span>현재 결제된 인원</span><b>성인 {adultCount}명 · 청소년 {youthCount}명</b><small>{visit?.scheduledTime} · {visit?.roomCode} · {visit?.teamName || "팀명 없음"}</small></div><Counter label="추가 성인" description="1인 7,000원" value={additionalAdultCount} onChange={(value) => setAdditionalAdultCount(Math.min(value, Math.max(0, 10 - adultCount - youthCount - additionalYouthCount)))} /><Counter label="추가 청소년·어린이" description="1인 5,000원" value={additionalYouthCount} onChange={(value) => setAdditionalYouthCount(Math.min(value, Math.max(0, 10 - adultCount - youthCount - additionalAdultCount)))} /><div className="selection-total"><span>추가 후 총 이용 인원</span><b>{adultCount + youthCount + additionalAdultCount + additionalYouthCount}명</b></div></Step> : null}

      {screen === "team" ? <Step eyebrow="TEAM & PARKING" title="팀명과 차량번호를 확인해주세요" description="팀명과 차량번호는 선택사항이에요. 차량번호는 주차등록에 다시 사용할 수 있어요."><div className="team-vehicle-form">{currentFlowType === "RESERVATION" ? <div className="team-readonly"><span>네이버 예약 팀명</span><b>{visit?.teamName || "팀명 없음"}</b><small>예약에 등록된 팀명을 그대로 사용해요.</small></div> : savedTeamName && !teamEditing ? <div className="saved-team-panel"><span>저장된 팀명</span><div><b>{savedTeamName}</b><small>이 팀명을 그대로 사용할게요.</small></div><button className="team-edit-toggle" onClick={() => { setTeamName(savedTeamName); setTeamEditing(true); }}>다른 팀명 입력</button></div> : <><Field label="팀명 (선택)"><KioskInput label="팀명 (선택)" kind="korean" maxLength={10} enterKeyHint="next" value={teamName} onValueChange={(value) => setTeamName(value.slice(0, 10))} placeholder="입력하지 않아도 괜찮아요" /></Field><div className="char-count">{teamName.length}/10</div></>}<Field label="차량번호 뒤 4자리 (선택)"><KioskInput label="차량번호 뒤 4자리 (선택)" kind="numeric" maxLength={4} enterKeyHint="done" value={vehicleLast4} onValueChange={(value) => setVehicleLast4(value.replace(/\D/g, "").slice(0, 4))} placeholder="예: 1234" /></Field><small className="team-vehicle-note">입력하지 않아도 예약과 결제를 계속할 수 있어요.</small></div></Step> : null}

      {screen === "room" ? <Step wide eyebrow="ROOM & TIME" title="방과 시간을 한 번에 골라주세요" description="예약 가능한 시간만 선택할 수 있으며, 선택한 자리는 3분 동안 안전하게 보관돼요."><RoomTimeTable rooms={liveRooms} partyCount={visit?.partyCount || adultCount + youthCount} busy={busy || holdPending} onChoose={(roomCode, time) => void chooseSlot(roomCode, time)} /></Step> : null}

      {screen === "difficulty" ? <Step wide className="difficulty-selection-step" eyebrow="MAP & DIFFICULTY" title="난이도를 선택해주세요." description={reservationDifficultyChange ? "예약 시간과 방은 그대로 두고 난이도만 변경합니다." : "모든 난이도를 한눈에 비교해보세요. 별이 많을수록 어려워요."}>{holdPending ? <div className="kiosk-inline-pending" role="status">가장 빠른 방과 시간을 찾고 있어요</div> : null}<div className="difficulty-sections">{difficultyGroups.map((group, groupIndex) => { const choices = difficultyChoices.filter((item) => group.codes.some((code) => code === item.code)); if (!choices.length) return null; return <section className={`difficulty-section difficulty-section-${group.key}`} key={group.key}><header><div><i>{String(groupIndex + 1).padStart(2, "0")}</i><span><strong>{group.label}</strong><small>{group.description}</small></span></div><span className="difficulty-range"><small>별점 범위</small><StarRating value={group.minStars} /><i>~</i><StarRating value={group.maxStars} /></span></header><div className="difficulty-choice-grid">{choices.map((item) => { const stars = difficultyStars[item.code] || 1; const meta = difficultyDisplayMeta[item.code] || { english: item.code, stages: "15분", description: item.description }; return <button aria-pressed={selectedDifficulty === item.code} className={`difficulty-choice-card ${selectedDifficulty === item.code ? "selected" : ""}`} key={item.code} disabled={busy || holdPending} onClick={() => setSelectedDifficulty(item.code)}><span className="difficulty-choice-badge">{group.label}</span><div className="difficulty-title"><b>{item.label}</b><em>{meta.english}</em></div><StarRating value={stars} /><strong>{meta.stages}</strong><small>{meta.description}</small><i>{selectedDifficulty === item.code ? "✓ 선택됨" : "선택"}</i></button>; })}</div></section>; })}</div><div className="difficulty-selection-summary"><div><span>선택한 난이도</span><b>{difficultyChoices.find((item) => item.code === selectedDifficulty)?.label || "난이도를 선택해주세요"}</b>{selectedDifficulty ? <StarRating value={difficultyStars[selectedDifficulty] || 1} /> : null}</div></div></Step> : null}

      {screen === "assigning" ? <StatusScreen icon="…" eyebrow="ASSIGNING" title="가장 빠른 방과 시간을 찾고 있어요" description="실제 이용 가능한 방과 시간을 확인하고 있어요." pulse={holdPending}>{holdPending ? <small>배정이 끝날 때까지 버튼을 다시 누르지 않아도 돼요.</small> : assignmentCanRetry ? <><button className="secondary-home" onClick={() => void chooseDifficulty(selectedDifficulty)}>다시 시도</button><button className="call-staff" onClick={returnToDifficultyFromAssignment}>난이도 선택으로 돌아가기</button></> : <button className="secondary-home" onClick={returnToPartyFromAssignment}>인원과 방 크기 다시 확인</button>}</StatusScreen> : null}

      {screen === "benefits" ? <Step className="benefits-step" eyebrow="BENEFITS" title={member ? `${member.member.name}님 일행의 혜택이에요` : "일반 결제로 진행할게요"} description="부모님 계정에 있는 다회권을 여러 명이 함께 사용할 수도 있어요.">{member ? <>
        <div className="linked-members">{linkedMembers.map((profile) => <span key={profile.member.id}>{profile.member.name}</span>)}{linkedMembers.length < (visit?.partyCount || 0) ? <button onClick={() => setExtraMemberOpen((value) => !value)}>+ 다른 회원 연결</button> : null}</div>
        {extraMemberOpen ? <div className="extra-member-form"><KioskInput label="추가 회원 휴대폰 번호" kind="numeric" maxLength={11} enterKeyHint="next" placeholder="010-1234-5678" value={extraPhone} onValueChange={(value) => setExtraPhone(value.replace(/\D/g, "").slice(0, 11))} formatter={formatKoreanPhone} /><KioskInput label="추가 회원 비밀번호" kind="english" secure enterKeyHint="done" placeholder="비밀번호" value={extraPassword} onValueChange={setExtraPassword} /><button disabled={busy || !extraPhone || !extraPassword} onClick={() => void addMember()}>회원 연결</button></div> : null}
        <div className="benefit-summary"><article><span>연결 회원</span><b>{linkedMembers.length}명</b></article><article><span>사용 가능한 다회권</span><b>{linkedMembers.reduce((sum, profile) => sum + profile.passes.filter((item) => item.usable).length, 0)}개</b></article><article><span>무료 이용권</span><b>{linkedMembers.reduce((sum, profile) => sum + profile.coupons.filter((item) => item.usable).length, 0)}개</b></article></div>
        <div className="benefit-list"><button aria-pressed={!passBenefit.id && !couponBenefit.id} className={!passBenefit.id && !couponBenefit.id ? "selected" : ""} onClick={() => { setPassBenefit({ id: "", ownerId: "", uses: 1 }); setCouponBenefit({ id: "", ownerId: "" }); }}><div><b>일반 결제</b><span>이용 인원 기준 정상가</span></div><i>✓</i></button>
          {bootstrap?.paymentSettings.methods.pass !== false ? linkedMembers.flatMap((profile) => profile.passes.filter((item) => item.usable).map((item) => <button aria-pressed={passBenefit.id === item.id} className={passBenefit.id === item.id ? "selected" : ""} key={item.id} onClick={() => { const participantSlots = (visit?.partyCount || 1) * Math.max(1, visit?.gameCount || selectedGames.length || 1); setPassBenefit((current) => current.id === item.id ? { id: "", ownerId: "", uses: 1 } : { id: item.id, ownerId: profile.member.id, uses: Math.min(item.remainingUses, participantSlots) }); if (couponBenefit.ownerId && couponBenefit.ownerId !== profile.member.id) setCouponBenefit({ id: "", ownerId: "" }); }}><div><b>{item.productName}</b><span>{profile.member.name} · {item.remainingUses}회 남음 · {item.expiresAt.slice(0, 10)}까지</span></div><i>✓</i></button>)) : null}
          {bootstrap?.paymentSettings.methods.coupon !== false ? linkedMembers.flatMap((profile) => profile.coupons.filter((item) => item.usable).map((item) => <button aria-pressed={couponBenefit.id === item.id} className={couponBenefit.id === item.id ? "selected" : ""} key={item.id} onClick={() => { setCouponBenefit((current) => current.id === item.id ? { id: "", ownerId: "" } : { id: item.id, ownerId: profile.member.id }); if (passBenefit.ownerId && passBenefit.ownerId !== profile.member.id) setPassBenefit({ id: "", ownerId: "", uses: 1 }); }}><div><b>{item.productName}</b><span>{profile.member.name} · {item.conditions} · {item.expiresAt.slice(0, 10)}까지</span></div><i>✓</i></button>)) : null}
        </div>{passBenefit.id ? <div className="stamp-choice"><div><b>다회권 차감 횟수</b><span>여러 게임이나 여러 명이 함께 사용하면 횟수를 늘려주세요.</span></div><Counter compact label="차감" description="" value={passBenefit.uses} onChange={(value) => { const participantSlots = (visit?.partyCount || 1) * Math.max(1, visit?.gameCount || selectedGames.length || 1); setPassBenefit((current) => ({ ...current, uses: Math.max(1, Math.min(Math.max(1, participantSlots - (couponBenefit.id ? 1 : 0)), value)) })); }} /></div> : null}<div className="stamp-policy"><b>스탬프는 자동으로 계산돼요</b><span>일반 게임비로 결제한 인원 1명당 게임마다 1개가 정상 종료 후 적립됩니다.</span><small>다회권·무료이용 쿠폰은 적립 대상에서 제외돼요. 같은 회원의 다회권과 쿠폰은 함께 사용할 수 있어요.</small></div>
      </> : <div className="guest-benefit"><Icon>₩</Icon><b>일반 결제</b><span>회원 로그인 없이도 바로 이용할 수 있어요.</span></div>}</Step> : null}

      {screen === "addons" ? <Step eyebrow="ADD-ONS" title="구매할 상품을 골라주세요" description="필요한 수량만 선택하세요. 품절 상품은 선택할 수 없어요."><div className="product-grid">{bootstrap?.products.map((product) => <article className={`${product.status === "SOLD_OUT" ? "soldout" : ""} ${(addOnCounts[product.code] || 0) > 0 ? "selected" : ""}`.trim()} key={product.code}><div><span>{product.status === "SOLD_OUT" ? "품절" : "판매 중"}</span><b>{product.name}</b><strong>{money(product.price)}</strong></div><Counter compact label="수량" description="" value={addOnCounts[product.code] || 0} disabled={product.status === "SOLD_OUT"} onChange={(value) => setAddOnCounts((current) => ({ ...current, [product.code]: value }))} /></article>)}</div><div className="selection-total"><span>부가상품 합계</span><b>{money(addOnTotal)}</b></div></Step> : null}

      {screen === "review" && currentFlowType === "PARTY_TOP_UP" ? <Step wide className="payment-review-step" eyebrow="PARTICIPANT TOP-UP" title="추가 인원과 결제 방법을 확인해주세요" description={quotePending ? "추가 결제금액을 확인하고 있어요." : "추가 인원 결제만 진행하며 기존 게임의 이용 시간은 그대로예요."}>{quotePending ? <div className="kiosk-inline-pending" role="status">추가 결제금액 확인 중</div> : null}<div className="review-card"><Row label="게임" value={`${visit?.scheduledTime || "-"} · ${visit?.roomCode || "-"} · ${visit?.teamName || "팀명 없음"}`} /><Row label="기존 인원" value={`성인 ${participantTopUp.expectedAdultCount || 0}명 · 청소년 ${participantTopUp.expectedYouthCount || 0}명`} /><Row label="추가 인원" value={`성인 ${participantTopUp.additionalAdultCount || 0}명 · 청소년 ${participantTopUp.additionalYouthCount || 0}명`} accent /><Row label="추가 후 인원" value={`총 ${(participantTopUp.targetAdultCount || 0) + (participantTopUp.targetYouthCount || 0)}명`} /><div className="review-total"><span>추가 결제할 금액</span><b>{quotePending ? "확인 중" : money(visit?.amounts.final || 0)}</b></div></div>{!quotePending && (visit?.amounts.final || 0) > 0 ? <PaymentPlanSelector total={visit?.amounts.final || 0} mode={paymentMode} count={paymentCount} items={paymentItems} methods={availablePaymentMethods} onMode={(nextMode) => { setPaymentMode(nextMode); setPaymentCount(2); setPaymentItems(nextMode === "single" ? [{ amount: visit?.amounts.final || 0, paymentMethod: firstPaymentMethod(bootstrap?.paymentSettings) }] : splitKioskEqualAmount(visit?.amounts.final || 0, 2).map((amount) => ({ amount, paymentMethod: firstPaymentMethod(bootstrap?.paymentSettings) }))); }} onCount={(nextCount) => { setPaymentCount(nextCount); setPaymentItems(splitKioskEqualAmount(visit?.amounts.final || 0, nextCount).map((amount, index) => ({ amount, paymentMethod: paymentItems[index]?.paymentMethod ?? "card" }))); }} onChange={setPaymentItems} /> : null}<div className="safety-note"><Icon>✓</Icon><p>결제가 완료되면 해당 게임의 인원과 매출에 바로 반영돼요.<br /><b>게임 시간은 추가되거나 다시 시작되지 않습니다.</b></p></div><button type="button" className="checkout-cancel" onClick={() => setCancelDialogMode("progress")}>결제 취소</button></Step> : null}

      {screen === "review" && currentFlowType !== "PARTY_TOP_UP" ? <Step wide className="payment-review-step" eyebrow="FINAL CHECK" title="결제 방법을 확인해주세요" description={quotePending ? "최종 결제금액을 확인하고 있어요." : "왼쪽에서 이용내역을 확인하고 오른쪽에서 결제 방식을 선택해주세요."}>{quotePending ? <div className="kiosk-inline-pending" role="status">최종 결제금액 확인 중</div> : null}<div className="review-card">{currentFlowType !== "ADD_ON_ONLY" ? <><div className="review-game-items">{selectedGames.length ? selectedGames.map((game) => <div key={game.id}><b>{game.sequence}게임</b><span>{game.scheduledTime} · {game.roomCode} · {game.difficultyLabel} <StarRating value={difficultyStars[game.difficultyCode.replace(/^b1-medium-/, "")] || 1} /></span><strong>{money(game.baseAmount)}</strong></div>) : <div><b>1게임</b><span>{visit?.scheduledTime || selectedTime} · {visit?.roomCode || selectedRoom} · {visit?.difficultyLabel || "확인 중"} <StarRating value={difficultyStars[(visit?.difficultyCode || selectedDifficulty).replace(/^b1-medium-/, "")] || 1} /></span><strong>{money(visit?.amounts.base || 0)}</strong></div>}</div><Row label="이용 인원" value={`성인 ${visit?.adultCount || adultCount}명 · 청소년·어린이 ${visit?.youthCount || youthCount}명`} /><Row label="팀명" value={visit?.teamName || teamName || "-"} /><Row label="게임비 합계" value={quotePending ? "확인 중" : money(visit?.amounts.base || 0)} /></> : null}<Row label="부가상품" value={quotePending ? money(addOnTotal) : money(visit?.amounts.addOn || 0)} />{!quotePending && (visit?.amounts.discount || 0) > 0 ? <Row label="회원 혜택" value={`-${money(visit?.amounts.discount || 0)}`} accent /> : null}<div className="review-total"><span>현장에서 결제할 금액</span><b>{quotePending ? "확인 중" : money(visit?.amounts.final || 0)}</b></div></div>
        {!quotePending && currentFlowType !== "ADD_ON_ONLY" && member ? <div className="stamp-preview"><div><span>총 참가 슬롯</span><b>{stampBreakdown.total || (visit?.partyCount || 0) * Math.max(1, visit?.gameCount || 1)}명</b></div><div><span>일반 게임비 결제</span><b>{stampBreakdown.paid || 0}명</b></div>{(stampBreakdown.pass || 0) > 0 ? <div><span>다회권 사용</span><b>{stampBreakdown.pass}명</b></div> : null}{(stampBreakdown.coupon || 0) > 0 ? <div><span>무료이용 쿠폰</span><b>{stampBreakdown.coupon}명</b></div> : null}<strong>적립 예정 스탬프 <em>{stampBreakdown.paid || 0}개</em></strong><small>각 게임이 정상 종료될 때 해당 게임의 유상 참가 인원만큼 자동 적립돼요.</small></div> : null}
        {!quotePending && (visit?.amounts.final || 0) > 0 ? <PaymentPlanSelector
          total={visit?.amounts.final || 0}
          mode={paymentMode}
          count={paymentCount}
          items={paymentItems}
          methods={availablePaymentMethods}
          onMode={(nextMode) => {
            setPaymentMode(nextMode);
            setPaymentCount(2);
            setPaymentItems(nextMode === "single"
              ? [{ amount: visit?.amounts.final || 0, paymentMethod: firstPaymentMethod(bootstrap?.paymentSettings) }]
              : splitKioskEqualAmount(visit?.amounts.final || 0, 2).map((amount) => ({ amount, paymentMethod: firstPaymentMethod(bootstrap?.paymentSettings) })));
          }}
          onCount={(nextCount) => {
            setPaymentCount(nextCount);
            setPaymentItems(splitKioskEqualAmount(visit?.amounts.final || 0, nextCount).map((amount, index) => ({
              amount,
              paymentMethod: paymentItems[index]?.paymentMethod ?? "card",
            })));
          }}
          onChange={setPaymentItems}
        /> : null}
        {!quotePending && (visit?.amounts.final || 0) > 0 && availablePaymentMethods.length === 0 ? <div className="kiosk-error"><Icon>!</Icon><span>현재 사용할 수 있는 일반 결제수단이 없습니다. 직원을 호출해주세요.</span></div> : null}
        <div className="safety-note"><Icon>✓</Icon><p>결제 후 준비 안내를 확인하고 홈으로 돌아갑니다.<br /><b>락커와 실내화 준비가 끝나면 첫 화면에서 게임을 시작해주세요.</b></p></div><button type="button" className="checkout-cancel" onClick={() => setCancelDialogMode("progress")}>결제 취소</button></Step> : null}

      {screen === "payment" ? <KioskPaymentProgress
        overview={visiblePaymentOverview}
        active={activePayment}
        activeMethod={activePaymentMethod}
        busy={busy || Boolean(attemptId)}
        methods={availablePaymentMethods}
        onMethodChange={(paymentMethod) => activePayment && setPaymentMethodOverrides((current) => ({ ...current, [activePayment.splitIndex]: paymentMethod }))}
        onProcess={() => activePayment && activePaymentMethod && void processCurrentPayment(activePayment, activePaymentMethod)}
        canCancel={paymentCanCancelBeforeExecution}
        cancelBlockedReason={paymentCancelBlockedReason}
        cancelBusy={cancelBusy}
        onCancel={() => setCancelDialogMode("payment")}
        onCallStaff={() => void callStaff()}
      /> : null}
      {screen === "staff-payment" ? <StatusScreen icon="…" eyebrow="STAFF CONFIRMATION" title={activePaymentMethod === "cash" ? "현금 결제를 확인하고 있어요" : "계좌이체로 결제해주세요"} description={activePayment ? `${money(activePayment.amount)} 결제를 확인한 뒤 다음 회차로 넘어갑니다.` : paymentTotalsByMethod.cash > 0 ? `${money(paymentTotalsByMethod.cash)}을 직원에게 결제해주세요.` : "입금 후 잠시 기다려주세요."} pulse>{activePaymentMethod === "account" && transferGuidance ? <div className="bank-transfer-kiosk-guide"><img src={`/api/transfer/${transferGuidance.token}/qr`} alt="계좌이체 안내 QR 코드" /><div><strong>{transferGuidance.bankName}</strong><b>{transferGuidance.accountNumber}</b><span>예금주: {transferGuidance.accountHolder}</span><small>{transferGuidance.depositorGuide}</small></div></div> : null}<span>직원이 확인하면 자동으로 다음 결제 또는 준비 단계로 이동합니다.</span><button className="secondary-payment-change" onClick={() => setScreen("payment")}>결제수단 다시 선택</button><button className="call-staff" onClick={() => void callStaff()}>직원 호출</button></StatusScreen> : null}
      {screen === "prepare-guide" ? <StatusScreen icon="✓" eyebrow="READY PREPARATION" title="이용 준비가 완료됐어요!" description={`${visit?.roomCode} · ${visit?.scheduledTime} · ${visit?.difficultyLabel}`}><div className="preparation-guide">{afterPaymentGuidance.map((item, index) => <div key={item.id}><b>{index + 1}</b><span>{item.content}</span></div>)}</div><div className="start-simple-notice"><b>준비가 끝나면 첫 화면에서 {visit?.roomCode}의 게임 시작을 눌러주세요.</b><span>확인번호는 필요하지 않아요.</span></div><div className="prepare-home-notice">안내를 확인하면 홈 화면으로 돌아갑니다.</div><button className="secondary-home" onClick={() => void resetHome(false)}>확인</button><small>키오스크는 다음 고객이 바로 이용할 수 있어요.</small></StatusScreen> : null}
      {screen === "preparing" ? <StatusScreen icon="⚙" eyebrow="PREPARING" title="아직 게임 방을 준비하고 있어요" description={`${visit?.roomCode} · ${visit?.scheduledTime} · ${visit?.difficultyLabel}`} pulse><div className="prepare-steps"><span className="done">결제 완료</span><span className="active">게임 정보 입력</span><span>안전 확인</span></div><button className="secondary-home" onClick={() => void resetHome(false)}>홈으로 돌아가기</button><small>준비 완료가 되면 첫 화면에 표시돼요.</small></StatusScreen> : null}
      {screen === "ready-select" ? <Step wide className="ready-room-select-step" eyebrow="READY TO PLAY" title="게임을 시작할 방을 확인해주세요" description="준비가 끝난 방만 표시됩니다. 본인 팀의 방과 시간을 확인해주세요."><div className="ready-room-list">{readyRooms.map((room) => <button type="button" key={room.code} disabled={busy} onClick={() => void openReadyRoom(room)}><span><small>{room.size}</small><b>{room.code}</b></span><div><strong>{room.preparationTime || "현재"}</strong><small>준비 완료된 예약팀</small></div><em>이 게임 시작 →</em></button>)}</div>{readyRooms.length === 0 ? <div className="kiosk-inline-pending" role="status">현재 시작할 수 있는 게임이 없어요.</div> : null}</Step> : null}
      {screen === "ready" ? <div className="start-checklist"><p className="step-eyebrow">READY TO PLAY</p><h2>게임 시작 전 확인</h2><div className="start-game-summary"><b>{visit?.roomCode}</b><span>{visit?.teamName || "예약팀"}</span><strong>{visit?.difficultyLabel || "난이도 확인"} <StarRating value={difficultyStars[(visit?.difficultyCode || "").replace(/^b1-medium-/, "")] || 1} /></strong></div><p className="start-checklist-lead">모든 항목을 확인하면 아래 게임 시작 버튼이 활성화됩니다.</p><div className="checklist-items">{startChecklistItems.map((item) => { const checked = Boolean(startChecklistChecks[item.id]); return <button type="button" key={item.id} className={checked ? "checked" : ""} aria-pressed={checked} onClick={() => setStartChecklistChecks((current) => ({ ...current, [item.id]: !checked }))}><b aria-hidden="true">{checked ? "✓" : ""}</b><span>{item.content}</span></button>; })}</div>{startCountdown !== null ? <div className="start-countdown" role="status" aria-live="assertive"><strong>{startCountdown || "시작"}</strong><span>{startCountdown ? "초 후 게임이 시작돼요" : "게임 시작 요청 중"}</span>{startCountdown > 0 ? <button disabled={busy} onClick={() => setStartCountdown(null)}>취소</button> : null}</div> : <><div className={`start-check-progress ${allStartChecksDone ? "complete" : ""}`} role="status">{allStartChecksDone ? "모든 확인이 끝났어요. 게임을 시작할 수 있어요." : `${startChecklistItems.filter((item) => startChecklistChecks[item.id]).length} / ${startChecklistItems.length} 확인 완료`}</div><button type="button" className="game-start" disabled={busy || !allStartChecksDone} onClick={() => setStartCountdown(3)}>게임 시작</button></>}{afterGameGuidance.map((item) => <small key={item.id}>{item.content}</small>)}</div> : null}
      {screen === "starting" ? <StatusScreen icon="▶" eyebrow="STARTING" title="게임을 시작하고 있어요" description="잠시 후 방의 안내에 따라 플레이해주세요." pulse><small>버튼을 다시 누르지 않아도 돼요.</small></StatusScreen> : null}
      {screen === "done" ? <StatusScreen icon="✓" eyebrow="COMPLETE" title={currentFlowType === "PARTY_TOP_UP" ? "게임 인원 추가 결제가 완료됐어요" : currentFlowType === "ADD_ON_ONLY" ? "결제가 완료됐어요" : "신나게 즐겨주세요!"} description={currentFlowType === "PARTY_TOP_UP" ? `${visit?.roomCode} · 추가 ${Number(participantTopUp.additionalAdultCount || 0) + Number(participantTopUp.additionalYouthCount || 0)}명 · ${money(visit?.amounts.final || 0)}` : currentFlowType === "ADD_ON_ONLY" ? money(visit?.amounts.final || 0) : `${visit?.roomCode} · ${visit?.teamName}`}><button className="secondary-home" onClick={() => void resetHome(false)}>처음 화면으로</button><small>{currentFlowType === "PARTY_TOP_UP" ? "기존 게임 시간은 그대로이며 인원과 매출만 반영됐어요." : "개인정보와 로그인 정보는 이 화면에 남지 않아요."}</small></StatusScreen> : null}
      {screen === "help" ? <StatusScreen icon="!" eyebrow="STAFF CHECK" title="직원 확인이 필요해요" description={error || visit?.error?.message || "잠시만 기다려주세요."}><button className="call-staff" onClick={() => void callStaff()}>직원 호출</button><small>결제나 게임을 임의로 다시 시도하지 마세요.</small></StatusScreen> : null}
    </section>
    {cancelDialogMode ? <div className="kiosk-cancel-dialog" role="dialog" aria-modal="true" aria-labelledby="kiosk-cancel-title"><button type="button" className="cancel-dialog-backdrop" aria-label="취소 창 닫기" onClick={() => !cancelBusy && setCancelDialogMode(null)} /><section><span>진행 취소</span><h2 id="kiosk-cancel-title">{cancelDialogMode === "payment" ? "결제를 취소하고 처음 화면으로 돌아갈까요?" : "진행 중인 내용을 취소하고 처음 화면으로 돌아갈까요?"}</h2><p>{cancelDialogMode === "payment" ? "아직 실행하지 않은 결제와 선택한 방이 취소됩니다." : "선택한 방과 지금까지 입력한 내용이 취소됩니다."}</p><div><button type="button" disabled={cancelBusy} onClick={() => setCancelDialogMode(null)}>{cancelDialogMode === "payment" ? "계속 결제" : "계속하기"}</button><button type="button" className="danger" disabled={cancelBusy} onClick={() => void confirmCancellationAndHome()}>{cancelBusy ? "취소 처리 중" : cancelDialogMode === "payment" ? "결제 취소하고 홈으로" : "취소하고 홈으로"}</button></div></section></div> : null}
    {!bottomNavHidden ? <nav className={`kiosk-bottom-nav ${bottomNext ? "with-next" : ""}`.trim()} aria-label="키오스크 화면 이동"><button type="button" className="nav-back" disabled={navigationBackDisabled} onClick={back}>← 이전</button><button type="button" className="nav-home" disabled={navigationHomeDisabled} onClick={requestHomeNavigation}>⌂ 처음으로</button><button type="button" className="nav-next" disabled={!bottomNext || bottomNext.disabled} onClick={() => bottomNext?.action()}>{bottomNext?.label || (paymentIsProcessing ? "결제 처리 중" : "다음")} <span>→</span></button></nav> : null}
    <footer className="kiosk-footer"><span>이 키오스크는 결제·예약 중복 방지 기능으로 안전하게 운영됩니다.</span><button onClick={() => setScreen("help")}>도움이 필요해요</button></footer>
  </main>;
}

function Step({ eyebrow, title, description, children, wide = false, className = "" }: { eyebrow: string; title: string; description: string; children: React.ReactNode; wide?: boolean; className?: string }) { return <div className={`kiosk-step ${wide ? "wide" : ""} ${className}`.trim()}><p className="step-eyebrow">{eyebrow}</p><h2>{title}</h2><div className="step-description">{description}</div><div className="step-body">{children}</div></div>; }
function Primary({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) { return <button className="kiosk-primary" disabled={disabled} onClick={onClick}>{children}<span>→</span></button>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="kiosk-field"><span>{label}</span>{children}</label>; }
function Counter({ label, description, value, onChange, compact = false, disabled = false }: { label: string; description: string; value: number; onChange: (value: number) => void; compact?: boolean; disabled?: boolean }) { return <div className={`kiosk-counter ${compact ? "compact" : ""}`}><div><b>{label}</b>{description ? <span>{description}</span> : null}</div><div><button disabled={disabled || value <= 0} onClick={() => onChange(Math.max(0, value - 1))}>−</button><strong>{value}</strong><button disabled={disabled || value >= 10} onClick={() => onChange(Math.min(10, value + 1))}>＋</button></div></div>; }
function RoomTimeTable({ rooms, partyCount, busy, onChoose }: { rooms: Room[]; partyCount: number; busy: boolean; onChoose: (roomCode: string, time: string) => void }) {
  const order = ["C2", "B1", "C1", "A1"];
  const sortedRooms = [...rooms].sort((left, right) => order.indexOf(left.code) - order.indexOf(right.code));
  const times = [...new Set(sortedRooms.flatMap((room) => room.slots))].sort().slice(0, 8);
  if (!times.length) return <div className="timetable-empty"><Icon>!</Icon><b>오늘 선택할 수 있는 시간이 없어요.</b><span>직원에게 이용 가능 시간을 문의해주세요.</span></div>;
  return <div className="customer-timetable" role="table" aria-label="방별 예약 가능 시간">
    <div className="timetable-header" role="row"><div role="columnheader">시간</div>{sortedRooms.map((room) => <div role="columnheader" key={room.code}><strong>{room.code}</strong><span>{room.size} · 권장 {room.recommended}</span></div>)}</div>
    <div className="timetable-rows">{times.map((time, timeIndex) => <div className="timetable-row" role="row" key={time}><div className="timetable-time" role="rowheader"><b>{time}</b>{timeIndex === 0 ? <span>가장 빠른 시간대</span> : null}</div>{sortedRooms.map((room) => {
      const available = room.selectable && room.slots.includes(time);
      const capacityExceeded = partyCount > room.max;
      const label = capacityExceeded ? "인원 초과" : room.status === "offline" ? "확인 중" : room.status === "running" ? "게임 중" : "예약됨";
      return available ? <button className={timeIndex === 0 ? "timetable-slot fastest" : "timetable-slot"} disabled={busy} key={room.code} onClick={() => onChoose(room.code, time)}><span>{timeIndex === 0 ? "가장 빠름" : "선택 가능"}</span><b>선택</b></button> : <div className="timetable-slot blocked" role="cell" key={room.code}><span>{label}</span></div>;
    })}</div>)}</div>
  </div>;
}
function RoomStrip({ rooms, updatedAt, delayed }: { rooms: Room[]; updatedAt: number; delayed: boolean }) {
  const order = ["C2", "B1", "C1", "A1"];
  const sortedRooms = [...rooms].sort((left, right) => order.indexOf(left.code) - order.indexOf(right.code));
  const refreshed = updatedAt ? new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(updatedAt)) : "확인 중";
  return <section className="room-overview"><header><div><p>LIVE ROOM STATUS</p><h2>현재 이용 현황</h2></div><span className={delayed ? "room-status-delayed" : ""}><i /> {delayed ? `상태 확인 중 · 마지막 ${refreshed}` : `2초 자동 갱신 · ${refreshed}`}</span></header><div className="room-strip">{sortedRooms.map((room) => {
    const running = room.status === "running";
    const offline = room.status === "offline";
    const preparationState = room.preparationState || "";
    const preparing = ["PREPARING", "READY_TO_PLAY"].includes(preparationState);
    const statusLabel = preparing ? (preparationState === "READY_TO_PLAY" ? "시작 가능" : "준비 중") : running ? "이용 중" : offline ? "확인 중" : "이용 가능";
    const detail = preparing ? `${room.preparationTime || "현재"} 예약팀` : running ? `${String(Math.floor(room.remainingSeconds / 60)).padStart(2, "0")}:${String(room.remainingSeconds % 60).padStart(2, "0")} 남음` : offline ? "직원에게 문의해주세요" : room.slots[0] ? `${room.slots[0]}부터 선택 가능` : "오늘 예약 마감";
    return <article className={preparing ? "preparing customer-ready" : running ? "running" : offline ? "offline" : "available"} key={room.code}><div className="room-code"><small>{room.size}</small><b>{room.code}</b></div><div className="room-live-copy"><strong><span className={`dot ${preparing ? "ready" : room.status}`} />{statusLabel}</strong><small>{detail}</small></div>{preparationState === "READY_TO_PLAY" ? <em className="room-ready-label">시작 대기</em> : preparing ? <em>방 준비 중</em> : <em>권장 {room.recommended}</em>}</article>;
  })}</div></section>;
}
const KIOSK_PAYMENT_METHODS: Array<{ code: KioskPaymentMethod; label: string; description: string; icon: "card" | "cash" | "account" }> = [
  { code: "card", label: "카드 · 페이", description: "카드 또는 휴대폰 결제", icon: "card" },
  { code: "cash", label: "현금", description: "직원 확인", icon: "cash" },
  { code: "account", label: "계좌이체", description: "QR 송금 후 입금 확인", icon: "account" },
];

function paymentMethodLabel(method: string) {
  if (method === "cash") return "현금";
  if (method === "account") return "계좌이체";
  if (method === "coupon") return "무료 이용권";
  return "카드 · 페이";
}

function PaymentMethodButtons({ value, onChange, methods, disabled = false }: { value: KioskPaymentMethod | null; onChange: (value: KioskPaymentMethod) => void; methods: KioskPaymentMethod[]; disabled?: boolean }) {
  return <div className="payment-method-buttons compact">{KIOSK_PAYMENT_METHODS.filter((method) => methods.includes(method.code)).map((method) => <button type="button" disabled={disabled} aria-pressed={value === method.code} className={value === method.code ? "selected" : ""} key={method.code} onClick={() => onChange(method.code)}><i className="payment-method-icon"><KioskLineIcon name={method.icon} /></i><span><b>{method.label}</b></span><em>{value === method.code ? "✓" : ""}</em></button>)}</div>;
}

function PaymentPlanSelector({ total, mode, count, items, methods, onMode, onCount, onChange }: {
  total: number; mode: KioskPaymentMode; count: number; items: PaymentItemInput[];
  methods: KioskPaymentMethod[];
  onMode: (value: KioskPaymentMode) => void; onCount: (value: number) => void; onChange: (value: PaymentItemInput[]) => void;
}) {
  const sum = items.reduce((value, item) => value + item.amount, 0);
  const modeOptions: Array<{ code: KioskPaymentMode; label: string }> = [
    { code: "single", label: "한번에 결제" },
    { code: "equal", label: "N분의1" },
    { code: "custom", label: "직접 나누기" },
  ];
  const changeAmount = (index: number, amount: number) => onChange(items.map((item, itemIndex) => itemIndex === index ? { ...item, amount: Math.max(0, Math.min(total, Math.trunc(amount || 0))) } : item));
  return <section className="payment-plan-panel">
    <header><div><b>결제 방식</b></div></header>
    <div className="payment-mode-tabs">{modeOptions.map((option) => <button type="button" aria-pressed={mode === option.code} className={mode === option.code ? "selected" : ""} key={option.code} onClick={() => onMode(option.code)}><b>{option.label}</b></button>)}</div>
    {mode === "equal" ? <div className="payment-count-control"><div><b>몇 명이 나눠 결제하나요?</b></div><div><button type="button" disabled={count <= 2} onClick={() => onCount(Math.max(2, count - 1))}>−</button><strong>{count}명</strong><button type="button" disabled={count >= 10} onClick={() => onCount(Math.min(10, count + 1))}>＋</button></div></div> : null}
    <div className="payment-plan-items">{items.map((item, index) => <article key={`${mode}-${index}`}>
      <header><div><span>{items.length === 1 ? "결제 금액" : `${index + 1}번째 결제`}</span>{mode === "custom" ? <label><KioskInput ariaLabel={`${index + 1}번째 결제 금액`} label={`${index + 1}번째 결제 금액`} kind="numeric" maxLength={String(Math.max(0, total)).length} enterKeyHint="done" value={item.amount ? String(item.amount) : ""} onValueChange={(value) => changeAmount(index, Number(value.replace(/\D/g, "")))} formatter={(value) => value ? Number(value).toLocaleString("ko-KR") : ""} /><b>원</b></label> : <strong>{money(item.amount)}</strong>}</div>{mode === "custom" && items.length > 2 ? <button type="button" className="payment-item-remove" onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}>삭제</button> : null}</header>
      {mode === "single" ? <PaymentMethodButtons value={item.paymentMethod} methods={methods} onChange={(paymentMethod) => onChange([{ ...item, paymentMethod }])} /> : <small className="payment-method-later">각 회차 결제 직전에 결제수단을 선택해요.</small>}
    </article>)}</div>
    {mode === "custom" && items.length < 10 ? <button type="button" className="payment-item-add" onClick={() => onChange([...items, { amount: 0, paymentMethod: methods[0] ?? "card" }])}>＋ 결제 회차 추가</button> : null}
    <div className={sum === total && items.every((item) => item.amount > 0) ? "payment-sum valid" : "payment-sum invalid"}><span>분할 금액 합계</span><b>{money(sum)} / {money(total)}</b></div>
  </section>;
}

function KioskPaymentProgress({ overview, active, activeMethod, methods, busy, canCancel, cancelBlockedReason, cancelBusy, onMethodChange, onProcess, onCancel, onCallStaff }: {
  overview: PaymentOverview | null; active: PaymentPlanItem | null; activeMethod: KioskPaymentMethod | null; busy: boolean;
  methods: KioskPaymentMethod[];
  canCancel: boolean; cancelBlockedReason: string; cancelBusy: boolean;
  onMethodChange: (value: KioskPaymentMethod) => void; onProcess: () => void; onCancel: () => void; onCallStaff: () => void;
}) {
  if (!overview) return <StatusScreen icon="…" eyebrow="PAYMENT" title="결제를 준비하고 있어요" description="결제 정보를 안전하게 확인하고 있습니다." pulse><span>잠시만 기다려주세요.</span></StatusScreen>;
  const processing = active?.status === "PROCESSING" || busy;
  const failed = Boolean(active && ["DECLINED", "USER_CANCELLED", "ERROR", "BUSY", "UNLINKED"].includes(active.status));
  const activeDisplayIndex = Math.max(1, overview.plan.findIndex((item) => item.id === active?.id) + 1);
  const splitPayment = overview.plan.length > 1;
  const totalAmount = overview.plan.reduce((sum, item) => sum + item.amount, 0);
  const completedItems = overview.plan.filter((item) => ["APPROVED", "COMPLETED"].includes(item.status));
  const completedAmount = completedItems.reduce((sum, item) => sum + item.amount, 0);
  return <div className="kiosk-payment-progress">
    <p className="step-eyebrow">{splitPayment ? "SPLIT PAYMENT" : "PAYMENT"}</p><h2>{processing ? "결제 결과를 확인하고 있어요" : failed ? "결제수단을 바꿔 다시 진행할 수 있어요" : splitPayment ? "순서대로 결제해주세요" : "결제수단을 확인해주세요"}</h2>
    <p>{active ? splitPayment ? `${activeDisplayIndex}번째 ${money(active.amount)} 결제를 진행합니다.` : `${money(active.amount)} 결제를 진행합니다.` : "모든 결제 내역을 확인하고 있습니다."}</p>
    {splitPayment ? <div className="payment-progress-summary" aria-label="분할결제 진행 현황"><div><span>총 결제</span><b>{money(totalAmount)}</b></div><div><span>완료</span><b>{money(completedAmount)}</b></div><div><span>남음</span><b>{money(Math.max(0, totalAmount - completedAmount))}</b></div><strong>{completedItems.length} / {overview.plan.length} 완료</strong></div> : null}
    {splitPayment ? <div className="payment-progress-list">{overview.plan.map((item, index) => {
      const completed = ["APPROVED", "COMPLETED"].includes(item.status);
      const current = active?.id === item.id;
      const displayIndex = index + 1;
      const methodText = completed ? ` · ${paymentMethodLabel(item.paymentMethod)}` : current && activeMethod ? ` · ${paymentMethodLabel(activeMethod)}` : "";
      return <article className={completed ? "completed" : current ? "current" : "waiting"} key={item.id}><span>{completed ? "✓" : displayIndex}</span><div><b>{`${displayIndex}번째 결제${methodText}`}</b><small>{completed ? "결제 완료" : current ? failed ? item.responseMessage || "다시 시도해주세요." : processing ? "처리 중" : activeMethod ? "결제 준비" : "결제수단 선택" : "앞 결제 후 진행"}</small></div><strong>{money(item.amount)}</strong></article>;
    })}</div> : null}
    {active && !processing && active.paymentMethod !== "coupon" ? <section className={`current-payment-choice ${splitPayment ? "" : "single"}`.trim()}><div><b>{splitPayment ? `${activeDisplayIndex}번째 결제수단` : "결제수단"}</b><span>{splitPayment ? "이번 회차에서 사용할 결제수단을 선택해주세요." : "결제를 시작하기 전까지 자유롭게 바꿀 수 있어요."}</span></div><PaymentMethodButtons value={activeMethod} methods={methods} onChange={onMethodChange} /><button type="button" className="current-payment-start" disabled={!activeMethod} onClick={onProcess}>{activeMethod ? splitPayment ? `${activeDisplayIndex}번째 · ${money(active.amount)} ${paymentMethodLabel(activeMethod)} 결제` : `${money(active.amount)} ${paymentMethodLabel(activeMethod)} 결제` : "결제수단을 선택해주세요"}</button></section> : null}
    {processing ? <div className="payment-processing-note"><i />{activeMethod === "card" ? "카드 또는 휴대폰을 단말기에 꽂거나 태그해주세요. 승인 결과를 기다리고 있어요." : "직원 확인을 기다리고 있어요."}</div> : null}
    {canCancel ? <button type="button" className="payment-cancel-action" disabled={cancelBusy} onClick={onCancel}>{cancelBusy ? "취소 확인 중" : "결제 취소"}</button> : <div className={`payment-cancel-locked ${processing ? "processing" : ""}`.trim()}><span>{cancelBlockedReason}</span>{!processing ? <button type="button" onClick={onCallStaff}>직원 호출</button> : null}</div>}
  </div>;
}
function Row({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  if (label === "부가상품" && value === "0원") return null;
  return <div className={`review-row ${accent ? "accent" : ""}`}><span>{label}</span><b>{value}</b></div>;
}
function StatusScreen({ icon, eyebrow, title, description, children, pulse = false }: { icon: string; eyebrow: string; title: string; description: string; children: React.ReactNode; pulse?: boolean }) { return <div className="status-screen"><div className={`status-orb ${pulse ? "pulse" : ""}`}>{icon}</div><p className="step-eyebrow">{eyebrow}</p><h2>{title}</h2><p>{description}</p>{children}</div>; }
