export const KIOSK_OPERATION_MODES = ["STAFFED", "UNMANNED"] as const;
export const BANK_TRANSFER_CONFIRMATION_MODES = ["STAFF_CONFIRM", "AUTO_CONFIRM"] as const;

export type KioskOperationMode = (typeof KIOSK_OPERATION_MODES)[number];
export type BankTransferConfirmationMode = (typeof BANK_TRANSFER_CONFIRMATION_MODES)[number];
export type ConfigurableKioskPaymentMethod = "card" | "cash" | "account" | "pass" | "coupon";

export type KioskPaymentSettings = {
  operationMode: KioskOperationMode;
  cardEnabled: boolean;
  cashEnabled: boolean;
  bankTransferEnabled: boolean;
  passEnabled: boolean;
  couponEnabled: boolean;
  bankName: string;
  customBankName: string;
  accountNumber: string;
  accountHolder: string;
  guideText: string;
  depositorGuide: string;
  confirmationMode: BankTransferConfirmationMode;
};

export type PublicKioskPaymentSettings = {
  operationMode: KioskOperationMode;
  methods: Record<ConfigurableKioskPaymentMethod, boolean>;
  bankTransferConfirmationMode: BankTransferConfirmationMode;
  unmannedStaffConfirmationWarning: boolean;
};

export const KIOSK_BANK_OPTIONS = [
  "카카오뱅크",
  "토스뱅크",
  "국민은행",
  "신한은행",
  "우리은행",
  "하나은행",
  "농협",
  "기업은행",
  "기타",
] as const;

export const DEFAULT_KIOSK_PAYMENT_SETTINGS: KioskPaymentSettings = {
  operationMode: "STAFFED",
  cardEnabled: true,
  cashEnabled: true,
  bankTransferEnabled: false,
  passEnabled: true,
  couponEnabled: true,
  bankName: "",
  customBankName: "",
  accountNumber: "",
  accountHolder: "",
  guideText: "QR을 스캔해 계좌번호를 복사해주세요.",
  depositorGuide: "예약자명 또는 팀명으로 입금해주세요.",
  confirmationMode: "STAFF_CONFIRM",
};

function cleanText(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function applyKioskPaymentPreset(
  current: KioskPaymentSettings,
  operationMode: KioskOperationMode,
): KioskPaymentSettings {
  const staffed = operationMode === "STAFFED";
  return {
    ...current,
    operationMode,
    cardEnabled: true,
    cashEnabled: staffed,
    bankTransferEnabled: staffed,
    passEnabled: true,
    couponEnabled: true,
  };
}

export function activeKioskPaymentMethodCount(settings: KioskPaymentSettings) {
  return [
    settings.cardEnabled,
    settings.cashEnabled,
    settings.bankTransferEnabled,
    settings.passEnabled,
    settings.couponEnabled,
  ].filter(Boolean).length;
}

export function effectiveBankName(settings: Pick<KioskPaymentSettings, "bankName" | "customBankName">) {
  return settings.bankName === "기타" ? settings.customBankName.trim() : settings.bankName.trim();
}

export function requiresUnmannedBankWarning(settings: KioskPaymentSettings) {
  return settings.operationMode === "UNMANNED" &&
    settings.bankTransferEnabled &&
    settings.confirmationMode === "STAFF_CONFIRM";
}

export function sanitizeKioskPaymentSettings(input: unknown): KioskPaymentSettings | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const operationMode = cleanText(source.operationMode, 20).toUpperCase();
  const confirmationMode = cleanText(source.confirmationMode, 30).toUpperCase();
  if (!KIOSK_OPERATION_MODES.includes(operationMode as KioskOperationMode)) return null;
  if (confirmationMode !== "STAFF_CONFIRM") return null;

  const settings: KioskPaymentSettings = {
    operationMode: operationMode as KioskOperationMode,
    cardEnabled: booleanValue(source.cardEnabled, DEFAULT_KIOSK_PAYMENT_SETTINGS.cardEnabled),
    cashEnabled: booleanValue(source.cashEnabled, DEFAULT_KIOSK_PAYMENT_SETTINGS.cashEnabled),
    bankTransferEnabled: booleanValue(source.bankTransferEnabled, DEFAULT_KIOSK_PAYMENT_SETTINGS.bankTransferEnabled),
    passEnabled: booleanValue(source.passEnabled, DEFAULT_KIOSK_PAYMENT_SETTINGS.passEnabled),
    couponEnabled: booleanValue(source.couponEnabled, DEFAULT_KIOSK_PAYMENT_SETTINGS.couponEnabled),
    bankName: cleanText(source.bankName, 40),
    customBankName: cleanText(source.customBankName, 40),
    accountNumber: cleanText(source.accountNumber, 60),
    accountHolder: cleanText(source.accountHolder, 60),
    guideText: cleanText(source.guideText, 160),
    depositorGuide: cleanText(source.depositorGuide, 160),
    confirmationMode: "STAFF_CONFIRM",
  };

  if (activeKioskPaymentMethodCount(settings) < 1) return null;
  if (settings.bankTransferEnabled && (
    !effectiveBankName(settings) ||
    !settings.accountNumber ||
    !settings.accountHolder
  )) return null;
  return settings;
}

export function publicKioskPaymentSettings(settings: KioskPaymentSettings): PublicKioskPaymentSettings {
  return {
    operationMode: settings.operationMode,
    methods: {
      card: settings.cardEnabled,
      cash: settings.cashEnabled,
      account: settings.bankTransferEnabled,
      pass: settings.passEnabled,
      coupon: settings.couponEnabled,
    },
    bankTransferConfirmationMode: settings.confirmationMode,
    unmannedStaffConfirmationWarning: requiresUnmannedBankWarning(settings),
  };
}

export function isKioskPaymentMethodEnabled(
  settings: KioskPaymentSettings,
  method: ConfigurableKioskPaymentMethod | string,
) {
  const normalized = String(method).trim().toLowerCase();
  if (normalized === "card") return settings.cardEnabled;
  if (normalized === "cash") return settings.cashEnabled;
  if (normalized === "account" || normalized === "bank_transfer") return settings.bankTransferEnabled;
  if (normalized === "pass") return settings.passEnabled;
  if (normalized === "coupon") return settings.couponEnabled;
  return false;
}

export function assertKioskPaymentMethodEnabled(
  settings: KioskPaymentSettings,
  method: ConfigurableKioskPaymentMethod | string,
) {
  if (!isKioskPaymentMethodEnabled(settings, method)) {
    throw new Error("KIOSK_PAYMENT_METHOD_DISABLED");
  }
}
