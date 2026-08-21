export const PAYMENT_METHODS = ["card", "cash", "account", "coupon"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_TRANSACTION_STATUSES = [
  "PENDING",
  "PROCESSING",
  "APPROVED",
  "COMPLETED",
  "DECLINED",
  "USER_CANCELLED",
  "CANCELLED",
  "UNKNOWN",
  "BUSY",
  "ERROR",
  "UNLINKED",
] as const;

export type LedgerStatus = (typeof PAYMENT_TRANSACTION_STATUSES)[number];

export type LedgerAttempt = {
  id: string;
  attemptType: "PAY" | "CANCEL";
  paymentMethod: string;
  amount: number;
  status: LedgerStatus;
  splitIndex?: number | null;
  errorCode?: string;
  originalAttemptId?: string | null;
  commandId?: string | null;
  activeKey?: string | null;
  requestedAt?: string;
  completedAt?: string | null;
};

export type PaymentWholeStatus =
  | "PENDING"
  | "PARTIALLY_PAID"
  | "PAID"
  | "PARTIALLY_CANCELLED"
  | "CANCELLED"
  | "UNKNOWN"
  | "ERROR";

export type PaymentPlanMode = "single" | "equal" | "custom";

export type PaymentPlanItem = {
  splitIndex: number;
  amount: number;
  paymentMethod: PaymentMethod;
};

const SUCCESSFUL_PAY_STATUSES = new Set<LedgerStatus>(["APPROVED", "COMPLETED"]);

function integer(value: unknown) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizePaymentMethod(value: unknown): PaymentMethod {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "bank_transfer" || normalized === "bank" || normalized === "transfer") {
    return "account";
  }
  return PAYMENT_METHODS.includes(normalized as PaymentMethod)
    ? (normalized as PaymentMethod)
    : "card";
}

export function splitEqualAmount(amount: number, count: number) {
  const normalizedAmount = Math.max(0, integer(amount));
  const normalizedCount = integer(count);
  if (normalizedCount < 1 || normalizedCount > 20) {
    throw new Error("PAYMENT_SPLIT_COUNT_INVALID");
  }
  if (normalizedAmount < normalizedCount) {
    throw new Error("PAYMENT_SPLIT_AMOUNT_TOO_SMALL");
  }
  const quotient = Math.floor(normalizedAmount / normalizedCount);
  const remainder = normalizedAmount % normalizedCount;
  return Array.from(
    { length: normalizedCount },
    (_, index) => quotient + (index < remainder ? 1 : 0),
  );
}

export function buildPaymentPlan(input: {
  payableAmount: number;
  mode: PaymentPlanMode;
  count?: number;
  paymentMethod?: unknown;
  items?: Array<{ amount: unknown; paymentMethod: unknown }>;
}): PaymentPlanItem[] {
  const payableAmount = Math.max(0, integer(input.payableAmount));
  if (payableAmount === 0) return [];

  if (input.mode === "single") {
    return [{
      splitIndex: 1,
      amount: payableAmount,
      paymentMethod: normalizePaymentMethod(input.paymentMethod),
    }];
  }

  if (input.mode === "equal") {
    return splitEqualAmount(payableAmount, input.count ?? 2).map((amount, index) => ({
      splitIndex: index + 1,
      amount,
      paymentMethod: normalizePaymentMethod(
        input.items?.[index]?.paymentMethod ?? input.paymentMethod,
      ),
    }));
  }

  const items = (input.items ?? []).map((item, index) => ({
    splitIndex: index + 1,
    amount: integer(item.amount),
    paymentMethod: normalizePaymentMethod(item.paymentMethod),
  }));
  if (!items.length || items.length > 20 || items.some((item) => item.amount < 1)) {
    throw new Error("PAYMENT_SPLIT_ITEMS_INVALID");
  }
  const sum = items.reduce((total, item) => total + item.amount, 0);
  if (sum < payableAmount) throw new Error("PAYMENT_SPLIT_TOTAL_UNDER");
  if (sum > payableAmount) throw new Error("PAYMENT_SPLIT_TOTAL_OVER");
  return items;
}

