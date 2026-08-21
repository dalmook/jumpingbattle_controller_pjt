"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { PricingSettings } from "@/app/pricing-config";
import {
  GAME_DURATION_MINUTES,
  OPERATING_SLOTS,
  ROOM_OPTIONS,
  SLOT_INTERVAL_MINUTES,
  getDifficultyOptions,
  timeInSeoul,
  type ReservationRecord,
} from "@/app/reservation-config";
import type { AnalyticsResponse } from "@/app/admin/analytics-types";
import type { ControlAction, Room, StatusResponse } from "@/app/types";
import { quotePassUse } from "@/app/pass-use";
import { maxPassCreditUses, type PassCreditCandidate } from "@/app/pass-purchase-credit";
import {
  QuickBookingModal,
  RemoteControlPanel,
  ReservationDetailCard,
  ScheduleBoard,
  TerminalPaymentControls,
  type ReservationListChange,
  type ScheduleSelection,
} from "../ReservationsAdmin";
import { formatPaymentTimeInSeoul } from "../payment-time";
import { BottomSheet, Button, ConfirmDialog, EmptyState, PageHeader, SectionCard, Skeleton, StatusBadge, SummaryCard, Toast, money } from "./ui";

type Tab = "home" | "reservations" | "payments" | "members" | "more";
type MemberSummary = {
  id: string; name: string; phone: string; phoneLast4: string; birthday: string;
  teamName: string; email: string; vehicleNumber: string; memo: string;
  status: string; lastVisit: string; visitCount: number; totalSpent: number; createdAt: string; updatedAt: string;
};
type MemberDetail = MemberSummary & {
  reservations: Array<{ id: string; bookingCode: string; scheduledDate: string; scheduledTime: string; roomCode: string; teamName: string; status: string; totalCount: number; paymentAmount: number; paymentStatus: string }>;
  futureBenefits: { stamps: null; prepaidBalance: null };
};
type PassProduct = { code: string; name: string; ageGroup: string; uses: number; price: number; regularUnitPrice: number; active: boolean };
type MemberPass = { id: string; productCode: string; productName: string; ageGroup: string; purchasedUses: number; remainingUses: number; purchasePrice: number | null; regularUnitPrice: number; purchasedAt: string; expiresAt: string; status: string; paymentMethod: string; source: string };
type MemberCoupon = { id: string; couponType: "STAMP_REWARD" | "WEEKDAY_EVENT"; name: string; status: string; issuedAt: string; expiresAt: string; usedAt: string; usedReservationId: string; source: string };
type BenefitHistory = { id: string; type: string; uses?: number; amount?: number; member_pass_id?: string; reservation_id?: string; reference_id?: string; reference_key?: string; regular_amount?: number; reason?: string; source?: string; created_at: string };
type MemberBenefits = {
  member: { id: string; name: string };
  settings: { stampGoal: number; stampEarnPerGame: number; passValidityMonths: number };
  products: PassProduct[];
  stampBalance: number;
  passes: MemberPass[];
  coupons: MemberCoupon[];
  stampHistory: BenefitHistory[];
  passHistory: BenefitHistory[];
  pendingOrders: Array<{ id: string; product_name: string; amount: number; status: string; payment_status: string; created_at: string }>;
};
type PassPurchaseOrder = {
  orderId: string;
  reservationId: string;
  listAmount: number;
  creditAmount: number;
  creditReservationId: string | null;
  initialUsedUses: number;
  paymentAmount: number;
};
type PaymentHistoryItem = {
  paymentId: string;
  reservationId: string;
  paymentType: string;
  source: string;
  title: string;
  customerName: string;
  bookingCode: string;
  status: string;
  finalAmount: number;
  depositAmount: number;
  paidAmount: number;
  cardAmount: number;
  cashAmount: number;
  accountAmount: number;
  couponAmount: number;
  terminalDirectAmount: number;
  authNo: string;
  authDate: string;
  approvalTime: string;
  createdAt: string;
  paidAt: string;
  canCancel: boolean;
  canDelete: boolean;
};

function paymentTypeLabel(type: string) {
  if (type === "PASS_PURCHASE") return "다회권";
  if (type === "ADD_ON_SALE") return "부가매출";
  return "게임비";
}

function linkedPaidGameReservations(anchor: ReservationRecord | null, reservations: ReservationRecord[]) {
  if (!anchor) return [];
  const linked = anchor.repeatGroupId
    ? reservations.filter((item) =>
        item.repeatGroupId === anchor.repeatGroupId &&
        item.scheduledDate === anchor.scheduledDate &&
        item.memberId === anchor.memberId)
    : [anchor];
  return linked
    .filter((item) =>
      item.source !== "member_pass_purchase" &&
      item.status !== "cancelled" &&
      item.paymentStatus === "paid")
    .sort((left, right) => left.repeatSequence - right.repeatSequence || left.scheduledTime.localeCompare(right.scheduledTime));
}

function toPassCreditCandidates(reservations: ReservationRecord[]): PassCreditCandidate[] {
  return reservations.map((item) => ({
    id: item.id,
    adultCount: item.adultCount,
    youthCount: item.youthCount,
    totalCount: item.totalCount,
    paidGameAmount: Math.max(0, Math.min(item.baseAmount, item.paymentAmount - item.addOnAmount)),
  }));
}

function PaymentHistoryCard({
  item,
  busy,
  onOpen,
  onCancel,
  onDelete,
}: {
  item: PaymentHistoryItem;
  busy: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const revenueAmount = item.cardAmount + item.cashAmount + item.accountAmount;
  const methodParts = [
    item.cardAmount ? `카드 ${money(item.cardAmount)}` : "",
    item.cashAmount ? `현금 ${money(item.cashAmount)}` : "",
    item.accountAmount ? `계좌 ${money(item.accountAmount)}` : "",
    item.couponAmount ? `쿠폰 ${money(item.couponAmount)} (매출 제외)` : "",
  ].filter(Boolean);
  return <article className={`pos-payment-history-row status-${item.status.toLowerCase()}`}>
    <div className="pos-payment-history-main">
      <div className="pos-payment-history-badges"><span>{paymentTypeLabel(item.paymentType)}</span>{item.terminalDirectAmount ? <span className="is-terminal-direct">단말 직접 · 수동 확인</span> : null}<StatusBadge status={item.status.toLowerCase()} /></div>
      <strong>{item.title}</strong>
      <small>{item.customerName || "고객 미지정"} · {item.bookingCode}</small>
      <small>{methodParts.join(" · ") || "취소 완료"}{item.authNo ? ` · 승인 ${item.authNo}` : ""}</small>
    </div>
    <div className="pos-payment-history-amount"><b>{money(revenueAmount)}</b>{item.couponAmount ? <small>실매출 기준</small> : null}<time>{formatPaymentTimeInSeoul({ authDate: item.authDate, approvalTime: item.approvalTime, fallbackTimestamp: item.paidAt || item.createdAt })}</time></div>
    <div className="pos-payment-history-actions">
      {item.status === "UNKNOWN" ? <Button tone="primary" disabled={busy} onClick={onOpen}>승인번호 입력</Button> : null}
      {item.canCancel ? <Button tone="danger" disabled={busy} onClick={onCancel}>{busy ? "처리 중" : "결제 취소"}</Button> : null}
      {item.terminalDirectAmount ? <small>단말 직접 결제건은 예약 상세에서 연결 해제할 수 있습니다.</small> : null}
      {item.canDelete ? <Button tone="ghost" disabled={busy} onClick={onDelete}>{busy ? "삭제 중" : "내역 삭제"}</Button> : null}
    </div>
  </article>;
}

const NAV: Array<{ key: Tab; label: string; icon: string }> = [
  { key: "home", label: "홈", icon: "⌂" }, { key: "reservations", label: "예약", icon: "▦" },
  { key: "payments", label: "결제", icon: "₩" }, { key: "members", label: "회원", icon: "◎" },
  { key: "more", label: "더보기", icon: "•••" },
];

const roomName = (code: string) => ROOM_OPTIONS.find((room) => room.code === code)?.name ?? (code || "미배정");
const statusRank: Record<string, number> = { arrived: 0, booked: 1, completed: 2, cancelled: 3 };
const memberNameCollator = new Intl.Collator("ko-KR", { sensitivity: "base", numeric: true });
const sortMembersByName = (items: MemberSummary[]) => [...items].sort((a, b) => memberNameCollator.compare(a.name, b.name) || memberNameCollator.compare(a.teamName, b.teamName));

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "요청을 처리하지 못했습니다.");
  return payload;
}

function sourceLabel(source: string) {
  if (source === "naver") return "네이버";
  if (source === "web_walkin") return "고객 접수";
  return "직접 입력";
}

function PosReservationCard({ reservation, onOpen }: { reservation: ReservationRecord; onOpen: () => void }) {
  return <button className={`pos-reservation-row status-${reservation.status}`} onClick={onOpen}>
    <time>{reservation.scheduledTime}</time>
    <div><span className="pos-row-meta">{roomName(reservation.roomCode)} · {sourceLabel(reservation.source)}</span><strong>{reservation.teamName || reservation.customerName || "팀명 미입력"}</strong><small>{reservation.difficultyLabel || "난이도 미정"} · {reservation.totalCount}명{reservation.vehicleLast4 ? ` · 차량 ${reservation.vehicleLast4}` : ""}</small></div>
    <div className="pos-row-money"><StatusBadge status={reservation.status} /><b>{money(reservation.paymentAmount || reservation.baseAmount)}</b><small>{reservation.paymentStatus === "paid" ? "결제완료" : "미결제"}</small></div>
  </button>;
}

