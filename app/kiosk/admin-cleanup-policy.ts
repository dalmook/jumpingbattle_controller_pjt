export type KioskVisitCleanupFacts = {
  status: string;
  flowType: string;
  reservationId: string;
  startedAt: string;
  completedAt: string;
  activeHoldCount: number;
  approvedPaymentCount: number;
  paidPaymentCount: number;
  paidReservationCount: number;
  gameRecordCount: number;
  salesCount: number;
  passLedgerCount: number;
  couponLedgerCount: number;
  stampLedgerCount: number;
  visitStampAllocationCount: number;
  bankTransferSessionCount: number;
};

export type KioskVisitCleanupDecision = {
  isTest: boolean;
  isTemporary: boolean;
  canTerminate: boolean;
  canHardDelete: boolean;
  canReleaseHold: boolean;
  deleteBlockReason: string;
};

const TERMINAL_VISIT_STATES = new Set(["COMPLETED", "CANCELLED", "EXPIRED", "ABANDONED"]);
const NEVER_TERMINATE_STATES = new Set(["PLAYING", "COMPLETED"]);

export function evaluateKioskVisitCleanup(
  facts: KioskVisitCleanupFacts,
): KioskVisitCleanupDecision {
  const isTest = facts.flowType === "KIOSK_TEST";
  const isTemporary = !facts.reservationId && [
    "DRAFT", "HOLD", "CANCELLED", "EXPIRED", "ABANDONED",
  ].includes(facts.status);

  let deleteBlockReason = "";
  if (!isTest && !isTemporary) deleteBlockReason = "테스트 또는 종료된 임시 세션만 삭제할 수 있습니다.";
  else if (facts.reservationId) deleteBlockReason = "실제 예약과 연결된 기록은 삭제할 수 없습니다.";
  else if (["PLAYING", "COMPLETED"].includes(facts.status) || facts.startedAt || facts.completedAt) {
    deleteBlockReason = "게임 시작 또는 완료 기록이 있어 삭제할 수 없습니다.";
  } else if (facts.approvedPaymentCount > 0 || facts.paidPaymentCount > 0 || facts.paidReservationCount > 0) {
    deleteBlockReason = "승인 또는 완료된 결제가 있어 삭제할 수 없습니다.";
  } else if (facts.gameRecordCount > 0 || facts.salesCount > 0) {
    deleteBlockReason = "게임 또는 매출 기록이 있어 삭제할 수 없습니다.";
  } else if (facts.passLedgerCount > 0) {
    deleteBlockReason = "다회권 사용 기록이 있어 삭제할 수 없습니다.";
  } else if (facts.couponLedgerCount > 0) {
    deleteBlockReason = "쿠폰 사용 기록이 있어 삭제할 수 없습니다.";
  } else if (facts.stampLedgerCount > 0 || facts.visitStampAllocationCount > 0) {
    deleteBlockReason = "스탬프 적립 기록이 있어 삭제할 수 없습니다.";
  } else if (facts.bankTransferSessionCount > 0) {
    deleteBlockReason = "계좌이체 결제 세션이 있어 삭제할 수 없습니다.";
  }

  return {
    isTest,
    isTemporary,
    canTerminate: !NEVER_TERMINATE_STATES.has(facts.status) && !TERMINAL_VISIT_STATES.has(facts.status),
    canHardDelete: !deleteBlockReason,
    canReleaseHold: facts.activeHoldCount > 0,
    deleteBlockReason,
  };
}