export function paymentPlanMatchesLedger(input: {
  authoritativeFinalAmount: number;
  authoritativeDepositAmount: number;
  storedFinalAmount: number;
  storedDepositAmount: number;
  storedPayableAmount: number;
  planAmounts: number[];
}) {
  const authoritativeFinalAmount = Math.max(0, integer(input.authoritativeFinalAmount));
  const authoritativeDepositAmount = Math.min(
    authoritativeFinalAmount,
    Math.max(0, integer(input.authoritativeDepositAmount)),
  );
  const authoritativePayableAmount = Math.max(
    0,
    authoritativeFinalAmount - authoritativeDepositAmount,
  );
  const plannedAmount = input.planAmounts.reduce(
    (sum, amount) => sum + Math.max(0, integer(amount)),
    0,
  );
  return (
    Math.max(0, integer(input.storedFinalAmount)) === authoritativeFinalAmount &&
    Math.max(0, integer(input.storedDepositAmount)) === authoritativeDepositAmount &&
    Math.max(0, integer(input.storedPayableAmount)) === authoritativePayableAmount &&
    plannedAmount === authoritativePayableAmount
  );
}

export function calculatePaymentLedger(input: {
  finalAmount: number;
  depositAmount?: number;
  attempts: LedgerAttempt[];
}) {
  const finalAmount = Math.max(0, integer(input.finalAmount));
  const depositAmount = Math.min(
    finalAmount,
    Math.max(0, integer(input.depositAmount ?? 0)),
  );
  const payableAmount = Math.max(0, finalAmount - depositAmount);
  const cancelledOriginals = new Set(
    input.attempts
      .filter(
        (attempt) =>
          attempt.attemptType === "CANCEL" &&
          attempt.status === "CANCELLED" &&
          attempt.originalAttemptId,
      )
      .map((attempt) => String(attempt.originalAttemptId)),
  );
  const completedPayments = input.attempts.filter(
    (attempt) =>
      attempt.attemptType === "PAY" &&
      SUCCESSFUL_PAY_STATUSES.has(attempt.status) &&
      !cancelledOriginals.has(attempt.id),
  );
  const completedByMethod = completedPayments.reduce(
    (totals, attempt) => {
      const method = normalizePaymentMethod(attempt.paymentMethod);
      totals[method] += Math.max(0, integer(attempt.amount));
      return totals;
    },
    { card: 0, cash: 0, account: 0, coupon: 0 } as Record<PaymentMethod, number>,
  );
  const completedAmount = completedPayments.reduce(
    (sum, attempt) => sum + Math.max(0, integer(attempt.amount)),
    0,
  );
  const approvedAmount = Math.min(finalAmount, depositAmount + completedAmount);
  const remainingAmount = Math.max(0, payableAmount - completedAmount);
  const hasUnknown = input.attempts.some(
    (attempt) =>
      attempt.status === "UNKNOWN" ||
      attempt.errorCode === "RECONCILIATION_REQUIRED",
  );
  const hasBusy = input.attempts.some(
    (attempt) =>
      attempt.status === "PROCESSING" ||
      (attempt.status === "BUSY" && Boolean(attempt.activeKey)) ||
      (attempt.status === "PENDING" && Boolean(attempt.commandId || attempt.activeKey)),
  );
  const everCompleted = input.attempts.some(
    (attempt) =>
      attempt.attemptType === "PAY" && SUCCESSFUL_PAY_STATUSES.has(attempt.status),
  );
  const hasSuccessfulCancellation = cancelledOriginals.size > 0;
  const hasError = input.attempts.some((attempt) => attempt.status === "ERROR");

  let paymentStatus: PaymentWholeStatus = "PENDING";
  if (hasUnknown) paymentStatus = "UNKNOWN";
  else if (remainingAmount === 0) paymentStatus = "PAID";
  else if (completedAmount > 0 && hasSuccessfulCancellation) {
    paymentStatus = "PARTIALLY_CANCELLED";
  } else if (completedAmount > 0) paymentStatus = "PARTIALLY_PAID";
  else if (everCompleted && hasSuccessfulCancellation) paymentStatus = "CANCELLED";
  else if (hasError) paymentStatus = "ERROR";

  return {
    finalAmount,
    depositAmount,
    payableAmount,
    approvedAmount,
    completedAmount,
    splitApprovedAmount: completedAmount,
    remainingAmount,
    approvedByMethod: completedByMethod,
    completedByMethod,
    approvedPayments: completedPayments,
    completedPayments,
    cancelledOriginals,
    hasUnknown,
    hasBusy,
    amountLocked: completedPayments.length > 0 || hasUnknown || hasBusy,
    paymentStatus,
    orderStatus: paymentStatus,
  };
}

export function validatePaymentAmount(amount: number, remainingAmount: number) {
  const normalized = integer(amount);
  if (normalized < 1) throw new Error("PAYMENT_AMOUNT_TOO_SMALL");
  if (normalized > integer(remainingAmount)) {
    throw new Error("PAYMENT_AMOUNT_EXCEEDS_REMAINING");
  }
  return normalized;
}
