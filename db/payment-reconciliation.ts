export function normalizeAuthorizationNumber(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9]{1,20}$/.test(normalized)) {
    throw new Error("PAYMENT_RECONCILIATION_AUTH_NO_INVALID");
  }
  return normalized;
}

export function normalizeAuthorizationDate(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length !== 8 && digits.length !== 14) {
    throw new Error("PAYMENT_RECONCILIATION_AUTH_DATE_INVALID");
  }
  return digits;
}

export function matchExternalApprovalAmount(value: unknown, remainingAmount: number) {
  const amount = Math.trunc(Number(value));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
    throw new Error("PAYMENT_EXTERNAL_IMPORT_AMOUNT_INVALID");
  }
  if (amount !== remainingAmount) {
    throw new Error("PAYMENT_EXTERNAL_IMPORT_AMOUNT_MISMATCH");
  }
  return amount;
}

export function normalizeApprovalTime(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 4 && digits.length !== 6) {
    throw new Error("PAYMENT_EXTERNAL_IMPORT_TIME_INVALID");
  }
  const hour = Number(digits.slice(0, 2));
  const minute = Number(digits.slice(2, 4));
  const second = digits.length === 6 ? Number(digits.slice(4, 6)) : 0;
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error("PAYMENT_EXTERNAL_IMPORT_TIME_INVALID");
  }
  return `${digits.slice(0, 4)}${String(second).padStart(2, "0")}`;
}

export function normalizeTerminalId(value: unknown) {
  const normalized = String(value ?? "").trim() || "MPOS-1700AE";
  if (normalized.length > 80 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("PAYMENT_EXTERNAL_IMPORT_TERMINAL_INVALID");
  }
  return normalized;
}

export function normalizeMaskedCardLast4(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^\d{4}$/.test(normalized)) {
    throw new Error("PAYMENT_EXTERNAL_IMPORT_CARD_LAST4_INVALID");
  }
  return `****${normalized}`;
}

export function normalizeManualPaymentReason(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (normalized.length < 2 || normalized.length > 200) {
    throw new Error("PAYMENT_EXTERNAL_IMPORT_REASON_REQUIRED");
  }
  return normalized;
}

export function externalTerminalTransactionKey(input: {
  approvalNo: string;
  approvalDate: string;
  amount: number;
  terminalId: string;
}) {
  return [
    "TERMINAL_DIRECT",
    input.terminalId.toUpperCase(),
    input.approvalDate.slice(0, 8),
    input.approvalNo.toUpperCase(),
    Math.trunc(input.amount),
  ].join(":");
}

export function canAppendExternalApprovalTopUp(input: {
  requestedAmount: number;
  remainingAmount: number;
  storedPayableAmount: number;
  authoritativePayableAmount: number;
  paymentStatus: string;
  splitCount: number;
  plannedSplitCount: number;
  allPlannedSplitsSuccessful: boolean;
  hasCancelledPayments: boolean;
  hasGroupAllocations: boolean;
}) {
  return Boolean(
    input.requestedAmount > 0 &&
    input.requestedAmount === input.remainingAmount &&
    input.paymentStatus === "PAID" &&
    input.splitCount > 0 &&
    input.plannedSplitCount === input.splitCount &&
    input.allPlannedSplitsSuccessful &&
    !input.hasCancelledPayments &&
    !input.hasGroupAllocations &&
    input.storedPayableAmount < input.authoritativePayableAmount &&
    input.authoritativePayableAmount - input.storedPayableAmount === input.remainingAmount
  );
}

export function externalApprovalTopUpRequestKey(input: {
  paymentId: string;
  authoritativePayableAmount: number;
  splitIndex: number;
}) {
  return [
    "external-topup",
    input.paymentId,
    Math.trunc(input.authoritativePayableAmount),
    Math.trunc(input.splitIndex),
  ].join(":");
}
