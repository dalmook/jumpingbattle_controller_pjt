import {
  DEFAULT_KIOSK_PAYMENT_SETTINGS,
  effectiveBankName,
  type KioskPaymentSettings,
} from "@/app/kiosk/payment-settings";
import { getD1 } from "./control";

type KioskPaymentSettingsRow = {
  operation_mode: string;
  card_enabled: number;
  cash_enabled: number;
  bank_transfer_enabled: number;
  pass_enabled: number;
  coupon_enabled: number;
  bank_name: string;
  custom_bank_name: string;
  account_number: string;
  account_holder: string;
  guide_text: string;
  depositor_guide: string;
  confirmation_mode: string;
  updated_at: string;
};

type BankTransferSessionRow = {
  token: string;
  visit_id: string;
  reservation_id: string;
  payment_id: string;
  transaction_id: string;
  amount: number;
  bank_name_at_payment: string;
  account_number_at_payment: string;
  account_holder_at_payment: string;
  guide_text_at_payment: string;
  depositor_guide_at_payment: string;
  confirmation_mode: string;
  status: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type StoredKioskPaymentSettings = KioskPaymentSettings & { updatedAt: string };
export type KioskBankTransferGuidance = {
  token: string;
  url: string;
  amount: number;
  bankName: string;
  accountNumber: string;
  accountHolder: string;
  guideText: string;
  depositorGuide: string;
  confirmationMode: "STAFF_CONFIRM";
  expiresAt: string;
};

const BANK_TRANSFER_TOKEN_TTL_MS = 30 * 60_000;
let kioskPaymentSettingsSchemaReady: Promise<void> | null = null;

async function initializeKioskPaymentSettingsSchema() {
  const defaults = DEFAULT_KIOSK_PAYMENT_SETTINGS;
  const db = getD1();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS kiosk_payment_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      operation_mode TEXT NOT NULL DEFAULT 'STAFFED',
      card_enabled INTEGER NOT NULL DEFAULT 1,
      cash_enabled INTEGER NOT NULL DEFAULT 1,
      bank_transfer_enabled INTEGER NOT NULL DEFAULT 0,
      pass_enabled INTEGER NOT NULL DEFAULT 1,
      coupon_enabled INTEGER NOT NULL DEFAULT 1,
      bank_name TEXT NOT NULL DEFAULT '',
      custom_bank_name TEXT NOT NULL DEFAULT '',
      account_number TEXT NOT NULL DEFAULT '',
      account_holder TEXT NOT NULL DEFAULT '',
      guide_text TEXT NOT NULL DEFAULT '',
      depositor_guide TEXT NOT NULL DEFAULT '',
      confirmation_mode TEXT NOT NULL DEFAULT 'STAFF_CONFIRM',
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`INSERT OR IGNORE INTO kiosk_payment_settings (
      id, operation_mode, card_enabled, cash_enabled, bank_transfer_enabled,
      pass_enabled, coupon_enabled, bank_name, custom_bank_name, account_number,
      account_holder, guide_text, depositor_guide, confirmation_mode
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        defaults.operationMode,
        defaults.cardEnabled ? 1 : 0,
        defaults.cashEnabled ? 1 : 0,
        defaults.bankTransferEnabled ? 1 : 0,
        defaults.passEnabled ? 1 : 0,
        defaults.couponEnabled ? 1 : 0,
        defaults.bankName,
        defaults.customBankName,
        defaults.accountNumber,
        defaults.accountHolder,
        defaults.guideText,
        defaults.depositorGuide,
        defaults.confirmationMode,
      ),
    db.prepare(`CREATE TABLE IF NOT EXISTS kiosk_bank_transfer_sessions (
      token TEXT PRIMARY KEY,
      visit_id TEXT NOT NULL,
      reservation_id TEXT NOT NULL,
      payment_id TEXT NOT NULL,
      transaction_id TEXT NOT NULL UNIQUE,
      amount INTEGER NOT NULL CHECK (amount > 0),
      bank_name_at_payment TEXT NOT NULL,
      account_number_at_payment TEXT NOT NULL,
      account_holder_at_payment TEXT NOT NULL,
      guide_text_at_payment TEXT NOT NULL DEFAULT '',
      depositor_guide_at_payment TEXT NOT NULL DEFAULT '',
      confirmation_mode TEXT NOT NULL DEFAULT 'STAFF_CONFIRM',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS kiosk_bank_transfer_sessions_visit_idx
      ON kiosk_bank_transfer_sessions(visit_id, status, updated_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS kiosk_bank_transfer_sessions_expiry_idx
      ON kiosk_bank_transfer_sessions(status, expires_at)`),
  ]);
}

export async function ensureKioskPaymentSettingsSchema() {
  if (!kioskPaymentSettingsSchemaReady) {
    kioskPaymentSettingsSchemaReady = initializeKioskPaymentSettingsSchema().catch((error) => {
      kioskPaymentSettingsSchemaReady = null;
      throw error;
    });
  }
  await kioskPaymentSettingsSchemaReady;
}

function mapSettings(row: KioskPaymentSettingsRow): StoredKioskPaymentSettings {
  return {
    operationMode: row.operation_mode === "UNMANNED" ? "UNMANNED" : "STAFFED",
    cardEnabled: row.card_enabled === 1,
    cashEnabled: row.cash_enabled === 1,
    bankTransferEnabled: row.bank_transfer_enabled === 1,
    passEnabled: row.pass_enabled === 1,
    couponEnabled: row.coupon_enabled === 1,
    bankName: row.bank_name,
    customBankName: row.custom_bank_name,
    accountNumber: row.account_number,
    accountHolder: row.account_holder,
    guideText: row.guide_text,
    depositorGuide: row.depositor_guide,
    confirmationMode: "STAFF_CONFIRM",
    updatedAt: row.updated_at,
  };
}

export async function getKioskPaymentSettings(): Promise<StoredKioskPaymentSettings> {
  await ensureKioskPaymentSettingsSchema();
  const row = await getD1().prepare(`SELECT operation_mode, card_enabled, cash_enabled,
    bank_transfer_enabled, pass_enabled, coupon_enabled, bank_name, custom_bank_name,
    account_number, account_holder, guide_text, depositor_guide, confirmation_mode, updated_at
    FROM kiosk_payment_settings WHERE id = 1`).first<KioskPaymentSettingsRow>();
  return row ? mapSettings(row) : { ...DEFAULT_KIOSK_PAYMENT_SETTINGS, updatedAt: "" };
}

export async function updateKioskPaymentSettings(
  settings: KioskPaymentSettings,
  updatedBy: string,
) {
  await ensureKioskPaymentSettingsSchema();
  await getD1().prepare(`UPDATE kiosk_payment_settings SET
    operation_mode = ?, card_enabled = ?, cash_enabled = ?, bank_transfer_enabled = ?,
    pass_enabled = ?, coupon_enabled = ?, bank_name = ?, custom_bank_name = ?,
    account_number = ?, account_holder = ?, guide_text = ?, depositor_guide = ?,
    confirmation_mode = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1`).bind(
      settings.operationMode,
      settings.cardEnabled ? 1 : 0,
      settings.cashEnabled ? 1 : 0,
      settings.bankTransferEnabled ? 1 : 0,
      settings.passEnabled ? 1 : 0,
      settings.couponEnabled ? 1 : 0,
      settings.bankName,
      settings.customBankName,
      settings.accountNumber,
      settings.accountHolder,
      settings.guideText,
      settings.depositorGuide,
      settings.confirmationMode,
      updatedBy,
    ).run();
  return getKioskPaymentSettings();
}

function randomTransferToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mapTransfer(row: BankTransferSessionRow): KioskBankTransferGuidance {
  return {
    token: row.token,
    url: `/transfer/${row.token}`,
    amount: row.amount,
    bankName: row.bank_name_at_payment,
    accountNumber: row.account_number_at_payment,
    accountHolder: row.account_holder_at_payment,
    guideText: row.guide_text_at_payment,
    depositorGuide: row.depositor_guide_at_payment,
    confirmationMode: "STAFF_CONFIRM",
    expiresAt: row.expires_at,
  };
}

export async function ensureKioskBankTransferSession(input: {
  visitId: string;
  reservationId: string;
  paymentId: string;
  transactionId: string;
  amount: number;
}) {
  await ensureKioskPaymentSettingsSchema();
  const db = getD1();
  const existing = await db.prepare(`SELECT * FROM kiosk_bank_transfer_sessions
    WHERE transaction_id = ? LIMIT 1`).bind(input.transactionId).first<BankTransferSessionRow>();
  if (existing?.status === "ACTIVE" && Date.parse(existing.expires_at) > Date.now()) return mapTransfer(existing);

  const settings = await getKioskPaymentSettings();
  if (!settings.bankTransferEnabled) throw new Error("KIOSK_PAYMENT_METHOD_DISABLED");
  const bankName = effectiveBankName(settings);
  if (!bankName || !settings.accountNumber || !settings.accountHolder) {
    throw new Error("KIOSK_BANK_TRANSFER_NOT_CONFIGURED");
  }
  const token = randomTransferToken();
  const expiresAt = new Date(Date.now() + BANK_TRANSFER_TOKEN_TTL_MS).toISOString();
  if (existing) {
    await db.prepare(`UPDATE kiosk_bank_transfer_sessions SET token = ?, visit_id = ?, reservation_id = ?,
      payment_id = ?, amount = ?, bank_name_at_payment = ?, account_number_at_payment = ?,
      account_holder_at_payment = ?, guide_text_at_payment = ?, depositor_guide_at_payment = ?,
      confirmation_mode = 'STAFF_CONFIRM', status = 'ACTIVE', expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE transaction_id = ?`).bind(
        token, input.visitId, input.reservationId, input.paymentId, input.amount,
        bankName, settings.accountNumber, settings.accountHolder,
        settings.guideText, settings.depositorGuide, expiresAt, input.transactionId,
      ).run();
  } else {
    await db.prepare(`INSERT INTO kiosk_bank_transfer_sessions (
      token, visit_id, reservation_id, payment_id, transaction_id, amount,
      bank_name_at_payment, account_number_at_payment, account_holder_at_payment,
      guide_text_at_payment, depositor_guide_at_payment, confirmation_mode, status, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'STAFF_CONFIRM', 'ACTIVE', ?)`)
      .bind(
        token, input.visitId, input.reservationId, input.paymentId, input.transactionId,
        input.amount, bankName, settings.accountNumber, settings.accountHolder,
        settings.guideText, settings.depositorGuide, expiresAt,
      ).run();
  }
  const created = await db.prepare(`SELECT * FROM kiosk_bank_transfer_sessions WHERE transaction_id = ? LIMIT 1`)
    .bind(input.transactionId).first<BankTransferSessionRow>();
  if (!created) throw new Error("KIOSK_BANK_TRANSFER_SESSION_FAILED");
  return mapTransfer(created);
}

export async function getKioskBankTransferSessionForTransaction(transactionId: string) {
  await ensureKioskPaymentSettingsSchema();
  const row = await getD1().prepare(`SELECT * FROM kiosk_bank_transfer_sessions
    WHERE transaction_id = ? AND status = 'ACTIVE' AND datetime(expires_at) > CURRENT_TIMESTAMP LIMIT 1`)
    .bind(transactionId).first<BankTransferSessionRow>();
  return row ? mapTransfer(row) : null;
}

export async function getPublicKioskBankTransferSession(token: string) {
  await ensureKioskPaymentSettingsSchema();
  if (!/^[0-9a-f]{48}$/i.test(token)) return null;
  const row = await getD1().prepare(`SELECT * FROM kiosk_bank_transfer_sessions
    WHERE token = ? AND status = 'ACTIVE' AND datetime(expires_at) > CURRENT_TIMESTAMP LIMIT 1`)
    .bind(token).first<BankTransferSessionRow>();
  return row ? mapTransfer(row) : null;
}

export async function setKioskBankTransferSessionStatus(
  transactionId: string,
  status: "CONFIRMED" | "CANCELLED",
) {
  await ensureKioskPaymentSettingsSchema();
  await getD1().prepare(`UPDATE kiosk_bank_transfer_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE transaction_id = ? AND status = 'ACTIVE'`).bind(status, transactionId).run();
}