export default function PosV2({ operatorName, initialDate, pricing }: { operatorName: string; initialDate: string; pricing: PricingSettings }) {
  const [tab, setTab] = useState<Tab>("home");
  const [date, setDate] = useState(initialDate);
  const [reservations, setReservations] = useState<ReservationRecord[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [todayReservations, setTodayReservations] = useState<ReservationRecord[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<ReservationRecord | null>(null);
  const [newSlot, setNewSlot] = useState<{ time: string; roomCode: string } | null>(null);
  const [remoteSelection, setRemoteSelection] = useState<ScheduleSelection | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "good" | "error" }>({ message: "", tone: "good" });
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberLoading, setMemberLoading] = useState(false);
  const [memberLinkOpen, setMemberLinkOpen] = useState(false);
  const [stampEarnCount, setStampEarnCount] = useState(1);
  const [reservationDetailOpen, setReservationDetailOpen] = useState(false);
  const [reservationDetailFilter, setReservationDetailFilter] = useState<"all" | "unpaid" | "arrived" | "unassigned" | "cancelled">("all");
  const [selectedMember, setSelectedMember] = useState<MemberDetail | null>(null);
  const [memberBenefits, setMemberBenefits] = useState<MemberBenefits | null>(null);
  const [reservationBenefits, setReservationBenefits] = useState<MemberBenefits | null>(null);
  const [passPurchaseOpen, setPassPurchaseOpen] = useState(false);
  const [passPurchaseReservation, setPassPurchaseReservation] = useState<ReservationRecord | null>(null);
  const [passPurchaseOrder, setPassPurchaseOrder] = useState<PassPurchaseOrder | null>(null);
  const [passPurchaseCreditReservationId, setPassPurchaseCreditReservationId] = useState("");
  const [passPurchaseCreditUses, setPassPurchaseCreditUses] = useState(1);
  const [passUseCounts, setPassUseCounts] = useState<Record<string, number>>({});
  const [benefitBusy, setBenefitBusy] = useState("");
  const [paymentHistory, setPaymentHistory] = useState<PaymentHistoryItem[]>([]);
  const [paymentHistoryQuery, setPaymentHistoryQuery] = useState("");
  const [paymentHistoryLoading, setPaymentHistoryLoading] = useState(false);
  const [paymentHistoryBusy, setPaymentHistoryBusy] = useState("");
  const [paymentConfirm, setPaymentConfirm] = useState<{ mode: "cancel" | "delete"; item: PaymentHistoryItem } | null>(null);
  const [addOnCounts, setAddOnCounts] = useState({ slush: 0, beverage: 0, other: 0 });
  const [addOnExtraCounts, setAddOnExtraCounts] = useState<Record<string, number>>({});
  const [addOnReservation, setAddOnReservation] = useState<ReservationRecord | null>(null);
  const [addOnBusy, setAddOnBusy] = useState(false);
  const [memberFormOpen, setMemberFormOpen] = useState(false);
  const [memberEditOpen, setMemberEditOpen] = useState(false);
  const [manualStartMode, setManualStartMode] = useState(true);
  const [controlPinned, setControlPinned] = useState(false);
  const [controlBusy, setControlBusy] = useState("");
  const [controlNotice, setControlNotice] = useState("");
  const [statusError, setStatusError] = useState("");
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0);
  const memberNameRef = useRef<HTMLInputElement>(null);
  const statusRefreshInFlight = useRef(false);

  const notify = useCallback((message: string, tone: "good" | "error" = "good") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast({ message: "", tone: "good" }), 2600);
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const [reservationData, statusData, analyticsData] = await Promise.all([
        requestJson<{ reservations: ReservationRecord[] }>(`/api/admin/reservations?date=${encodeURIComponent(date)}`),
        requestJson<StatusResponse>("/api/status"),
        requestJson<AnalyticsResponse>(`/api/admin/analytics?month=${encodeURIComponent(date.slice(0, 7))}`),
      ]);
      setReservations(reservationData.reservations);
      if (date === initialDate) setTodayReservations(reservationData.reservations);
      setStatus(statusData);
      const generatedAt = Date.parse(statusData.generatedAt);
      if (Number.isFinite(generatedAt)) setServerClockOffsetMs(generatedAt - Date.now());
      setAnalytics(analyticsData);
      setSelected((current) => current ? reservationData.reservations.find((item) => item.id === current.id) ?? null : null);
      setRemoteSelection((current) => {
        const reservationId = current?.reservation?.id;
        if (!reservationId) return current;
        const refreshed = reservationData.reservations.find((item) => item.id === reservationId);
        return refreshed
          ? {
              ...current,
              time: refreshed.scheduledTime,
              roomCode: refreshed.roomCode,
              reservation: refreshed,
            }
          : null;
      });
    } catch (error) { notify(error instanceof Error ? error.message : "운영 정보를 불러오지 못했습니다.", "error"); }
    finally { setLoading(false); setRefreshing(false); }
  }, [date, initialDate, notify]);

  const refreshStatus = useCallback(async () => {
    if (statusRefreshInFlight.current) return;
    statusRefreshInFlight.current = true;
    const requestedAt = Date.now();
    try {
      const data = await requestJson<StatusResponse>("/api/status");
      const receivedAt = Date.now();
      const generatedAt = Date.parse(data.generatedAt);
      if (Number.isFinite(generatedAt)) {
        setServerClockOffsetMs(Math.round(generatedAt - (requestedAt + receivedAt) / 2));
      }
      setStatus(data);
      setStatusError("");
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : "매장 상태를 불러오지 못했습니다.");
    } finally {
      statusRefreshInFlight.current = false;
    }
  }, []);

  const loadPaymentHistory = useCallback(async (quiet = false) => {
    if (!quiet) setPaymentHistoryLoading(true);
    try {
      const payload = await requestJson<{ payments: PaymentHistoryItem[] }>(
        `/api/admin/payments?scope=history&date=${encodeURIComponent(date)}&query=${encodeURIComponent(paymentHistoryQuery)}`,
      );
      setPaymentHistory(payload.payments);
    } catch (error) {
      notify(error instanceof Error ? error.message : "결제 내역을 불러오지 못했습니다.", "error");
    } finally {
      if (!quiet) setPaymentHistoryLoading(false);
    }
  }, [date, notify, paymentHistoryQuery]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);
  useEffect(() => {
    if (tab !== "payments") return;
    const timer = window.setTimeout(() => void loadPaymentHistory(), 180);
    return () => window.clearTimeout(timer);
  }, [loadPaymentHistory, tab]);
  useEffect(() => { const timer = window.setInterval(() => void load(true), 15000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => {
    if (date === initialDate) return;
    const task = window.setTimeout(async () => {
      try {
        const data = await requestJson<{ reservations: ReservationRecord[] }>(`/api/admin/reservations?date=${encodeURIComponent(initialDate)}`);
        setTodayReservations(data.reservations);
      } catch (error) {
        setStatusError(error instanceof Error ? error.message : "오늘 예약을 불러오지 못했습니다.");
      }
    }, 0);
    return () => window.clearTimeout(task);
  }, [date, initialDate]);
  useEffect(() => {
    if (tab !== "home") return;
    const refreshVisibleStatus = () => {
      if (!document.hidden) void refreshStatus();
    };
    const initial = window.setTimeout(refreshVisibleStatus, 0);
    const timer = window.setInterval(refreshVisibleStatus, 1_000);
    window.addEventListener("focus", refreshVisibleStatus);
    document.addEventListener("visibilitychange", refreshVisibleStatus);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisibleStatus);
      document.removeEventListener("visibilitychange", refreshVisibleStatus);
    };
  }, [refreshStatus, tab]);
  useEffect(() => {
    if (tab !== "members" && !selected) return;
    const timer = window.setTimeout(async () => {
      setMemberLoading(true);
      try { setMembers(sortMembersByName((await requestJson<{ members: MemberSummary[] }>(`/api/admin/members?q=${encodeURIComponent(memberQuery)}&limit=200`)).members)); }
      catch (error) { notify(error instanceof Error ? error.message : "회원 검색에 실패했습니다.", "error"); }
      finally { setMemberLoading(false); }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [memberQuery, notify, selected, tab]);
  useEffect(() => {
    const memberId = selected?.memberId ?? "";
    if (!memberId) return;
    let active = true;
    void requestJson<{ benefits: MemberBenefits }>(`/api/admin/member-benefits?memberId=${encodeURIComponent(memberId)}`)
      .then((data) => { if (active) setReservationBenefits(data.benefits); })
      .catch((error) => { if (active) notify(error instanceof Error ? error.message : "회원 혜택을 불러오지 못했습니다.", "error"); });
    return () => { active = false; };
  }, [notify, selected?.memberId]);

  const sorted = useMemo(() => [...reservations].sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime) || (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9)), [reservations]);
  const todaySummary = analytics?.days.find((day) => day.key === date);
  const running = status?.rooms.filter((room) => room.status === "running") ?? [];
  const nowTime = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const upcoming = sorted.filter((item) => item.status === "booked" && item.scheduledTime >= nowTime).slice(0, 5);
  const unpaid = sorted.filter((item) => item.status !== "cancelled" && item.paymentStatus !== "paid");
  const reservationDetailItems = sorted.filter((item) => {
    if (reservationDetailFilter === "unpaid") return item.status !== "cancelled" && item.paymentStatus !== "paid";
    if (reservationDetailFilter === "arrived") return item.status === "arrived";
    if (reservationDetailFilter === "unassigned") return item.status !== "cancelled" && !item.roomCode;
    if (reservationDetailFilter === "cancelled") return item.status === "cancelled";
    return true;
  });
  const passPurchaseCreditReservation = selected?.id === passPurchaseCreditReservationId ? selected : null;
  const passPurchaseCreditReservations = linkedPaidGameReservations(passPurchaseCreditReservation, reservations);
  const passPurchaseCreditCandidates = toPassCreditCandidates(passPurchaseCreditReservations);
  const passPurchaseCreditMaximums = (memberBenefits?.products ?? []).map((product) =>
    Math.min(product.uses, maxPassCreditUses(passPurchaseCreditCandidates, product.ageGroup, product.regularUnitPrice))
  );
  const passPurchaseCreditMaxUses = Math.max(1, Math.min(20, Math.max(0, ...passPurchaseCreditMaximums)));
  const addOnCatalog = [
    { code: "slush", name: "슬러시", price: pricing.slushPrice, fixed: true },
    { code: "beverage", name: "음료수", price: pricing.beveragePrice, fixed: true },
    { code: "other", name: "양말", price: pricing.otherPrice, fixed: true },
    ...pricing.extraAddOnItems.filter((item) => item.active).map((item) => ({ ...item, fixed: false })),
  ];
  const addOnTotal =
    addOnCounts.slush * pricing.slushPrice +
    addOnCounts.beverage * pricing.beveragePrice +
    addOnCounts.other * pricing.otherPrice +
    pricing.extraAddOnItems.reduce((sum, item) => sum + (item.active ? (addOnExtraCounts[item.code] ?? 0) * item.price : 0), 0);
  const paymentDayTotals = {
    deposit: todaySummary?.gameDeposit ?? 0,
    card: todaySummary?.card ?? 0,
    cash: todaySummary?.cash ?? 0,
    account: todaySummary?.account ?? 0,
    total: todaySummary?.revenue ?? 0,
    addOn: todaySummary?.addOnRevenue ?? 0,
  };

  async function createAddOnPayment() {
    if (addOnTotal < 1) return;
    setAddOnBusy(true);
    try {
      const result = await requestJson<{ reservation: ReservationRecord }>("/api/admin/add-on-sales", {
        method: "POST",
        body: JSON.stringify({
          date,
          ...addOnCounts,
          items: pricing.extraAddOnItems
            .filter((item) => item.active && (addOnExtraCounts[item.code] ?? 0) > 0)
            .map((item) => ({ code: item.code, quantity: addOnExtraCounts[item.code] })),
        }),
      });
      setAddOnReservation(result.reservation);
      notify("부가매출 결제건을 만들었습니다. 결제수단을 선택해주세요.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "부가매출 결제건을 만들지 못했습니다.", "error");
    } finally {
      setAddOnBusy(false);
    }
  }

  async function cancelAddOnPayment() {
    if (!addOnReservation || addOnBusy) return;
    setAddOnBusy(true);
    try {
      await requestJson("/api/admin/add-on-sales", {
        method: "DELETE",
        body: JSON.stringify({ reservationId: addOnReservation.id }),
      });
      setAddOnReservation(null);
      notify("부가매출 결제 준비를 취소했습니다.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "결제 준비를 취소하지 못했습니다.", "error");
    } finally {
      setAddOnBusy(false);
    }
  }

  async function cancelHistoryPayment(item: PaymentHistoryItem) {
    setPaymentHistoryBusy(item.paymentId);
    try {
      await requestJson("/api/admin/payments", {
        method: "POST",
        body: JSON.stringify({
          action: "cancel_all",
          reservationId: item.reservationId,
          requestKey: `history-cancel:${item.paymentId}:${Date.now()}`,
        }),
      });
      notify("결제 취소를 요청했습니다.");
      await loadPaymentHistory(true);
      window.setTimeout(() => void loadPaymentHistory(true), 1800);
      window.setTimeout(() => void loadPaymentHistory(true), 5000);
      await load(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "결제를 취소하지 못했습니다.", "error");
    } finally {
      setPaymentHistoryBusy("");
    }
  }

  async function deleteHistoryPayment(item: PaymentHistoryItem) {
    setPaymentHistoryBusy(item.paymentId);
    try {
      await requestJson("/api/admin/payments", {
        method: "DELETE",
        body: JSON.stringify({ reservationId: item.reservationId }),
      });
      notify("취소된 결제 내역을 삭제했습니다.");
      await Promise.all([loadPaymentHistory(true), load(true)]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "결제 내역을 삭제하지 못했습니다.", "error");
    } finally {
      setPaymentHistoryBusy("");
    }
  }

  function openReservationDetails(reservation: ReservationRecord) {
    setSelected(reservation);
    setRemoteSelection({
      time: reservation.scheduledTime,
      roomCode: reservation.roomCode,
      reservation,
    });
    setMemberLinkOpen(false);
    setMemberQuery("");
  }

  function openPaymentReservation(item: PaymentHistoryItem) {
    const reservation = reservations.find((candidate) => candidate.id === item.reservationId);
    if (!reservation) {
      notify("예약 정보를 찾지 못했습니다. 운영 날짜를 확인한 뒤 새로고침해주세요.", "error");
      return;
    }
    openReservationDetails(reservation);
  }

  async function moveReservationTo(reservation: ReservationRecord, scheduledTime: string, roomCode: string) {
    await requestJson("/api/admin/reservations", {
      method: "PATCH",
      body: JSON.stringify({ id: reservation.id, action: "move", scheduledDate: date, scheduledTime, roomCode }),
    });
    notify(`${scheduledTime} ${roomName(roomCode)}으로 이동했습니다.`);
    await load(true);
  }

  async function copyReservationTo(reservation: ReservationRecord, scheduledTime: string, roomCode: string) {
    await requestJson("/api/admin/reservations", {
      method: "POST",
      body: JSON.stringify({ copyFromId: reservation.id, scheduledDate: date, scheduledTime, roomCode }),
    });
    notify(`${scheduledTime} ${roomName(roomCode)}에 복사했습니다.`);
    await load(true);
  }

  async function changeArrivalFromSchedule(
    reservation: ReservationRecord,
    action: "arrive" | "undo_arrive",
  ) {
    await requestJson("/api/admin/reservations", {
      method: "PATCH",
      body: JSON.stringify({ id: reservation.id, action }),
    });
    notify(action === "arrive" ? "입장 처리했습니다." : "입장 처리를 원복했습니다.");
    await load(true);
  }

  async function commitReservationChange(change: ReservationListChange) {
    setReservations((current) => {
      const changedId = change.type === "upsert" ? change.reservation.id : change.id;
      const next = current.filter((item) => item.id !== changedId);
      if (change.type === "upsert" && change.reservation.scheduledDate === date) next.push(change.reservation);
      return next.sort((left, right) => left.scheduledTime.localeCompare(right.scheduledTime));
    });
    setTodayReservations((current) => {
      const changedId = change.type === "upsert" ? change.reservation.id : change.id;
      const next = current.filter((item) => item.id !== changedId);
      if (change.type === "upsert" && change.reservation.scheduledDate === initialDate) next.push(change.reservation);
      return next.sort((left, right) => left.scheduledTime.localeCompare(right.scheduledTime));
    });
    if (change.type === "upsert") {
      setSelected((current) => current?.id === change.reservation.id ? change.reservation : current);
      setRemoteSelection((current) => current?.reservation?.id === change.reservation.id
        ? { time: change.reservation.scheduledTime, roomCode: change.reservation.roomCode, reservation: change.reservation }
        : current);
    } else {
      setSelected((current) => current?.id === change.id ? null : current);
      setRemoteSelection((current) => current?.reservation?.id === change.id ? null : current);
    }
    await load(true);
  }

  async function sendControl(room: Room | null, action: ControlAction) {
    const informationOnly = action === "start" && manualStartMode;
    if (action === "start" && room && !informationOnly && !window.confirm(`${room.name}의 ${room.teamName} 팀 게임을 시작할까요?\n16:00부터 카운트다운됩니다.`)) return;
    if (action === "stop" && room && !window.confirm(`${room.name} 게임을 정지할까요?`)) return;
    if (action === "all_stop" && !window.confirm("현재 진행 중인 모든 게임을 정지할까요?")) return;

    const roomId = action === "all_stop" ? "ALL" : room?.roomId ?? "";
    setControlBusy(`${roomId}:${action}`);
    setControlNotice("");
    try {
      await requestJson("/api/commands", {
        method: "POST",
        body: JSON.stringify({
          roomId,
          action: informationOnly ? "set_info" : action,
          teamName: room?.teamName ?? "",
          mapIndex: informationOnly ? 0 : room?.mapIndex ?? 0,
          people: 0,
          skipPeople: true,
          durationMinutes: GAME_DURATION_MINUTES,
        }),
      });
      setControlNotice(action === "all_stop" ? "전체 정지 명령을 보냈습니다." : informationOnly ? `${room?.name} 팀명만 빠르게 입력했습니다. 매장에서 난이도를 선택하고 시작 버튼을 눌러주세요.` : `${room?.name} ${action === "start" ? "시작" : "정지"} 명령을 보냈습니다.`);
      window.setTimeout(() => void refreshStatus(), 650);
      window.setTimeout(() => void refreshStatus(), 1_500);
    } catch (error) {
      setControlNotice(error instanceof Error ? error.message : "원격 명령을 보내지 못했습니다.");
    } finally {
      setControlBusy("");
    }
  }

  function openRoomReservation(roomCode: string) {
    const nowTime = timeInSeoul();
    const [nowHour, nowMinute] = nowTime.split(":").map(Number);
    const nowTotal = nowHour * 60 + nowMinute;
    const todayItems = (date === initialDate ? reservations : todayReservations)
      .filter((reservation) => reservation.roomCode === roomCode && reservation.status !== "cancelled" && reservation.status !== "completed")
      .map((reservation) => {
        const [hour, minute] = reservation.scheduledTime.split(":").map(Number);
        return { reservation, startsAt: hour * 60 + minute };
      })
      .sort((left, right) => left.startsAt - right.startsAt);
    const match = todayItems.find((item) => item.startsAt <= nowTotal && nowTotal < item.startsAt + SLOT_INTERVAL_MINUTES)
      ?? todayItems.find((item) => item.startsAt >= nowTotal)
      ?? todayItems.at(-1);

    setDate(initialDate);
    if (match) {
      openReservationDetails(match.reservation);
      setControlNotice(`${roomName(roomCode)} 예약 관리창을 열었습니다. 정보 확인 후 바로 시작하세요.`);
      return;
    }
    const currentSlot = OPERATING_SLOTS.find((time, index) => {
      const [hour, minute] = time.split(":").map(Number);
      const startsAt = hour * 60 + minute;
      const next = OPERATING_SLOTS[index + 1];
      const nextStartsAt = next ? Number(next.slice(0, 2)) * 60 + Number(next.slice(3, 5)) : startsAt + SLOT_INTERVAL_MINUTES;
      return startsAt <= nowTotal && nowTotal < nextStartsAt;
    }) ?? OPERATING_SLOTS.find((time) => {
      const [hour, minute] = time.split(":").map(Number);
      return hour * 60 + minute >= nowTotal;
    }) ?? OPERATING_SLOTS[0];
    setSelected(null);
    setRemoteSelection({ time: currentSlot, roomCode });
    setControlNotice("등록된 예약이 없어 현재 시간의 새 예약 입력창을 열었습니다.");
  }

  function openCopiedReservation(reservation: ReservationRecord) {
    setDate(reservation.scheduledDate);
    openReservationDetails(reservation);
  }

  function selectScheduleCell(selection: ScheduleSelection) {
    if (selection.reservation) {
      openReservationDetails(selection.reservation);
      return;
    }
    setSelected(null);
    setNewSlot({ time: selection.time, roomCode: selection.roomCode });
  }

  async function createReservationFromSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newSlot) return;
    const data = new FormData(event.currentTarget);
    try {
      const result = await requestJson<{ reservation: ReservationRecord }>("/api/admin/reservations", {
        method: "POST",
        body: JSON.stringify({
          scheduledDate: date,
          scheduledTime: newSlot.time,
          roomCode: newSlot.roomCode,
          teamName: data.get("teamName"),
          difficultyCode: data.get("difficultyCode"),
          adultCount: Number(data.get("adultCount") ?? 0),
          youthCount: Number(data.get("youthCount") ?? 0),
          vehicleLast4: data.get("vehicleLast4"),
          memo: data.get("memo"),
        }),
      });
      setNewSlot(null);
      notify("예약을 입력했습니다.");
      await load(true);
      openReservationDetails(result.reservation);
    } catch (error) {
      notify(error instanceof Error ? error.message : "예약을 입력하지 못했습니다.", "error");
    }
  }

  async function loadBenefits(memberId: string) {
    return (await requestJson<{ benefits: MemberBenefits }>(`/api/admin/member-benefits?memberId=${encodeURIComponent(memberId)}`)).benefits;
  }

  async function openMember(id: string) {
    try {
      const [memberData, benefits] = await Promise.all([
        requestJson<{ member: MemberDetail }>(`/api/admin/members?id=${encodeURIComponent(id)}`),
        loadBenefits(id),
      ]);
      setSelectedMember(memberData.member);
      setMemberBenefits(benefits);
    }
    catch (error) { notify(error instanceof Error ? error.message : "회원 정보를 불러오지 못했습니다.", "error"); }
  }

  async function refreshBenefits(memberId: string) {
    const benefits = await loadBenefits(memberId);
    if (selectedMember?.id === memberId) setMemberBenefits(benefits);
    if (selected?.memberId === memberId) setReservationBenefits(benefits);
    return benefits;
  }

  function activePassUsesForReservation(benefits: MemberBenefits, reservationId: string) {
    const restored = new Set(
      benefits.passHistory
        .filter((item) => item.type === "RESTORE" && item.reference_id)
        .map((item) => item.reference_id as string),
    );
    return benefits.passHistory
      .filter((item) => item.type === "USE" && item.reservation_id === reservationId && !restored.has(item.id))
      .reduce((total, item) => total + Math.abs(Number(item.uses) || 0), 0);
  }

  async function openPassPurchaseForReservation(usePaidGameCredit: boolean) {
    if (!selected?.memberId) return;
    try {
      const [memberData, benefits] = await Promise.all([
        requestJson<{ member: MemberDetail }>(`/api/admin/members?id=${encodeURIComponent(selected.memberId)}`),
        loadBenefits(selected.memberId),
      ]);
      setSelectedMember(memberData.member);
      setMemberBenefits(benefits);
      setPassPurchaseReservation(null);
      setPassPurchaseOrder(null);
      setPassPurchaseCreditReservationId(usePaidGameCredit ? selected.id : "");
      const linkedReservations = usePaidGameCredit ? linkedPaidGameReservations(selected, reservations) : [];
      const creditCandidates = toPassCreditCandidates(linkedReservations);
      const maximumUses = Math.max(1, ...benefits.products.map((product) =>
        Math.min(product.uses, maxPassCreditUses(creditCandidates, product.ageGroup, product.regularUnitPrice))
      ));
      setPassPurchaseCreditUses(usePaidGameCredit ? maximumUses : 1);
      setPassPurchaseOpen(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "다회권 구매 화면을 열지 못했습니다.", "error");
    }
  }

  async function beginPassPurchase(productCode: string) {
    if (!selectedMember) return;
    const product = memberBenefits?.products.find((item) => item.code === productCode);
    const maximumProductUses = product
      ? Math.min(product.uses, maxPassCreditUses(passPurchaseCreditCandidates, product.ageGroup, product.regularUnitPrice))
      : passPurchaseCreditUses;
    const creditUses = passPurchaseCreditReservation
      ? Math.min(passPurchaseCreditUses, maximumProductUses)
      : passPurchaseCreditUses;
    setBenefitBusy(`purchase:${productCode}`);
    try {
      const result = await requestJson<{ order: PassPurchaseOrder; reservation: ReservationRecord; benefits: MemberBenefits }>("/api/admin/member-benefits", {
        method: "POST",
        body: JSON.stringify({
          action: "create_purchase",
          memberId: selectedMember.id,
          productCode,
          creditReservationId: passPurchaseCreditReservationId || null,
          creditUses,
        }),
      });
      setMemberBenefits(result.benefits);
      setPassPurchaseReservation(result.reservation);
      setPassPurchaseOrder(result.order);
      notify("다회권 결제 주문을 만들었습니다.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "다회권 주문을 만들지 못했습니다.", "error");
    } finally {
      setBenefitBusy("");
    }
  }

  async function redeemPass(pass: MemberPass, reservationId: string | null, requestedUses = 1) {
    const uses = Math.max(1, Math.min(pass.remainingUses, Math.trunc(requestedUses) || 1));
    if (!window.confirm(`${pass.productName}\n현재 ${pass.remainingUses}회 남음\n${uses}회를 사용하시겠어요?`)) return;
    setBenefitBusy(`use:${pass.id}`);
    try {
      const result = await requestJson<{ benefits: MemberBenefits }>("/api/admin/member-benefits", {
        method: "POST",
        body: JSON.stringify({ action: "use_pass", memberId: selectedMember?.id ?? selected?.memberId, memberPassId: pass.id, reservationId, uses }),
      });
      if (selectedMember?.id) setMemberBenefits(result.benefits);
      if (selected?.memberId) setReservationBenefits(result.benefits);
      if (reservationId) await load(true);
      notify(`다회권 ${uses}회를 사용했습니다.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "다회권을 사용하지 못했습니다.", "error");
    } finally {
      setBenefitBusy("");
    }
  }

  async function restorePass(ledgerId: string, memberId: string, uses = 1) {
    if (!window.confirm(`이 다회권 사용을 취소하고 ${uses}회를 복구할까요?`)) return;
    setBenefitBusy(`restore:${ledgerId}`);
    try {
      const result = await requestJson<{ benefits: MemberBenefits }>("/api/admin/member-benefits", { method: "POST", body: JSON.stringify({ action: "restore_pass", ledgerId }) });
      setMemberBenefits(result.benefits);
      if (selected?.memberId === memberId) setReservationBenefits(result.benefits);
      await load(true);
      notify(`다회권 ${uses}회를 복구했습니다.`);
    } catch (error) { notify(error instanceof Error ? error.message : "다회권을 복구하지 못했습니다.", "error"); }
    finally { setBenefitBusy(""); }
  }

  async function stampAction(
    action: "use_stamp" | "cancel_stamp" | "adjust_stamp" | "grant_weekday_coupon" | "cancel_coupon",
    options: Record<string, unknown> = {},
    memberId = selectedMember?.id ?? selected?.memberId ?? "",
  ) {
    if (!memberId) return;
    setBenefitBusy(action);
    try {
      const result = await requestJson<{ benefits: MemberBenefits }>("/api/admin/member-benefits", { method: "POST", body: JSON.stringify({ action, memberId, ...options }) });
      if (selectedMember?.id === memberId) setMemberBenefits(result.benefits);
      if (selected?.memberId === memberId) setReservationBenefits(result.benefits);
      notify(action === "grant_weekday_coupon" ? "평일 이용 쿠폰을 발급했습니다." : action === "cancel_coupon" ? "쿠폰을 회수했습니다." : action === "use_stamp" ? "스탬프 혜택을 사용했습니다." : action === "cancel_stamp" ? "스탬프 사용을 취소했습니다." : "스탬프를 조정했습니다.");
    } catch (error) { notify(error instanceof Error ? error.message : "회원 혜택을 처리하지 못했습니다.", "error"); }
    finally { setBenefitBusy(""); }
  }

  async function linkMember(memberId: string | null) {
    if (!selected) return;
    try {
      const result = await requestJson<{ linked: boolean; reservation: ReservationRecord }>("/api/admin/members", { method: "PATCH", body: JSON.stringify({ action: memberId ? "link" : "unlink", reservationId: selected.id, memberId }) });
      if (result.reservation) {
        setSelected(result.reservation);
        setRemoteSelection((current) => current ? { ...current, reservation: result.reservation } : current);
      }
      notify(memberId ? "예약과 회원을 연결했습니다." : "회원 연결을 해제했습니다."); await load(true);
    } catch (error) { notify(error instanceof Error ? error.message : "회원 연결에 실패했습니다.", "error"); }
  }

  async function createMemberFromForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = await requestJson<{ member: MemberDetail }>("/api/admin/members", { method: "POST", body: JSON.stringify({
        name: data.get("name"), phone: data.get("phone"), birthday: data.get("birthday"),
        teamName: data.get("teamName"), email: data.get("email"), vehicleNumber: data.get("vehicleNumber"),
        memo: data.get("memo"),
      }) });
      setMemberFormOpen(false); setSelectedMember(result.member); setMemberBenefits(await loadBenefits(result.member.id)); notify("회원을 등록했습니다.");
      if (selected) await linkMember(result.member.id);
      setMemberQuery("");
    } catch (error) { notify(error instanceof Error ? error.message : "회원을 등록하지 못했습니다.", "error"); }
  }

  async function updateMemberFromForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMember) return;
    const data = new FormData(event.currentTarget);
    try {
      const result = await requestJson<{ member: MemberDetail }>("/api/admin/members", {
        method: "PATCH",
        body: JSON.stringify({
          action: "update", id: selectedMember.id,
          name: data.get("name"), phone: data.get("phone"), birthday: data.get("birthday"),
          teamName: data.get("teamName"), email: data.get("email"), vehicleNumber: data.get("vehicleNumber"),
          memo: data.get("memo"),
        }),
      });
      setSelectedMember(result.member);
      setMembers((current) => sortMembersByName(current.map((member) => member.id === result.member.id ? result.member : member)));
      setMemberEditOpen(false);
      notify("회원 기본정보를 수정했습니다.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "회원 정보를 수정하지 못했습니다.", "error");
    }
  }

  const headerAction = <div className="pos-top-actions"><label className={`pos-manual-start ${manualStartMode ? "is-enabled" : ""}`}><input type="checkbox" checked={manualStartMode} onChange={(event) => { setManualStartMode(event.target.checked); setControlNotice(event.target.checked ? "수동 시작 모드: 게임 시작 버튼은 팀명만 빠르게 입력합니다." : "원격 시작 모드: 게임 시작 버튼이 16분 카운트다운을 시작합니다."); }} /><span>매장 수동 시작</span></label><span className={`pos-connection ${status?.store.agentOnline ? "is-online" : ""}`}>{status?.store.agentOnline ? "매장 연결" : "연결 확인"}</span><input aria-label="운영 날짜" type="date" value={date} onChange={(event) => setDate(event.target.value)} /><Button className="pos-refresh-button" onClick={() => void load(true)} disabled={refreshing}>{refreshing ? "새로고침 중" : "새로고침"}</Button></div>;

  return <main className="pos-shell">
    <aside className="pos-sidebar"><div className="pos-brand"><b>JB</b><div><strong>Jumping Battle</strong><span>POS V2 · {operatorName}</span></div></div><nav>{NAV.map((item) => <button className={tab === item.key ? "is-active" : ""} key={item.key} onClick={() => setTab(item.key)}><i>{item.icon}</i><span>{item.label}</span></button>)}</nav><Link href="/admin">기존 통합 운영 관리</Link></aside>
    <div className="pos-workspace">
      {tab === "home" && <><PageHeader eyebrow="TODAY" title="오늘 운영" action={headerAction} />
        <div className="pos-summary-grid"><SummaryCard label="예약 팀" value={`${sorted.filter((item) => item.status !== "cancelled").length}팀`} caption={`${todaySummary?.people ?? 0}명`} tone="accent" /><SummaryCard label="진행 중" value={`${running.length}게임`} caption={status?.store.agentOnline ? "브릿지 정상" : "연결 확인 필요"} tone={status?.store.agentOnline ? "good" : "default"} /><SummaryCard label="오늘 매출" value={money(todaySummary?.revenue ?? 0)} caption={`결제 대기 ${unpaid.length}건`} /></div>
        <div className={`pos-v2-control-stack ${controlPinned ? "is-control-pinned" : ""}`}>
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
            onTogglePin={() => setControlPinned((current) => !current)}
          />
        </div>
        <div className="pos-two-column"><SectionCard title="다음 예약" description="가까운 순서로 확인하세요" action={<Button tone="ghost" onClick={() => setTab("reservations")}>전체 보기</Button>}>{loading ? <Skeleton /> : upcoming.length ? <div className="pos-reservation-list compact">{upcoming.map((item) => <PosReservationCard reservation={item} onOpen={() => openReservationDetails(item)} key={item.id} />)}</div> : <EmptyState title="예정된 예약이 없습니다." />}</SectionCard>
        <SectionCard title="빠른 실행"><div className="pos-quick-grid"><button onClick={() => setTab("reservations")}>예약 확인<span>방별·시간대별 예약과 입장 처리</span></button><button onClick={() => setTab("payments")}>결제 처리<span>미결제·카드 승인</span></button><button onClick={() => { setTab("members"); setMemberFormOpen(true); }}>회원 등록<span>전화번호로 빠르게 등록</span></button><Link href="/admin#live-control">게임 제어<span>기존 원격제어 열기</span></Link></div></SectionCard></div>
      </>}

      {tab === "reservations" && <>
        <PageHeader eyebrow="RESERVATIONS" title="예약" action={headerAction} />
        {loading ? <SectionCard><Skeleton count={5} /></SectionCard> : <div className="pos-v2-schedule">
          <ScheduleBoard
            selectedDate={date}
            today={initialDate}
            reservations={reservations}
            onSelect={selectScheduleCell}
            onMove={moveReservationTo}
            onCopy={copyReservationTo}
            onStatusChange={changeArrivalFromSchedule}
            cancellationFeeAmount={pricing.naverCancellationFeeAmount}
          />
        </div>}
        <section className={`reservation-detail-panel pos-v2-reservation-details ${reservationDetailOpen ? "" : "is-collapsed"}`}>
          <div className="integrated-section-heading">
            <div><p className="eyebrow">RESERVATION DETAILS</p><h2>예약·결제 상세 관리</h2><p>기존 상세 관리 기능을 그대로 사용하며, 시간표에서 선택한 예약은 위 예약 상세창에서 수정합니다.</p></div>
            <button type="button" className="reservation-detail-toggle" aria-expanded={reservationDetailOpen} aria-controls="pos-v2-reservation-detail-content" onClick={() => setReservationDetailOpen((current) => !current)}><span>{reservationDetailOpen ? "상세 관리 접기" : "상세 관리 펼치기"}</span><b aria-hidden="true">{reservationDetailOpen ? "⌃" : "⌄"}</b></button>
          </div>
          <div id="pos-v2-reservation-detail-content" className="reservation-detail-content" hidden={!reservationDetailOpen}>
            <div className="booking-filter-row" role="group" aria-label="예약 필터">
              {([[
                "all", `전체 ${reservations.length}`,
              ], ["unpaid", `미결제 ${unpaid.length}`], ["arrived", "입장"], ["unassigned", "미배정"], ["cancelled", "취소"]] as Array<[typeof reservationDetailFilter, string]>).map(([value, label]) => <button key={value} type="button" className={reservationDetailFilter === value ? "is-active" : ""} onClick={() => setReservationDetailFilter(value)}>{label}</button>)}
            </div>
            <div className="booking-list" aria-live="polite">
              {reservationDetailItems.length ? reservationDetailItems.map((reservation) => <ReservationDetailCard key={reservation.id} reservation={reservation} manualStartMode={manualStartMode} onChanged={commitReservationChange} onEdit={() => openReservationDetails(reservation)} onOpenCopied={openCopiedReservation} pricing={pricing} />) : <EmptyState title="조건에 맞는 예약이 없습니다." />}
            </div>
          </div>
        </section>
      </>}

      {tab === "payments" && <>
        <PageHeader eyebrow="PAYMENTS" title="결제 내역" action={headerAction} />
        <div className="pos-summary-grid pos-payment-summary-grid">
          <SummaryCard label="예약금" value={money(paymentDayTotals.deposit)} caption="네이버 선결제·당일 취소" />
          <SummaryCard label="카드" value={money(paymentDayTotals.card)} />
          <SummaryCard label="현금" value={money(paymentDayTotals.cash)} />
          <SummaryCard label="계좌" value={money(paymentDayTotals.account)} />
          <SummaryCard label="총매출" value={money(paymentDayTotals.total)} caption={`${date} 기준`} tone="accent" />
        </div>
        <div className="pos-payment-layout">
          <SectionCard title="부가매출 결제" description="운영 가격 설정의 상품 수량을 입력하고 카드·현금·계좌로 결제합니다." action={<div className="pos-add-on-daily-total"><span>당일 결제 누계</span><strong>{money(paymentDayTotals.addOn)}</strong></div>}>
            {!addOnReservation ? <div className="pos-add-on-checkout">
              <div className="pos-add-on-toolbar"><span>상품과 단가는 운영 가격 설정에서 관리합니다.</span><Link href="/admin/settings">항목 추가·가격 설정</Link></div>
              <div className="pos-add-on-items">
                {addOnCatalog.map((item) => {
                  const quantity = item.fixed
                    ? addOnCounts[item.code as keyof typeof addOnCounts]
                    : addOnExtraCounts[item.code] ?? 0;
                  return <label key={item.code}><span><b>{item.name}</b><small>{money(item.price)}</small></span><input aria-label={`${item.name} 수량`} type="number" min="0" max="99" value={quantity} onChange={(event) => {
                    const next = Math.max(0, Math.min(99, Math.trunc(Number(event.target.value) || 0)));
                    if (item.fixed) setAddOnCounts((current) => ({ ...current, [item.code]: next }));
                    else setAddOnExtraCounts((current) => ({ ...current, [item.code]: next }));
                  }} /></label>;
                })}
              </div>
              <div className="pos-add-on-total"><span>결제금액</span><strong>{money(addOnTotal)}</strong></div>
              <Button tone="primary" disabled={addOnBusy || addOnTotal < 1} onClick={() => void createAddOnPayment()}>{addOnBusy ? "준비 중" : "결제 시작"}</Button>
            </div> : <div className="pos-add-on-payment-ready">
              <div><span>결제 상품</span><strong>{addOnReservation.teamName}</strong><b>{money(addOnReservation.paymentAmount)}</b></div>
              <div className="pos-add-on-ready-actions"><Button tone="ghost" disabled={addOnBusy} onClick={() => void cancelAddOnPayment()}>{addOnBusy ? "취소 중" : "결제 준비 취소·이전"}</Button></div>
              <TerminalPaymentControls reservation={addOnReservation} amount={addOnReservation.paymentAmount} addOnAmount={0} discountAmount={0} pricing={pricing} disabled={false} autoResetOnCompleted onSettled={async () => {
                setAddOnCounts({ slush: 0, beverage: 0, other: 0 });
                setAddOnExtraCounts({});
                setAddOnReservation(null);
                await Promise.all([loadPaymentHistory(true), load(true)]);
                notify("부가매출 결제를 반영했습니다.");
              }} />
            </div>}
          </SectionCard>
          <SectionCard title="결제 원장" description="완료된 결제와 취소 내역입니다. 승인 거래는 먼저 취소한 뒤 삭제할 수 있습니다.">
            <div className="pos-toolbar"><input className="pos-search" placeholder="이름, 팀명, 예약번호, 승인번호 검색" value={paymentHistoryQuery} onChange={(event) => setPaymentHistoryQuery(event.target.value)} /><Button onClick={() => void loadPaymentHistory()} disabled={paymentHistoryLoading}>{paymentHistoryLoading ? "조회 중" : "새로고침"}</Button></div>
            {paymentHistoryLoading ? <Skeleton count={4} /> : paymentHistory.length ? <div className="pos-payment-history-list">{paymentHistory.map((item) => <PaymentHistoryCard key={item.paymentId} item={item} busy={paymentHistoryBusy === item.paymentId} onOpen={() => openPaymentReservation(item)} onCancel={() => setPaymentConfirm({ mode: "cancel", item })} onDelete={() => setPaymentConfirm({ mode: "delete", item })} />)}</div> : <EmptyState title="선택한 날짜의 결제 내역이 없습니다." />}
          </SectionCard>
        </div>
      </>}

      {tab === "members" && <>
        <PageHeader eyebrow="MEMBERS" title="회원" action={<Button tone="primary" onClick={() => { setMemberFormOpen(true); window.setTimeout(() => memberNameRef.current?.focus(), 50); }}>+ 회원 등록</Button>} />
        <SectionCard className="pos-list-card">
          <div className="pos-toolbar"><input className="pos-search" placeholder="이름, 팀명, 전화번호, 이메일, 차량번호 검색" value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} /><b className="pos-member-count">{memberLoading ? "조회 중" : `${members.length}명`}</b></div>
          {memberLoading ? <Skeleton count={5} /> : members.length ? <div className="pos-member-list">{members.map((member) => <button key={member.id} onClick={() => void openMember(member.id)}><div className="pos-member-avatar">{member.name.slice(0,1)}</div><div><strong>{member.name}{member.teamName ? ` · ${member.teamName}` : ""}</strong><span>{member.phone}{member.vehicleNumber ? ` · 차량 ${member.vehicleNumber}` : ""}</span><small>{member.email || (member.lastVisit ? `최근 방문 ${member.lastVisit.replace("T", " ")}` : "방문 기록 없음")}</small></div><div><b>{member.visitCount}회</b><span>{money(member.totalSpent)}</span></div></button>)}</div> : <EmptyState title="검색 결과가 없습니다." description="이름·팀명·전화번호·이메일·차량번호를 확인하세요." />}
        </SectionCard>
      </>}

      {tab === "more" && <>
        <PageHeader eyebrow="MORE" title="더보기" action={headerAction} />
        <div className="pos-more-grid"><Link href="/admin"><b>통합 운영 관리</b><span>전체 시간표·원격제어·공용 부가매출</span></Link><Link href="/admin/kiosk"><b>키오스크 운영</b><span>홀드·준비·게임 시작 상태 관리</span></Link><Link href="/admin/analytics"><b>매출 분석</b><span>일·월·시간대별 매출</span></Link><Link href="/admin/game-history"><b>게임 기록</b><span>점수·레벨·팀 기록 검색</span></Link><Link href="/admin/notifications"><b>매출 알림</b><span>브리핑 시간과 스마트폰 알림</span></Link><Link href="/admin/settings"><b>운영 설정</b><span>성인 {money(pricing.adultPrice)} · 청소년 {money(pricing.youthPrice)}</span></Link><Link href="/admin/schedule"><b>시간표 크게 보기</b><span>전체 예약 현황 전용 화면</span></Link></div>
      </>}
    </div>

    <nav className="pos-mobile-nav">{NAV.map((item) => <button className={tab === item.key ? "is-active" : ""} key={item.key} onClick={() => setTab(item.key)}><i>{item.icon}</i><span>{item.label}</span></button>)}</nav>

    {remoteSelection ? <QuickBookingModal
      key={`${remoteSelection.time}|${remoteSelection.roomCode}|${remoteSelection.reservation?.id ?? "new"}|${remoteSelection.reservation?.memberId ?? ""}|${remoteSelection.reservation?.vehicleLast4 ?? ""}|${remoteSelection.reservation?.baseAmount ?? 0}|${remoteSelection.reservation?.addOnAmount ?? 0}|${remoteSelection.reservation?.discountAmount ?? 0}|${remoteSelection.reservation?.paymentAmount ?? 0}|${remoteSelection.reservation?.paymentStatus ?? ""}`}
      date={date}
      selection={remoteSelection}
      status={status}
      manualStartMode={manualStartMode}
      title={remoteSelection.reservation ? "예약 상세" : undefined}
      extraPanel={selected && selected.id === remoteSelection.reservation?.id ? <section className={`quick-member-panel ${memberLinkOpen ? "is-open" : ""}`}>
        <div className="quick-member-heading">
          <div><strong>회원 연결</strong><span>{selected.memberId && reservationBenefits?.member.id === selected.memberId ? `${reservationBenefits.member.name} 회원 연결됨` : "예약과 회원 혜택을 연결합니다."}</span></div>
          <button type="button" aria-expanded={memberLinkOpen} onClick={() => setMemberLinkOpen((current) => !current)}>{memberLinkOpen ? "접기 ▲" : "펼치기 ▼"}</button>
        </div>
        <div className="quick-member-search-row">
          <input className="pos-search" placeholder="이름·팀명·전화번호 바로 검색" value={memberQuery} onFocus={() => setMemberLinkOpen(true)} onChange={(event) => { setMemberQuery(event.target.value); setMemberLinkOpen(true); }} />
          {selected.memberId ? <button type="button" className="quick-member-current" onClick={() => void openMember(selected.memberId)}>회원 보기</button> : null}
        </div>
        {memberLinkOpen ? <div className="quick-member-expanded">
          {memberLoading ? <Skeleton count={2} /> : memberQuery.trim() ? <div className="pos-link-results">{members.slice(0, 6).map((member) => <button type="button" key={member.id} onClick={() => void linkMember(member.id)}><span>{member.name}{member.teamName ? ` · ${member.teamName}` : ""} · {member.phone}</span><b>{selected.memberId === member.id ? "연결됨" : "연결"}</b></button>)}</div> : <p className="quick-member-hint">위 검색창에 이름·팀명·전화번호를 입력하면 바로 연결할 회원이 표시됩니다.</p>}
          <div className="quick-member-actions"><Button type="button" onClick={() => setMemberFormOpen(true)}>+ 새 회원 등록</Button>{selected.memberId ? <Button type="button" tone="ghost" onClick={() => void linkMember(null)}>연결 해제</Button> : null}</div>
          {selected.memberId && reservationBenefits?.member.id === selected.memberId ? <div className="quick-member-benefits">
            <div className="quick-stamp-row"><div><span>스탬프</span><strong>{reservationBenefits.stampBalance}/{reservationBenefits.settings.stampGoal}</strong></div><label><span>적립 개수</span><select value={stampEarnCount} onChange={(event) => setStampEarnCount(Number(event.target.value))}>{Array.from({ length: 10 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}개</option>)}</select></label><Button type="button" tone="primary" disabled={Boolean(benefitBusy)} onClick={() => void stampAction("adjust_stamp", { amount: stampEarnCount, reason: `관리자 수동 적립 ${stampEarnCount}개` }, selected.memberId)}>스탬프 적립</Button></div>
            <div className="quick-coupon-summary"><span>사용 가능 쿠폰</span><strong>{reservationBenefits.coupons.filter((coupon) => coupon.status === "ACTIVE").length}장</strong><small>{reservationBenefits.coupons.filter((coupon) => coupon.status === "ACTIVE").map((coupon) => coupon.name).join(" · ") || "없음"}</small></div>
            <div className="pos-pass-list">{reservationBenefits.passes.filter((pass) => pass.status === "ACTIVE" && pass.remainingUses > 0).map((pass) => {
              const activeUses = activePassUsesForReservation(reservationBenefits, selected.id);
              const maxUses = Math.min(pass.remainingUses, Math.max(0, selected.totalCount - activeUses));
              const requestedUses = Math.min(maxUses || 1, Math.max(1, passUseCounts[pass.id] ?? 1));
              const quote = quotePassUse({ baseAmount: selected.baseAmount, addOnAmount: selected.addOnAmount, discountAmount: selected.discountAmount, regularUnitPrice: pass.regularUnitPrice, uses: requestedUses });
              return <article key={pass.id}><div><strong>{pass.productName}</strong><span>{pass.remainingUses}/{pass.purchasedUses}회 남음 · 1회 {money(pass.regularUnitPrice)}</span><small>{requestedUses}회 차감 후 현장 결제 {money(quote.paymentAmount)}</small></div><div className="pos-pass-use-controls"><label><span>차감</span><select value={requestedUses} disabled={maxUses < 1 || Boolean(benefitBusy)} onChange={(event) => setPassUseCounts((current) => ({ ...current, [pass.id]: Number(event.target.value) }))}>{Array.from({ length: maxUses }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}회</option>)}</select></label><Button type="button" tone="primary" disabled={Boolean(benefitBusy) || selected.status === "cancelled" || maxUses < 1} onClick={() => void redeemPass(pass, selected.id, requestedUses)}>다회권으로 이용</Button></div></article>;
            })}</div>
            {!reservationBenefits.passes.some((pass) => pass.status === "ACTIVE" && pass.remainingUses > 0) ? <small className="quick-member-no-pass">사용 가능한 다회권이 없습니다.</small> : null}
            <div className="pos-pass-purchase-actions"><Button type="button" onClick={() => void openPassPurchaseForReservation(false)}>+ 다회권 구매</Button>{selected.paymentStatus === "paid" && selected.baseAmount > 0 ? <Button type="button" tone="primary" onClick={() => void openPassPurchaseForReservation(true)}>결제한 게임비 차감 후 구매</Button> : null}</div>
          </div> : null}
        </div> : null}
      </section> : null}
      onClose={() => { setRemoteSelection(null); setSelected(null); setMemberLinkOpen(false); }}
      onSaved={commitReservationChange}
      onOpenCopied={openCopiedReservation}
      onRefreshStatus={refreshStatus}
      pricing={pricing}
    /> : null}

    <BottomSheet open={memberFormOpen} title="회원 등록" onClose={() => setMemberFormOpen(false)}><form className="pos-form" onSubmit={createMemberFromForm}><label>이름<input ref={memberNameRef} name="name" defaultValue={selected?.customerName || ""} required maxLength={40} /></label><label>팀명<input name="teamName" defaultValue={selected?.teamName || ""} maxLength={80} /></label><label>전화번호<input name="phone" inputMode="tel" defaultValue={selected?.customerPhone || ""} required placeholder="010-0000-0000" /></label><label>이메일<input name="email" type="email" maxLength={160} /></label><label>차량번호<input name="vehicleNumber" maxLength={20} placeholder="전체 차량번호" /></label><label>생일 (선택)<input name="birthday" type="date" /></label><label>메모<textarea name="memo" rows={4} maxLength={1000} /></label><Button tone="primary" type="submit">회원 저장</Button></form></BottomSheet>

    <BottomSheet open={Boolean(newSlot)} title="예약 직접 입력" onClose={() => setNewSlot(null)}>{newSlot && <form className="pos-form" onSubmit={createReservationFromSchedule}>
      <div className="pos-new-slot-summary"><b>{date} · {newSlot.time}</b><span>{newSlot.roomCode ? roomName(newSlot.roomCode) : "추가·대기"}</span></div>
      <label>팀명<input name="teamName" required maxLength={10} placeholder="최대 10자" autoFocus /></label>
      <label>난이도<select name="difficultyCode" defaultValue={getDifficultyOptions(newSlot.roomCode || "C2")[1]?.code ?? getDifficultyOptions(newSlot.roomCode || "C2")[0]?.code}>{getDifficultyOptions(newSlot.roomCode || "C2").map((difficulty) => <option value={difficulty.code} key={difficulty.code}>{difficulty.label} {difficulty.stars}</option>)}</select></label>
      <div className="pos-form-columns"><label>성인<input name="adultCount" type="number" min="0" max="10" defaultValue="2" /></label><label>청소년·어린이<input name="youthCount" type="number" min="0" max="10" defaultValue="0" /></label></div>
      <label>차량번호 뒤 4자리<input name="vehicleLast4" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} placeholder="선택 입력" /></label>
      <label>메모<textarea name="memo" rows={3} maxLength={500} placeholder="현장 메모" /></label>
      <Button tone="primary" type="submit">예약 추가</Button>
    </form>}</BottomSheet>

    <BottomSheet open={Boolean(selectedMember)} title="회원 상세" onClose={() => { setSelectedMember(null); setMemberBenefits(null); setMemberEditOpen(false); }}>{selectedMember && <div className="pos-member-detail">
      <div className="pos-member-profile"><div className="pos-member-avatar">{selectedMember.name.slice(0,1)}</div><div><h2>{selectedMember.name}</h2><p>{selectedMember.teamName || "팀명 없음"} · {selectedMember.phone}</p><p>{selectedMember.email || "이메일 없음"} · 차량 {selectedMember.vehicleNumber || "없음"}</p></div></div>
      <SectionCard title="회원 기본정보" description="이름·팀명·연락처·차량번호 등 회원 정보를 관리자가 수정할 수 있습니다." action={<Button onClick={() => setMemberEditOpen((current) => !current)}>{memberEditOpen ? "수정 닫기" : "기본정보 수정"}</Button>}>
        {memberEditOpen ? <form className="pos-form" onSubmit={updateMemberFromForm}>
          <label>이름<input name="name" defaultValue={selectedMember.name} required maxLength={40} /></label>
          <label>팀명<input name="teamName" defaultValue={selectedMember.teamName} maxLength={80} /></label>
          <label>전화번호<input name="phone" inputMode="tel" defaultValue={selectedMember.phone} required placeholder="010-0000-0000" /></label>
          <label>이메일<input name="email" type="email" defaultValue={selectedMember.email} maxLength={160} /></label>
          <label>차량번호<input name="vehicleNumber" defaultValue={selectedMember.vehicleNumber} maxLength={20} placeholder="전체 차량번호" /></label>
          <label>생일 (선택)<input name="birthday" type="date" defaultValue={selectedMember.birthday} /></label>
          <label>메모<textarea name="memo" rows={4} maxLength={1000} defaultValue={selectedMember.memo} /></label>
          <Button tone="primary" type="submit">수정 내용 저장</Button>
        </form> : null}
      </SectionCard>
      <div className="pos-summary-grid"><SummaryCard label="방문" value={`${selectedMember.visitCount}회`} /><SummaryCard label="누적 결제" value={money(selectedMember.totalSpent)} /><SummaryCard label="최근 방문" value={selectedMember.lastVisit ? selectedMember.lastVisit.slice(5, 16).replace("T", " ") : "없음"} /></div>
      <SectionCard title="회원 혜택" action={<div className="pos-benefit-header-actions"><Button onClick={() => { const raw = window.prompt("발급할 평일 이용 쿠폰 수량을 입력하세요.", "1"); if (raw) void stampAction("grant_weekday_coupon", { quantity: Number(raw) }); }}>+ 평일 쿠폰</Button><Button tone="primary" onClick={() => { setPassPurchaseReservation(null); setPassPurchaseOrder(null); setPassPurchaseCreditReservationId(""); setPassPurchaseCreditUses(1); setPassPurchaseOpen(true); }}>+ 다회권 구매</Button></div>}>
        {memberBenefits ? <div className="pos-benefits">
          <article className="pos-stamp-card"><div><span>스탬프</span><strong>{memberBenefits.stampBalance} / {memberBenefits.settings.stampGoal}</strong><small>{memberBenefits.settings.stampGoal}개가 되면 자동으로 1개월 쿠폰이 발급됩니다.</small></div><div className="pos-stamp-actions"><label><span>적립</span><select value={stampEarnCount} onChange={(event) => setStampEarnCount(Number(event.target.value))}>{Array.from({ length: 10 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}개</option>)}</select></label><Button tone="primary" disabled={Boolean(benefitBusy)} onClick={() => void stampAction("adjust_stamp", { amount: stampEarnCount, reason: `관리자 수동 적립 ${stampEarnCount}개` })}>적립</Button><Button tone="ghost" disabled={Boolean(benefitBusy)} onClick={() => { const raw = window.prompt("조정할 수량을 입력하세요. 차감은 -숫자로 입력합니다.", "-1"); if (raw) void stampAction("adjust_stamp", { amount: Number(raw), reason: "관리자 수동 조정" }); }}>수량 조정</Button></div></article>
          <div className="pos-coupon-list">{memberBenefits.coupons.length ? memberBenefits.coupons.slice(0, 40).map((coupon) => <article className={`status-${coupon.status.toLowerCase()}`} key={coupon.id}><div><strong>{coupon.name}</strong><span>{coupon.status === "ACTIVE" ? "사용 가능" : coupon.status === "USED" ? "사용 완료" : coupon.status === "EXPIRED" ? "기간 만료" : "회수됨"}</span><small>발행 {coupon.issuedAt.slice(0, 10)} · 유효기간 {coupon.expiresAt.slice(0, 10)}{coupon.source === "LEGACY_JUMPINGMANAGER" ? " · 기존 회원내역" : ""}</small></div>{["ACTIVE", "EXPIRED"].includes(coupon.status) ? <Button tone="ghost" disabled={Boolean(benefitBusy)} onClick={() => window.confirm("이 쿠폰을 회수할까요?") && void stampAction("cancel_coupon", { couponId: coupon.id })}>회수</Button> : null}</article>) : <EmptyState title="보유한 쿠폰이 없습니다." />}</div>
          <div className="pos-pass-list">{memberBenefits.passes.length ? memberBenefits.passes.map((pass) => {
            const requestedUses = Math.min(pass.remainingUses || 1, Math.max(1, passUseCounts[pass.id] ?? 1));
            return <article className={`status-${pass.status.toLowerCase()}`} key={pass.id}><div><strong>{pass.productName}</strong><span>{pass.remainingUses} / {pass.purchasedUses}회 남음 · {pass.status}</span><small>구매 {pass.purchasedAt.slice(0,10)} · {pass.purchasePrice == null ? "기존 구매가 미상" : money(pass.purchasePrice)}{pass.expiresAt ? ` · ${pass.expiresAt.slice(0,10)}까지` : ""}</small></div><div className="pos-pass-use-controls"><label><span>차감</span><select value={requestedUses} disabled={pass.status !== "ACTIVE" || pass.remainingUses <= 0 || Boolean(benefitBusy)} onChange={(event) => setPassUseCounts((current) => ({ ...current, [pass.id]: Number(event.target.value) }))}>{Array.from({ length: Math.max(0, pass.remainingUses) }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}회</option>)}</select></label><Button disabled={Boolean(benefitBusy) || pass.status !== "ACTIVE" || pass.remainingUses <= 0} onClick={() => void redeemPass(pass, null, requestedUses)}>사용</Button></div></article>;
          }) : <EmptyState title="보유한 다회권이 없습니다." />}</div>
        </div> : <Skeleton />}
      </SectionCard>
      {memberBenefits?.passHistory.length ? <SectionCard title="다회권 원장"><div className="pos-benefit-history">{memberBenefits.passHistory.slice(0, 30).map((item) => <div key={item.id}><span>{item.created_at.slice(0,16).replace("T", " ")}</span><b>{item.reason || item.type} · {(item.uses ?? 0) > 0 ? "+" : ""}{item.uses ?? 0}회</b>{item.type === "USE" && !memberBenefits.passHistory.some((candidate) => candidate.type === "RESTORE" && candidate.reference_id === item.id) ? <Button tone="ghost" disabled={Boolean(benefitBusy)} onClick={() => void restorePass(item.id, selectedMember.id, Math.abs(Number(item.uses) || 1))}>사용 취소</Button> : null}</div>)}</div></SectionCard> : null}
      {memberBenefits?.stampHistory.length ? <SectionCard title="스탬프 원장"><div className="pos-benefit-history">{memberBenefits.stampHistory.slice(0, 30).map((item) => <div key={item.id}><span>{item.created_at.slice(0,16).replace("T", " ")}</span><b>{item.reason || item.type} · {(item.amount ?? 0) > 0 ? "+" : ""}{item.amount ?? 0}</b>{item.type === "USE" && !memberBenefits.stampHistory.some((candidate) => candidate.reference_key === `stamp-cancel:${item.id}`) ? <Button tone="ghost" disabled={Boolean(benefitBusy)} onClick={() => window.confirm("이 스탬프 사용을 취소할까요?") && void stampAction("cancel_stamp", { ledgerId: item.id })}>사용 취소</Button> : null}</div>)}</div></SectionCard> : null}
      <SectionCard title="이용 기록">{selectedMember.reservations.length ? <div className="pos-member-history">{selectedMember.reservations.map((item) => <button key={item.id} onClick={() => { const found = reservations.find((reservation) => reservation.id === item.id); if (found) { setSelectedMember(null); setMemberBenefits(null); openReservationDetails(found); } }}><time>{item.scheduledDate}<br />{item.scheduledTime}</time><div><b>{item.teamName}</b><span>{roomName(item.roomCode)} · {item.totalCount}명</span></div><div><StatusBadge status={item.status} /><b>{money(item.paymentAmount)}</b></div></button>)}</div> : <EmptyState title="연결된 이용 기록이 없습니다." />}</SectionCard>
    </div>}</BottomSheet>

    <BottomSheet open={passPurchaseOpen} title="다회권 구매" onClose={() => { setPassPurchaseOpen(false); setPassPurchaseReservation(null); setPassPurchaseOrder(null); setPassPurchaseCreditReservationId(""); setPassPurchaseCreditUses(1); }}>{selectedMember && <div className="pos-pass-purchase">
      <div className="pos-purchase-member"><span>구매 회원</span><strong>{selectedMember.name}</strong><small>{selectedMember.phone}</small></div>
      {!passPurchaseReservation ? <>
        {passPurchaseCreditReservation ? <div className="pos-pass-credit-box"><div><strong>결제한 게임비 차감 구매</strong><span>{passPurchaseCreditReservation.teamName} · {passPurchaseCreditReservation.scheduledDate} {passPurchaseCreditReservation.scheduledTime}{passPurchaseCreditReservations.length > 1 ? ` 외 한판더 ${passPurchaseCreditReservations.length - 1}게임` : ""}</span><small>한판더로 연결된 결제완료 게임도 함께 계산합니다. 선택한 횟수만큼 구매 완료와 동시에 사용 처리합니다.</small></div><label><span>바로 차감</span><select value={Math.min(passPurchaseCreditUses, passPurchaseCreditMaxUses)} onChange={(event) => setPassPurchaseCreditUses(Number(event.target.value))}>{Array.from({ length: passPurchaseCreditMaxUses }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}회</option>)}</select></label><Button tone="ghost" onClick={() => { setPassPurchaseCreditReservationId(""); setPassPurchaseCreditUses(1); }}>게임비 차감 안 함</Button></div> : null}
        <div className="pos-product-grid">{memberBenefits?.products.filter((product) => product.active).map((product) => {
          const maximumProductUses = Math.min(product.uses, maxPassCreditUses(passPurchaseCreditCandidates, product.ageGroup, product.regularUnitPrice));
          const creditedUses = passPurchaseCreditReservation ? Math.min(passPurchaseCreditUses, maximumProductUses) : 0;
          const credit = product.regularUnitPrice * creditedUses;
          return <button type="button" key={product.code} disabled={Boolean(benefitBusy) || Boolean(passPurchaseCreditReservation && maximumProductUses < 1)} onClick={() => void beginPassPurchase(product.code)}><span>{product.ageGroup === "youth" ? "청소년" : "성인"}</span><strong>{product.uses}회권</strong><b>{money(Math.max(0, product.price - credit))}</b><small>{credit > 0 ? `정가 ${money(product.price)} - 게임비 ${money(credit)} · ${creditedUses}회 차감` : `1회 정상가 ${money(product.regularUnitPrice)}`}</small></button>;
        })}</div>
      </> : <section className="pos-detail-section"><header><div><h3>{passPurchaseReservation.teamName}</h3><p>{passPurchaseOrder?.creditAmount ? `기존 게임비 ${money(passPurchaseOrder.creditAmount)} 차감 · 구매 즉시 ${passPurchaseOrder.initialUsedUses}회 사용` : "승인 또는 수납 완료 전에는 다회권이 지급되지 않습니다."}</p></div><strong>{money(passPurchaseReservation.paymentAmount)}</strong></header>{passPurchaseOrder?.creditAmount ? <div className="pos-pass-payment-breakdown"><span>다회권 정가 <b>{money(passPurchaseOrder.listAmount)}</b></span><span>결제한 게임비 차감 <b>-{money(passPurchaseOrder.creditAmount)}</b></span><strong>추가 결제 <b>{money(passPurchaseOrder.paymentAmount)}</b></strong></div> : null}{passPurchaseReservation.paymentAmount > 0 ? <TerminalPaymentControls reservation={passPurchaseReservation} amount={passPurchaseReservation.paymentAmount} addOnAmount={0} discountAmount={0} pricing={pricing} disabled={false} onSettled={async () => { await refreshBenefits(selectedMember.id); await load(true); notify("다회권 결제 상태를 반영했습니다."); }} /> : <div className="pos-pass-zero-payment"><strong>추가 결제 없음</strong><span>결제한 게임비로 전액 전환되어 다회권 지급과 사용 차감이 완료되었습니다.</span></div>}</section>}
    </div>}</BottomSheet>

    <ConfirmDialog
      open={Boolean(paymentConfirm)}
      title={paymentConfirm?.mode === "cancel" ? "결제를 전체 취소할까요?" : "취소 내역을 삭제할까요?"}
      description={paymentConfirm ? paymentConfirm.mode === "cancel"
        ? `${paymentConfirm.item.customerName || "고객"} · ${paymentConfirm.item.title} · ${money(paymentConfirm.item.paidAmount)}`
        : `${paymentConfirm.item.customerName || "고객"} · ${paymentConfirm.item.title} 내역이 매출 집계에서도 제외됩니다.` : ""}
      confirmLabel={paymentConfirm?.mode === "cancel" ? "결제 취소" : "내역 삭제"}
      danger
      onClose={() => setPaymentConfirm(null)}
      onConfirm={() => {
        const pending = paymentConfirm;
        setPaymentConfirm(null);
        if (!pending) return;
        if (pending.mode === "cancel") void cancelHistoryPayment(pending.item);
        else void deleteHistoryPayment(pending.item);
      }}
    />
    <Toast message={toast.message} tone={toast.tone} />
  </main>;
}
