import { formatMemberPhone, normalizeMemberPhone } from "@/app/admin/v2/member-utils";
import type { PricingSettings } from "@/app/pricing-config";
import {
  configuredPassProducts,
  type PassProduct,
  type PassProductCode,
} from "@/app/pass-products";
import { getD1 } from "./control";
import { ensureMemberSchema } from "./members";
import { getPricingSettings } from "./pricing-settings";
import { ensureReservationSchema } from "./reservations";
import { quotePassUse } from "@/app/pass-use";
import { buildPassCreditPlan } from "@/app/pass-purchase-credit";
import { stampAwardQuantity } from "@/app/kiosk/domain";

export const LEGACY_SOURCE = "LEGACY_JUMPINGMANAGER";
export const MEMBER_COUPON_TYPES = ["STAMP_REWARD", "WEEKDAY_EVENT"] as const;
export type MemberCouponType = (typeof MEMBER_COUPON_TYPES)[number];

export type BenefitSettings = {
  stampGoal: number;
  stampEarnPerGame: number;
  passValidityMonths: number;
  updatedAt: string;
};

export { configuredPassProducts };
export type { PassProduct, PassProductCode };

export type MemberPassRecord = {
  id: string;
  memberId: string;
  productCode: string;
  productName: string;
  ageGroup: string;
  purchasedUses: number;
  remainingUses: number;
  purchasePrice: number | null;
  regularUnitPrice: number;
  purchasedAt: string;
  expiresAt: string;
  status: string;
  paymentId: string;
  paymentTransactionId: string;
  paymentMethod: string;
  source: string;
};

export type MemberCouponRecord = {
  id: string;
  memberId: string;
  couponType: MemberCouponType;
  name: string;
  status: string;
  issuedAt: string;
  expiresAt: string;
  usedAt: string;
  usedReservationId: string;
  usedPaymentAttemptId: string;
  source: string;
  sourceReference: string;
  issuedBy: string;
};

export type LegacyPassInput = {
  sourceReference: string;
  name: string;
  productCode: string;
  ageGroup: string;
  remainingUses: number;
  expiresAt?: string | null;
};

export type LegacyMemberInput = {
  legacyId: string;
  name: string;
  phone: string;
  team?: string;
  email?: string;
  car?: string;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
  stamp: number;
  passes: LegacyPassInput[];
};

type PassRow = {
  id: string;
  member_id: string;
  product_code: string;
  product_name_at_purchase: string;
  age_group: string;
  purchased_uses: number;
  remaining_uses: number;
  purchase_price: number | null;
  regular_unit_price_at_purchase: number;
  purchased_at: string;
  expires_at: string | null;
  status: string;
  payment_id: string | null;
  payment_transaction_id: string | null;
  payment_method: string;
  source: string;
};

type PurchaseOrderRow = {
  id: string;
  reservation_id: string;
  member_id: string;
  product_code: string;
  product_name: string;
  age_group: string;
  purchased_uses: number;
  amount: number;
  list_amount: number;
  credit_amount: number;
  credit_reservation_id: string | null;
  initial_used_uses: number;
  regular_unit_price: number;
  expires_at: string | null;
  status: string;
  payment_status: string;
  payment_id: string | null;
  member_pass_id: string | null;
};

type CouponRow = {
  id: string;
  member_id: string;
  coupon_type: MemberCouponType;
  name: string;
  status: string;
  issued_at: string;
  expires_at: string;
  used_at: string | null;
  used_reservation_id: string | null;
  used_payment_attempt_id: string | null;
  source: string;
  source_reference: string;
  issued_by: string;
};

function finiteInt(value: unknown, minimum = 0, maximum = 1_000_000) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : minimum;
}

function safeText(value: unknown, length = 500) {
  return String(value ?? "").trim().slice(0, length);
}

function toPass(row: PassRow): MemberPassRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    productCode: row.product_code,
    productName: row.product_name_at_purchase,
    ageGroup: row.age_group,
    purchasedUses: Number(row.purchased_uses) || 0,
    remainingUses: Number(row.remaining_uses) || 0,
    purchasePrice: row.purchase_price == null ? null : Number(row.purchase_price),
    regularUnitPrice: Number(row.regular_unit_price_at_purchase) || 0,
    purchasedAt: row.purchased_at,
    expiresAt: row.expires_at ?? "",
    status: row.status,
    paymentId: row.payment_id ?? "",
    paymentTransactionId: row.payment_transaction_id ?? "",
    paymentMethod: row.payment_method,
    source: row.source,
  };
}

function toCoupon(row: CouponRow): MemberCouponRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    couponType: row.coupon_type,
    name: row.name,
    status: row.status,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at ?? "",
    usedReservationId: row.used_reservation_id ?? "",
    usedPaymentAttemptId: row.used_payment_attempt_id ?? "",
    source: row.source,
    sourceReference: row.source_reference,
    issuedBy: row.issued_by,
  };
}

let memberBenefitSchemaReady: Promise<void> | null = null;

async function initializeMemberBenefitSchema() {
  await Promise.all([ensureMemberSchema(), ensureReservationSchema()]);
  const db = getD1();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS benefit_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), stamp_goal INTEGER NOT NULL DEFAULT 10,
      stamp_earn_per_game INTEGER NOT NULL DEFAULT 1,
      pass_validity_months INTEGER NOT NULL DEFAULT 12,
      updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`INSERT OR IGNORE INTO benefit_settings (id) VALUES (1)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS stamp_ledger (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL, reservation_id TEXT, payment_id TEXT,
      type TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'POS', reference_key TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS stamp_ledger_member_created_idx ON stamp_ledger(member_id, created_at DESC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS member_coupons (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL,
      coupon_type TEXT NOT NULL CHECK(coupon_type IN ('STAMP_REWARD','WEEKDAY_EVENT')),
      name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
      issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL, used_at TEXT, used_reservation_id TEXT,
      used_payment_attempt_id TEXT, source TEXT NOT NULL DEFAULT 'ADMIN',
      source_reference TEXT NOT NULL UNIQUE, issued_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS member_coupons_member_status_idx ON member_coupons(member_id, status, expires_at, issued_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS member_coupons_used_reservation_idx ON member_coupons(used_reservation_id, used_at DESC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS pass_purchase_orders (
      id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE, member_id TEXT NOT NULL,
      product_code TEXT NOT NULL, product_name TEXT NOT NULL, age_group TEXT NOT NULL,
      purchased_uses INTEGER NOT NULL, amount INTEGER NOT NULL,
      list_amount INTEGER NOT NULL DEFAULT 0, credit_amount INTEGER NOT NULL DEFAULT 0,
      credit_reservation_id TEXT, initial_used_uses INTEGER NOT NULL DEFAULT 0,
      regular_unit_price INTEGER NOT NULL DEFAULT 0, expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING', payment_status TEXT NOT NULL DEFAULT 'PENDING',
      payment_id TEXT, member_pass_id TEXT, requested_by TEXT NOT NULL DEFAULT '',
      paid_at TEXT, cancelled_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS pass_purchase_orders_member_status_idx ON pass_purchase_orders(member_id, status, created_at DESC)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS pass_purchase_orders_credit_reservation_uidx ON pass_purchase_orders(credit_reservation_id) WHERE credit_reservation_id IS NOT NULL AND status <> 'CANCELLED'`),
    db.prepare(`CREATE TABLE IF NOT EXISTS pass_purchase_credits (
      order_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 1, used_uses INTEGER NOT NULL DEFAULT 0,
      credit_amount INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (order_id, reservation_id), UNIQUE (reservation_id))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS pass_purchase_credits_order_idx ON pass_purchase_credits(order_id, sequence)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS member_passes (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL, product_code TEXT NOT NULL,
      product_name_at_purchase TEXT NOT NULL, age_group TEXT NOT NULL DEFAULT 'other',
      purchased_uses INTEGER NOT NULL, remaining_uses INTEGER NOT NULL,
      purchase_price INTEGER, regular_unit_price_at_purchase INTEGER NOT NULL DEFAULT 0,
      purchased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE', payment_id TEXT, payment_transaction_id TEXT,
      payment_method TEXT NOT NULL DEFAULT '', purchase_card_amount INTEGER NOT NULL DEFAULT 0,
      purchase_cash_amount INTEGER NOT NULL DEFAULT 0, purchase_account_amount INTEGER NOT NULL DEFAULT 0,
      purchase_order_id TEXT UNIQUE, source TEXT NOT NULL DEFAULT 'POS_PURCHASE',
      source_reference TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS member_passes_member_status_idx ON member_passes(member_id, status, expires_at, purchased_at DESC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS pass_ledger (
      id TEXT PRIMARY KEY, member_pass_id TEXT NOT NULL, member_id TEXT NOT NULL,
      type TEXT NOT NULL, uses INTEGER NOT NULL, reservation_id TEXT, payment_id TEXT,
      reference_id TEXT, reference_key TEXT NOT NULL UNIQUE, regular_amount INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'POS',
      created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS pass_ledger_pass_created_idx ON pass_ledger(member_pass_id, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS pass_ledger_member_created_idx ON pass_ledger(member_id, created_at DESC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS legacy_migration_map (
      legacy_source TEXT NOT NULL, legacy_member_id TEXT NOT NULL, member_id TEXT NOT NULL,
      action TEXT NOT NULL, migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (legacy_source, legacy_member_id))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS legacy_migration_backups (
      id TEXT PRIMARY KEY, legacy_source TEXT NOT NULL, members_json TEXT NOT NULL,
      stamp_ledger_json TEXT NOT NULL, member_passes_json TEXT NOT NULL,
      pass_ledger_json TEXT NOT NULL, member_coupons_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
  ]);
}

export async function ensureMemberBenefitSchema() {
  if (!memberBenefitSchemaReady) {
    memberBenefitSchemaReady = initializeMemberBenefitSchema().catch((error) => {
      memberBenefitSchemaReady = null;
      throw error;
    });
  }
  await memberBenefitSchemaReady;
}

export async function getBenefitSettings(): Promise<BenefitSettings> {
  await ensureMemberBenefitSchema();
  const row = await getD1().prepare(`SELECT stamp_goal, stamp_earn_per_game, pass_validity_months, updated_at FROM benefit_settings WHERE id = 1`).first<Record<string, unknown>>();
  return {
    stampGoal: finiteInt(row?.stamp_goal, 1, 100),
    stampEarnPerGame: finiteInt(row?.stamp_earn_per_game, 0, 20),
    passValidityMonths: finiteInt(row?.pass_validity_months, 1, 120),
    updatedAt: String(row?.updated_at ?? ""),
  };
}

export async function updateBenefitSettings(input: Partial<BenefitSettings>, updatedBy: string) {
  const current = await getBenefitSettings();
  const next = {
    stampGoal: finiteInt(input.stampGoal ?? current.stampGoal, 1, 100),
    stampEarnPerGame: finiteInt(input.stampEarnPerGame ?? current.stampEarnPerGame, 0, 20),
    passValidityMonths: finiteInt(input.passValidityMonths ?? current.passValidityMonths, 1, 120),
  };
  await getD1().prepare(`UPDATE benefit_settings SET stamp_goal = ?, stamp_earn_per_game = ?, pass_validity_months = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
    .bind(next.stampGoal, next.stampEarnPerGame, next.passValidityMonths, updatedBy).run();
  return getBenefitSettings();
}

export async function getMemberBenefits(memberId: string) {
  await ensureMemberBenefitSchema();
  const db = getD1();
  await expireMemberCoupons(memberId);
  await issueAutomaticStampCoupons(memberId, "system:auto-stamp");
  const [member, stamp, settings, pricing, passResult, couponResult, stampHistory, passHistory, pendingOrders] = await Promise.all([
    db.prepare(`SELECT id, name FROM members WHERE id = ? AND status <> 'merged' LIMIT 1`).bind(memberId).first<{ id: string; name: string }>(),
    db.prepare(`SELECT COALESCE(SUM(amount), 0) AS balance FROM stamp_ledger WHERE member_id = ?`).bind(memberId).first<{ balance: number }>(),
    getBenefitSettings(),
    getPricingSettings(),
    db.prepare(`SELECT * FROM member_passes WHERE member_id = ? ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'USED_UP' THEN 1 ELSE 2 END, purchased_at DESC`).bind(memberId).all<PassRow>(),
    db.prepare(`SELECT * FROM member_coupons WHERE member_id = ? ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'USED' THEN 1 WHEN 'EXPIRED' THEN 2 ELSE 3 END, expires_at, issued_at DESC`).bind(memberId).all<CouponRow>(),
    db.prepare(`SELECT id, type, amount, reason, reservation_id, reference_key, source, created_at FROM stamp_ledger WHERE member_id = ? ORDER BY created_at DESC LIMIT 100`).bind(memberId).all<Record<string, unknown>>(),
    db.prepare(`SELECT id, member_pass_id, type, uses, reservation_id, reference_id, reference_key, regular_amount, reason, source, created_at FROM pass_ledger WHERE member_id = ? ORDER BY created_at DESC LIMIT 200`).bind(memberId).all<Record<string, unknown>>(),
    db.prepare(`SELECT id, reservation_id, product_code, product_name, amount, status, payment_status, created_at FROM pass_purchase_orders WHERE member_id = ? AND status IN ('PENDING','PAYMENT_PENDING','REFUND_REVIEW') ORDER BY created_at DESC`).bind(memberId).all<Record<string, unknown>>(),
  ]);
  if (!member) throw new Error("MEMBER_NOT_FOUND");
  return {
    member,
    settings,
    products: configuredPassProducts(pricing),
    stampBalance: Number(stamp?.balance) || 0,
    passes: passResult.results.map(toPass),
    coupons: couponResult.results.map(toCoupon),
    stampHistory: stampHistory.results,
    passHistory: passHistory.results,
    pendingOrders: pendingOrders.results,
  };
}

async function expireMemberCoupons(memberId?: string) {
  const where = memberId ? " AND member_id = ?" : "";
  const statement = getD1().prepare(`UPDATE member_coupons
    SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'ACTIVE' AND datetime(expires_at) <= CURRENT_TIMESTAMP${where}`);
  if (memberId) await statement.bind(memberId).run();
  else await statement.run();
}

async function issueAutomaticStampCoupons(memberId: string, createdBy: string) {
  const db = getD1();
  for (let guard = 0; guard < 100; guard += 1) {
    const [balance, settings, issued] = await Promise.all([
      db.prepare(`SELECT COALESCE(SUM(amount), 0) AS balance FROM stamp_ledger WHERE member_id = ?`).bind(memberId).first<{ balance: number }>(),
      db.prepare(`SELECT stamp_goal FROM benefit_settings WHERE id = 1`).first<{ stamp_goal: number }>(),
      db.prepare(`SELECT COUNT(*) AS count FROM member_coupons WHERE member_id = ? AND coupon_type = 'STAMP_REWARD' AND source = 'STAMP_AUTO'`).bind(memberId).first<{ count: number }>(),
    ]);
    const goal = finiteInt(settings?.stamp_goal, 1, 100);
    if ((Number(balance?.balance) || 0) < goal) break;
    const cycle = (Number(issued?.count) || 0) + 1;
    const sourceReference = `stamp-auto:${memberId}:${cycle}`;
    const ledgerReference = `stamp-auto-use:${memberId}:${cycle}`;
    const couponId = crypto.randomUUID();
    const ledgerId = crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT INTO member_coupons (
        id, member_id, coupon_type, name, status, issued_at, expires_at,
        source, source_reference, issued_by
      ) SELECT ?, ?, 'STAMP_REWARD', '스탬프 적립 쿠폰', 'ACTIVE',
        CURRENT_TIMESTAMP, datetime('now', '+1 month'), 'STAMP_AUTO', ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM member_coupons WHERE source_reference = ?)`)
        .bind(couponId, memberId, sourceReference, createdBy, sourceReference),
      db.prepare(`INSERT INTO stamp_ledger (
        id, member_id, type, amount, reason, source, reference_key, created_by
      ) SELECT ?, ?, 'AUTO_COUPON', ?, ?, 'STAMP_AUTO', ?, ?
      WHERE EXISTS (SELECT 1 FROM member_coupons WHERE source_reference = ?)
        AND NOT EXISTS (SELECT 1 FROM stamp_ledger WHERE reference_key = ?)`)
        .bind(ledgerId, memberId, -goal, `스탬프 ${goal}개 자동 쿠폰 발급`, ledgerReference, createdBy, sourceReference, ledgerReference),
    ]);
  }
}

export async function grantWeekdayCoupons(memberId: string, quantity: number, createdBy: string) {
  await ensureMemberBenefitSchema();
  const count = Math.trunc(Number(quantity));
  if (!Number.isFinite(count) || count < 1 || count > 20) throw new Error("MEMBER_COUPON_QUANTITY_INVALID");
  const member = await getD1().prepare(`SELECT id FROM members WHERE id = ? AND status <> 'merged' LIMIT 1`).bind(memberId).first();
  if (!member) throw new Error("MEMBER_NOT_FOUND");
  const statements = Array.from({ length: count }, () => {
    const sourceReference = `weekday-admin:${crypto.randomUUID()}`;
    return getD1().prepare(`INSERT INTO member_coupons (
      id, member_id, coupon_type, name, status, issued_at, expires_at,
      source, source_reference, issued_by
    ) VALUES (?, ?, 'WEEKDAY_EVENT', '평일 이용 쿠폰', 'ACTIVE',
      CURRENT_TIMESTAMP, datetime('now', '+1 month'), 'ADMIN', ?, ?)`)
      .bind(crypto.randomUUID(), memberId, sourceReference, createdBy);
  });
  await getD1().batch(statements);
  return getMemberBenefits(memberId);
}

export async function cancelMemberCoupon(couponId: string, createdBy: string) {
  await ensureMemberBenefitSchema();
  const coupon = await getD1().prepare(`SELECT member_id, status FROM member_coupons WHERE id = ? LIMIT 1`).bind(couponId).first<{ member_id: string; status: string }>();
  if (!coupon) throw new Error("MEMBER_COUPON_NOT_FOUND");
  if (coupon.status === "USED") throw new Error("MEMBER_COUPON_ALREADY_USED");
  await getD1().prepare(`UPDATE member_coupons SET status = 'CANCELLED', issued_by = CASE WHEN issued_by = '' THEN ? ELSE issued_by END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('ACTIVE','EXPIRED')`)
    .bind(createdBy, couponId).run();
  return getMemberBenefits(coupon.member_id);
}

export async function validateMemberCouponForPayment(input: {
  couponId: string;
  reservationId: string;
  memberId: string | null;
}) {
  await ensureMemberBenefitSchema();
  await expireMemberCoupons(input.memberId || undefined);
  if (!input.couponId) throw new Error("MEMBER_COUPON_REQUIRED");
  if (!input.memberId) throw new Error("RESERVATION_MEMBER_REQUIRED_FOR_COUPON");
  const coupon = await getD1().prepare(`SELECT * FROM member_coupons WHERE id = ? LIMIT 1`).bind(input.couponId).first<CouponRow>();
  if (!coupon) throw new Error("MEMBER_COUPON_NOT_FOUND");
  if (coupon.member_id !== input.memberId) throw new Error("MEMBER_COUPON_MEMBER_MISMATCH");
  if (coupon.status !== "ACTIVE") throw new Error(coupon.status === "EXPIRED" ? "MEMBER_COUPON_EXPIRED" : "MEMBER_COUPON_NOT_ACTIVE");
  const reservation = await getD1().prepare(`SELECT member_id, scheduled_date, status, source FROM reservations WHERE id = ? LIMIT 1`)
    .bind(input.reservationId).first<{ member_id: string | null; scheduled_date: string; status: string; source: string }>();
  if (!reservation || reservation.member_id !== input.memberId) throw new Error("RESERVATION_MEMBER_MISMATCH");
  if (reservation.status === "cancelled") throw new Error("CANCELLED_RESERVATION");
  if (["member_pass_purchase", "add_on_sale_purchase"].includes(reservation.source)) throw new Error("MEMBER_COUPON_RESERVATION_ONLY");
  if (coupon.coupon_type === "WEEKDAY_EVENT") {
    const day = new Date(`${reservation.scheduled_date}T12:00:00+09:00`).getUTCDay();
    if (day === 0 || day === 6) throw new Error("WEEKDAY_COUPON_WEEKDAY_ONLY");
  }
  return toCoupon(coupon);
}

function addMonthsIso(months: number) {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString();
}

export async function createPassPurchaseOrder(
  memberId: string,
  productCode: string,
  requestedBy: string,
  creditReservationId: string | null = null,
  requestedCreditUses = 1,
) {
  await ensureMemberBenefitSchema();
  const [member, pricing, settings] = await Promise.all([
    getD1().prepare(`SELECT id, name, phone FROM members WHERE id = ? AND status <> 'merged' LIMIT 1`).bind(memberId).first<{ id: string; name: string; phone: string }>(),
    getPricingSettings(),
    getBenefitSettings(),
  ]);
  if (!member) throw new Error("MEMBER_NOT_FOUND");
  const product = configuredPassProducts(pricing).find((item) => item.code === productCode && item.active);
  if (!product) throw new Error("PASS_PRODUCT_NOT_FOUND");
  if (product.price <= 0) throw new Error("PASS_PRODUCT_PRICE_INVALID");
  let creditAmount = 0;
  let creditUses = 0;
  let creditAllocations: Array<{ reservationId: string; uses: number; amount: number }> = [];
  if (creditReservationId) {
    type CreditReservationRow = {
      id: string;
      member_id: string | null;
      repeat_group_id: string;
      repeat_sequence: number;
      scheduled_date: string;
      source: string;
      status: string;
      payment_status: string;
      adult_count: number;
      youth_count: number;
      total_count: number;
      base_amount: number;
      add_on_amount: number;
      payment_amount: number;
    };
    const creditReservation = await getD1().prepare(`SELECT
        id, member_id, repeat_group_id, repeat_sequence, scheduled_date,
        source, status, payment_status, adult_count, youth_count, total_count,
        base_amount, add_on_amount, payment_amount
      FROM reservations WHERE id = ? LIMIT 1`)
      .bind(creditReservationId)
      .first<CreditReservationRow>();
    if (!creditReservation || creditReservation.member_id !== memberId) {
      throw new Error("PASS_PURCHASE_CREDIT_MEMBER_MISMATCH");
    }
    if (creditReservation.source === "member_pass_purchase" || creditReservation.status === "cancelled") {
      throw new Error("PASS_PURCHASE_CREDIT_RESERVATION_INVALID");
    }
    if (creditReservation.payment_status !== "paid") {
      throw new Error("PASS_PURCHASE_CREDIT_NOT_PAID");
    }
    const linkedResult = creditReservation.repeat_group_id
      ? await getD1().prepare(`SELECT
          id, member_id, repeat_group_id, repeat_sequence, scheduled_date,
          source, status, payment_status, adult_count, youth_count, total_count,
          base_amount, add_on_amount, payment_amount
        FROM reservations
        WHERE repeat_group_id = ? AND member_id = ? AND scheduled_date = ?
        ORDER BY repeat_sequence, scheduled_time, created_at`)
        .bind(creditReservation.repeat_group_id, memberId, creditReservation.scheduled_date)
        .all<CreditReservationRow>()
      : { results: [creditReservation] };
    const candidates = linkedResult.results.filter((row) =>
      row.member_id === memberId &&
      row.source !== "member_pass_purchase" &&
      row.status !== "cancelled" &&
      row.payment_status === "paid"
    );
    const availability = await Promise.all(candidates.map(async (row) => {
      const [mappedCredit, legacyCredit, existingUse] = await Promise.all([
        getD1().prepare(`SELECT pc.order_id
          FROM pass_purchase_credits pc
          JOIN pass_purchase_orders po ON po.id = pc.order_id
          WHERE pc.reservation_id = ? AND po.status <> 'CANCELLED'
          LIMIT 1`).bind(row.id).first(),
        getD1().prepare(`SELECT id FROM pass_purchase_orders WHERE credit_reservation_id = ? AND status <> 'CANCELLED' LIMIT 1`).bind(row.id).first(),
        getD1().prepare(`SELECT u.id FROM pass_ledger u
          WHERE u.reservation_id = ? AND u.type = 'USE'
            AND NOT EXISTS (SELECT 1 FROM pass_ledger r WHERE r.type = 'RESTORE' AND r.reference_id = u.id)
          LIMIT 1`).bind(row.id).first(),
      ]);
      return { row, available: !mappedCredit && !legacyCredit && !existingUse };
    }));
    if (availability.some((item) => item.row.id === creditReservationId && !item.available)) {
      throw new Error("PASS_PURCHASE_CREDIT_ALREADY_USED");
    }
    const planCandidates = availability.filter((item) => item.available).map(({ row }) => ({
      id: row.id,
      adultCount: Number(row.adult_count) || 0,
      youthCount: Number(row.youth_count) || 0,
      totalCount: Number(row.total_count) || 0,
      paidGameAmount: Math.max(0, Math.min(
        Number(row.base_amount) || 0,
        (Number(row.payment_amount) || 0) - (Number(row.add_on_amount) || 0),
      )),
    }));
    const requestedUses = finiteInt(requestedCreditUses, 1, product.uses);
    const plan = buildPassCreditPlan({
      candidates: planCandidates,
      ageGroup: product.ageGroup,
      regularUnitPrice: product.regularUnitPrice,
      requestedUses,
      productUses: product.uses,
    });
    if (plan.availableUses < requestedUses || plan.usedUses !== requestedUses) {
      throw new Error("PASS_PURCHASE_CREDIT_INSUFFICIENT");
    }
    creditUses = plan.usedUses;
    creditAmount = Math.min(product.price, plan.creditAmount);
    creditAllocations = plan.allocations;
  }
  const amount = Math.max(0, product.price - creditAmount);
  const id = crypto.randomUUID();
  const bookingCode = `PASS-${id.slice(0, 8).toUpperCase()}`;
  const expiresAt = addMonthsIso(settings.passValidityMonths);
  await getD1().batch([
    getD1().prepare(`INSERT INTO reservations (
      id, booking_code, source, customer_name, customer_phone, member_id,
      scheduled_date, scheduled_time, team_name, difficulty_label, base_amount,
      payment_amount, payment_status, status, memo, idempotency_key
    ) VALUES (?, ?, 'member_pass_purchase', ?, ?, ?, '0001-01-01', '00:00', ?,
      '다회권 구매', ?, ?, 'unpaid', 'completed', ?, ?)`)
      .bind(
        id,
        bookingCode,
        member.name,
        member.phone,
        member.id,
        product.name,
        amount,
        amount,
        creditAmount > 0
          ? `회원탭 다회권 구매 · 기존 게임비 ${creditAmount.toLocaleString("ko-KR")}원 차감 · ${creditUses}회 사용`
          : "회원탭 다회권 구매",
        `pass-purchase:${id}`,
      ),
    getD1().prepare(`INSERT INTO pass_purchase_orders (
      id, reservation_id, member_id, product_code, product_name, age_group,
      purchased_uses, amount, list_amount, credit_amount, credit_reservation_id,
      initial_used_uses, regular_unit_price, expires_at, requested_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        id, id, member.id, product.code, product.name, product.ageGroup,
        product.uses, amount, product.price, creditAmount, creditAllocations[0]?.reservationId ?? null,
        creditUses, product.regularUnitPrice, expiresAt, requestedBy,
      ),
    ...creditAllocations.map((allocation, index) => getD1().prepare(`INSERT INTO pass_purchase_credits (
      order_id, reservation_id, sequence, used_uses, credit_amount
    ) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, allocation.reservationId, index + 1, allocation.uses, allocation.amount)),
  ]);
  if (amount === 0) {
    await syncPassPurchasePayment(id, "PAID", {}, "");
    await getD1().prepare(`UPDATE reservations SET payment_status = 'paid', payment_method = 'coupon', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(id).run();
  }
  return {
    orderId: id,
    reservationId: id,
    product,
    expiresAt,
    listAmount: product.price,
    creditAmount,
    creditReservationId: creditAllocations[0]?.reservationId ?? null,
    creditReservationIds: creditAllocations.map((item) => item.reservationId),
    initialUsedUses: creditUses,
    paymentAmount: amount,
  };
}

export async function assertPassPurchaseRefundable(reservationId: string) {
  await ensureMemberBenefitSchema();
  const row = await getD1().prepare(`SELECT mp.purchased_uses, mp.remaining_uses
    FROM pass_purchase_orders po JOIN member_passes mp ON mp.id = po.member_pass_id
    WHERE po.reservation_id = ? LIMIT 1`).bind(reservationId).first<{ purchased_uses: number; remaining_uses: number }>();
  if (row && Number(row.remaining_uses) !== Number(row.purchased_uses)) {
    throw new Error("PASS_PURCHASE_PARTIALLY_USED");
  }
}

export async function syncPassPurchasePayment(
  reservationId: string,
  status: string,
  completedByMethod: Record<string, number>,
  paymentId: string,
) {
  await ensureMemberBenefitSchema();
  const db = getD1();
  const order = await db.prepare(`SELECT * FROM pass_purchase_orders WHERE reservation_id = ? LIMIT 1`).bind(reservationId).first<PurchaseOrderRow>();
  if (!order) return;
  if (status === "PAID") {
    const passId = `member-pass:${order.id}`;
    const ledgerId = `pass-ledger:purchase:${order.id}`;
    const storedCredits = await db.prepare(`SELECT reservation_id, used_uses, credit_amount
      FROM pass_purchase_credits WHERE order_id = ? ORDER BY sequence, created_at`)
      .bind(order.id).all<{ reservation_id: string; used_uses: number; credit_amount: number }>();
    const creditRows = storedCredits.results.length > 0
      ? storedCredits.results
      : order.credit_reservation_id && Number(order.initial_used_uses) > 0
        ? [{
            reservation_id: order.credit_reservation_id,
            used_uses: Number(order.initial_used_uses) || 0,
            credit_amount: Number(order.credit_amount) || 0,
          }]
        : [];
    const initialUsedUses = Math.min(
      Number(order.purchased_uses) || 0,
      creditRows.reduce((total, item) => total + Math.max(0, Number(item.used_uses) || 0), 0),
    );
    const remainingUses = Math.max(0, Number(order.purchased_uses) - initialUsedUses);
    const transaction = await db.prepare(`SELECT id, payment_method FROM payment_attempts
      WHERE reservation_id = ? AND attempt_type = 'PAY' AND status IN ('APPROVED','COMPLETED')
      ORDER BY completed_at DESC, requested_at DESC LIMIT 1`).bind(reservationId).first<{ id: string; payment_method: string }>();
    const methods = Object.entries(completedByMethod).filter(([, amount]) => Number(amount) > 0).map(([method]) => method);
    const paymentMethod = methods.length > 1 ? "mixed" : methods[0] ?? transaction?.payment_method ?? "";
    const statements = [
      db.prepare(`INSERT INTO member_passes (
        id, member_id, product_code, product_name_at_purchase, age_group,
        purchased_uses, remaining_uses, purchase_price, regular_unit_price_at_purchase,
        expires_at, status, payment_id, payment_transaction_id, payment_method,
        purchase_card_amount, purchase_cash_amount, purchase_account_amount,
        purchase_order_id, source, source_reference
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'POS_PURCHASE', ?)
      ON CONFLICT(source_reference) DO NOTHING`)
        .bind(passId, order.member_id, order.product_code, order.product_name, order.age_group,
          order.purchased_uses, remainingUses, order.amount, order.regular_unit_price,
          order.expires_at, remainingUses === 0 ? "USED_UP" : "ACTIVE", paymentId, transaction?.id ?? null, paymentMethod,
          Number(completedByMethod.card) || 0, Number(completedByMethod.cash) || 0,
          Number(completedByMethod.account) || 0, order.id, `pos-purchase:${order.id}`),
      db.prepare(`INSERT INTO pass_ledger (
        id, member_pass_id, member_id, type, uses, payment_id, reference_id,
        reference_key, reason, source, created_by
      ) VALUES (?, ?, ?, 'PURCHASE', ?, ?, ?, ?, '다회권 구매', 'POS_PURCHASE', 'payment-engine')
      ON CONFLICT(reference_key) DO NOTHING`)
        .bind(ledgerId, passId, order.member_id, order.purchased_uses, paymentId, order.id, `purchase:${order.id}`),
      db.prepare(`UPDATE pass_purchase_orders SET status = 'PAID', payment_status = 'PAID', payment_id = ?, member_pass_id = ?, paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(paymentId, passId, order.id),
      db.prepare(`UPDATE payments SET payment_type = 'PASS_PURCHASE', member_id = ?, member_pass_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(order.member_id, passId, paymentId),
      db.prepare(`UPDATE payment_attempts SET member_id = ?, member_pass_id = ? WHERE payment_id = ?`)
        .bind(order.member_id, passId, paymentId),
    ];
    for (const credit of creditRows) {
      const usedUses = Math.max(0, Number(credit.used_uses) || 0);
      if (usedUses < 1) continue;
      statements.push(
        db.prepare(`INSERT INTO pass_ledger (
          id, member_pass_id, member_id, type, uses, reservation_id, payment_id,
          reference_id, reference_key, regular_amount, reason, source, created_by
        ) VALUES (?, ?, ?, 'USE', ?, ?, ?, ?, ?, ?, ?, 'POS_PURCHASE', 'payment-engine')
        ON CONFLICT(reference_key) DO NOTHING`)
          .bind(
            `pass-ledger:credit-use:${order.id}:${credit.reservation_id}`,
            passId,
            order.member_id,
            -usedUses,
            credit.reservation_id,
            paymentId,
            order.id,
            `purchase-credit-use:${order.id}:${credit.reservation_id}`,
            Number(credit.credit_amount) || 0,
            `다회권 구매 전환 ${usedUses}회 사용`,
          ),
        db.prepare(`UPDATE reservations SET memo = CASE
          WHEN instr(memo, '다회권 사용') > 0 THEN memo
          WHEN trim(memo) = '' THEN '다회권 사용'
          ELSE rtrim(memo) || char(10) || '다회권 사용'
        END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(credit.reservation_id),
      );
    }
    await db.batch(statements);
    return;
  }
  if (status === "CANCELLED") {
    const pass = order.member_pass_id
      ? await db.prepare(`SELECT * FROM member_passes WHERE id = ? LIMIT 1`).bind(order.member_pass_id).first<PassRow>()
      : null;
    if (pass && Number(pass.remaining_uses) !== Number(pass.purchased_uses)) {
      await db.prepare(`UPDATE pass_purchase_orders SET status = 'REFUND_REVIEW', payment_status = 'PARTIALLY_CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(order.id).run();
      return;
    }
    const statements = [
      db.prepare(`UPDATE pass_purchase_orders SET status = 'CANCELLED', payment_status = 'CANCELLED', cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(order.id),
    ];
    if (pass) {
      statements.push(
        db.prepare(`UPDATE member_passes SET remaining_uses = 0, status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(pass.id),
        db.prepare(`INSERT INTO pass_ledger (id, member_pass_id, member_id, type, uses, payment_id, reference_id, reference_key, reason, source, created_by)
          VALUES (?, ?, ?, 'CANCEL', ?, ?, ?, ?, '미사용 다회권 구매 취소', 'POS_PURCHASE', 'payment-engine')
          ON CONFLICT(reference_key) DO NOTHING`).bind(`pass-ledger:cancel:${order.id}`, pass.id, pass.member_id, -Number(pass.remaining_uses), paymentId, order.id, `purchase-cancel:${order.id}`),
      );
    }
    await db.batch(statements);
  } else {
    await db.prepare(`UPDATE pass_purchase_orders SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(status, order.id).run();
  }
}

export async function earnStampForCompletedReservation(reservationId: string, createdBy: string) {
  await ensureMemberBenefitSchema();
  const [reservation, settings] = await Promise.all([
    getD1().prepare(`SELECT member_id, status, source, total_count FROM reservations WHERE id = ? LIMIT 1`).bind(reservationId).first<{
      member_id: string | null;
      status: string;
      source: string;
      total_count: number;
    }>(),
    getBenefitSettings(),
  ]);
  if (!reservation?.member_id || reservation.status !== "completed" || reservation.source === "kiosk_walkin" || settings.stampEarnPerGame <= 0) return false;
  const [passUses, memberCouponUses, legacyCouponUses] = await Promise.all([
    getD1().prepare(`SELECT COALESCE(SUM(ABS(u.uses)), 0) AS uses
      FROM pass_ledger u
      WHERE u.reservation_id = ? AND u.type = 'USE'
        AND NOT EXISTS (SELECT 1 FROM pass_ledger r WHERE r.type = 'RESTORE' AND r.reference_id = u.id)`)
      .bind(reservationId).first<{ uses: number }>(),
    getD1().prepare(`SELECT COUNT(*) AS uses FROM member_coupons
      WHERE used_reservation_id = ? AND status = 'USED'`)
      .bind(reservationId).first<{ uses: number }>(),
    getD1().prepare(`SELECT COUNT(*) AS uses FROM stamp_ledger u
      WHERE u.reservation_id = ? AND u.type = 'USE'
        AND NOT EXISTS (
          SELECT 1 FROM stamp_ledger c
          WHERE c.reference_key = 'stamp-cancel:' || u.id
        )`)
      .bind(reservationId).first<{ uses: number }>(),
  ]);
  const stampAmount = stampAwardQuantity({
    partyCount: Number(reservation.total_count) || 0,
    passUses: Number(passUses?.uses) || 0,
    couponUses: (Number(memberCouponUses?.uses) || 0) + (Number(legacyCouponUses?.uses) || 0),
    stampsPerParticipant: settings.stampEarnPerGame,
  });
  if (stampAmount <= 0) return false;
  const result = await getD1().prepare(`INSERT INTO stamp_ledger (
    id, member_id, reservation_id, type, amount, reason, source, reference_key, created_by
  ) SELECT ?, ?, ?, 'EARN', ?, '게임 이용 완료', 'RESERVATION', ?, ?
  ON CONFLICT(reference_key) DO NOTHING`)
    .bind(
      crypto.randomUUID(),
      reservation.member_id,
      reservationId,
      stampAmount,
      `stamp-earn:reservation:${reservationId}`,
      createdBy,
    ).run();
  const earned = Number(result.meta.changes ?? 0) === 1;
  if (earned) await issueAutomaticStampCoupons(reservation.member_id, createdBy);
  return earned;
}

export async function redeemStampBenefit(memberId: string, reservationId: string | null, createdBy: string) {
  const benefits = await getMemberBenefits(memberId);
  if (benefits.stampBalance < benefits.settings.stampGoal) throw new Error("STAMP_BALANCE_INSUFFICIENT");
  let referenceKey = `stamp-use:manual:${crypto.randomUUID()}`;
  if (reservationId) {
    const uses = await getD1().prepare(`SELECT u.id FROM stamp_ledger u
      LEFT JOIN stamp_ledger c ON c.reference_key = 'stamp-cancel:' || u.id
      WHERE u.member_id = ? AND u.reservation_id = ? AND u.type = 'USE' AND c.id IS NULL`)
      .bind(memberId, reservationId).all<{ id: string }>();
    if (uses.results.length) return getMemberBenefits(memberId);
    const count = await getD1().prepare(`SELECT COUNT(*) AS count FROM stamp_ledger
      WHERE member_id = ? AND reservation_id = ? AND type = 'USE'`)
      .bind(memberId, reservationId).first<{ count: number }>();
    referenceKey = `stamp-use:reservation:${reservationId}:${Number(count?.count) + 1}`;
  }
  await getD1().prepare(`INSERT INTO stamp_ledger (
    id, member_id, reservation_id, type, amount, reason, source, reference_key, created_by
  ) VALUES (?, ?, ?, 'USE', ?, '스탬프 혜택 사용', 'POS', ?, ?)`)
    .bind(crypto.randomUUID(), memberId, reservationId, -benefits.settings.stampGoal, referenceKey, createdBy).run();
  return getMemberBenefits(memberId);
}

export async function cancelStampUse(ledgerId: string, createdBy: string) {
  await ensureMemberBenefitSchema();
  const db = getD1();
  const use = await db.prepare(`SELECT id, member_id, reservation_id, amount
    FROM stamp_ledger WHERE id = ? AND type = 'USE' LIMIT 1`)
    .bind(ledgerId).first<{ id: string; member_id: string; reservation_id: string | null; amount: number }>();
  if (!use) throw new Error("STAMP_USE_NOT_FOUND");
  const referenceKey = `stamp-cancel:${use.id}`;
  await db.prepare(`INSERT INTO stamp_ledger (
    id, member_id, reservation_id, type, amount, reason, source, reference_key, created_by
  ) VALUES (?, ?, ?, 'CANCEL', ?, '스탬프 사용 취소', 'POS', ?, ?)
  ON CONFLICT(reference_key) DO NOTHING`)
    .bind(crypto.randomUUID(), use.member_id, use.reservation_id, Math.abs(Number(use.amount) || 0), referenceKey, createdBy).run();
  return getMemberBenefits(use.member_id);
}

export async function adjustStamp(memberId: string, amount: number, reason: string, createdBy: string) {
  await ensureMemberBenefitSchema();
  const value = Math.max(-100, Math.min(100, Math.trunc(amount)));
  if (!value) throw new Error("STAMP_ADJUST_AMOUNT_INVALID");
  await getD1().prepare(`INSERT INTO stamp_ledger (
    id, member_id, type, amount, reason, source, reference_key, created_by
  ) VALUES (?, ?, 'ADJUST', ?, ?, 'ADMIN', ?, ?)`)
    .bind(crypto.randomUUID(), memberId, value, safeText(reason || "관리자 조정", 200), `stamp-adjust:${crypto.randomUUID()}`, createdBy).run();
  return getMemberBenefits(memberId);
}

export async function redeemMemberPass(
  memberPassId: string,
  reservationId: string | null,
  createdBy: string,
  requestedUses = 1,
) {
  await ensureMemberBenefitSchema();
  const db = getD1();
  const pass = await db.prepare(`SELECT * FROM member_passes WHERE id = ? LIMIT 1`).bind(memberPassId).first<PassRow>();
  if (!pass) throw new Error("MEMBER_PASS_NOT_FOUND");
  if (pass.status !== "ACTIVE" || Number(pass.remaining_uses) <= 0) throw new Error("MEMBER_PASS_NOT_ACTIVE");
  if (pass.expires_at && Date.parse(pass.expires_at) < Date.now()) throw new Error("MEMBER_PASS_EXPIRED");
  const uses = Math.trunc(Number(requestedUses));
  if (!Number.isFinite(uses) || uses < 1 || uses > Number(pass.remaining_uses)) {
    throw new Error("MEMBER_PASS_USES_INVALID");
  }

  let referenceKey = `pass-use:manual:${crypto.randomUUID()}`;
  let appliedDiscount = Number(pass.regular_unit_price_at_purchase) * uses;
  if (reservationId) {
    const count = await db.prepare(`SELECT COUNT(*) AS count FROM pass_ledger
      WHERE member_id = ? AND reservation_id = ? AND type = 'USE'`)
      .bind(pass.member_id, reservationId).first<{ count: number }>();
    referenceKey = `pass-use:reservation:${reservationId}:${Number(count?.count) + 1}`;

    const reservation = await db.prepare(`SELECT member_id, status, total_count,
      base_amount, add_on_amount, discount_amount
      FROM reservations WHERE id = ? LIMIT 1`).bind(reservationId).first<{
        member_id: string | null;
        status: string;
        total_count: number;
        base_amount: number;
        add_on_amount: number;
        discount_amount: number;
      }>();
    if (!reservation || reservation.member_id !== pass.member_id) throw new Error("RESERVATION_MEMBER_MISMATCH");
    if (reservation.status === "cancelled") throw new Error("CANCELLED_RESERVATION");
    const payment = await db.prepare(`SELECT id FROM payments WHERE reservation_id = ? AND status <> 'CANCELLED' LIMIT 1`).bind(reservationId).first();
    if (payment) throw new Error("PASS_USE_PAYMENT_PLAN_EXISTS");
    const activeUses = await db.prepare(`SELECT COALESCE(SUM(ABS(u.uses)), 0) AS uses
      FROM pass_ledger u
      WHERE u.reservation_id = ? AND u.type = 'USE'
        AND NOT EXISTS (SELECT 1 FROM pass_ledger r WHERE r.type = 'RESTORE' AND r.reference_id = u.id)`)
      .bind(reservationId).first<{ uses: number }>();
    if ((Number(activeUses?.uses) || 0) + uses > Number(reservation.total_count)) {
      throw new Error("MEMBER_PASS_USES_EXCEED_PEOPLE");
    }
    appliedDiscount = quotePassUse({
      baseAmount: Number(reservation.base_amount),
      addOnAmount: Number(reservation.add_on_amount),
      discountAmount: Number(reservation.discount_amount),
      regularUnitPrice: Number(pass.regular_unit_price_at_purchase),
      uses,
    }).appliedDiscount;
  }

  const remaining = Number(pass.remaining_uses) - uses;
  const passUseLedgerId = crypto.randomUUID();
  const stampSettings = reservationId ? await getBenefitSettings() : null;
  const stampCancelAmount = uses * Math.max(0, Number(stampSettings?.stampEarnPerGame) || 0);
  const statements = [
    db.prepare(`UPDATE member_passes SET remaining_uses = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'ACTIVE' AND remaining_uses >= ?`)
      .bind(remaining, remaining === 0 ? "USED_UP" : "ACTIVE", pass.id, uses),
    db.prepare(`INSERT INTO pass_ledger (
      id, member_pass_id, member_id, type, uses, reservation_id, reference_key,
      regular_amount, reason, source, created_by
    ) VALUES (?, ?, ?, 'USE', ?, ?, ?, ?, ?, 'POS', ?)`)
      .bind(passUseLedgerId, pass.id, pass.member_id, -uses, reservationId, referenceKey, appliedDiscount, `다회권 ${uses}회 사용`, createdBy),
  ];
  if (reservationId) {
    statements.push(db.prepare(`UPDATE reservations SET
      discount_amount = MIN(base_amount, discount_amount + ?),
      payment_amount = MAX(0, base_amount + add_on_amount - MIN(base_amount, discount_amount + ?)),
      payment_status = CASE WHEN MAX(0, base_amount + add_on_amount - MIN(base_amount, discount_amount + ?)) = 0 THEN 'paid' ELSE 'unpaid' END,
      memo = CASE
        WHEN instr(memo, '다회권 사용') > 0 THEN memo
        WHEN trim(memo) = '' THEN '다회권 사용'
        ELSE rtrim(memo) || char(10) || '다회권 사용'
      END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(appliedDiscount, appliedDiscount, appliedDiscount, reservationId));
    statements.push(db.prepare(`INSERT OR IGNORE INTO stamp_ledger (
      id, member_id, reservation_id, type, amount, reason, source, reference_key, created_by
    ) SELECT ?, earned.member_id, earned.reservation_id, 'CANCEL', -MIN(ABS(earned.amount), ?),
      '다회권 사용으로 스탬프 적립 취소', 'PASS', ?, ?
    FROM stamp_ledger earned
    WHERE earned.reference_key = ? AND earned.type = 'EARN'
    LIMIT 1`)
      .bind(
        `stamp-ledger:pass-use-cancel:${passUseLedgerId}`,
        stampCancelAmount,
        `stamp-cancel:pass-use:${passUseLedgerId}`,
        createdBy,
        `stamp-earn:reservation:${reservationId}`,
      ));
  }
  await db.batch(statements);
  return getMemberBenefits(pass.member_id);
}

export async function restorePassUse(ledgerId: string, createdBy: string) {
  await ensureMemberBenefitSchema();
  const db = getD1();
  const use = await db.prepare(`SELECT * FROM pass_ledger WHERE id = ? AND type = 'USE' LIMIT 1`).bind(ledgerId).first<Record<string, unknown>>();
  if (!use) throw new Error("PASS_USE_NOT_FOUND");
  const referenceKey = `pass-restore:${ledgerId}`;
  const existing = await db.prepare(`SELECT id FROM pass_ledger WHERE reference_key = ? LIMIT 1`).bind(referenceKey).first();
  if (existing) return getMemberBenefits(String(use.member_id));
  const pass = await db.prepare(`SELECT * FROM member_passes WHERE id = ? LIMIT 1`).bind(String(use.member_pass_id)).first<PassRow>();
  if (!pass) throw new Error("MEMBER_PASS_NOT_FOUND");
  const reservationId = use.reservation_id ? String(use.reservation_id) : null;
  if (reservationId) {
    const payment = await db.prepare(`SELECT id FROM payments WHERE reservation_id = ? AND status <> 'CANCELLED' LIMIT 1`).bind(reservationId).first();
    if (payment) throw new Error("PASS_USE_PAYMENT_PLAN_EXISTS");
  }
  const restoredUses = Math.max(1, Math.abs(Number(use.uses) || 1));
  const statements = [
    db.prepare(`UPDATE member_passes SET remaining_uses = MIN(purchased_uses, remaining_uses + ?), status = CASE WHEN status = 'CANCELLED' THEN status ELSE 'ACTIVE' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(restoredUses, pass.id),
    db.prepare(`INSERT INTO pass_ledger (
      id, member_pass_id, member_id, type, uses, reservation_id, reference_id,
      reference_key, regular_amount, reason, source, created_by
    ) VALUES (?, ?, ?, 'RESTORE', ?, ?, ?, ?, ?, ?, 'POS', ?)`)
      .bind(crypto.randomUUID(), pass.id, pass.member_id, restoredUses, reservationId, ledgerId, referenceKey, Number(use.regular_amount) || 0, `다회권 ${restoredUses}회 사용 취소`, createdBy),
  ];
  if (reservationId) {
    const regularAmount = Number(use.regular_amount) || 0;
    statements.push(db.prepare(`UPDATE reservations SET
      discount_amount = MAX(0, discount_amount - ?),
      payment_amount = MAX(0, base_amount + add_on_amount - MAX(0, discount_amount - ?)),
      payment_status = CASE WHEN MAX(0, base_amount + add_on_amount - MAX(0, discount_amount - ?)) > 0 THEN 'unpaid' ELSE payment_status END,
      memo = CASE WHEN EXISTS (
        SELECT 1 FROM pass_ledger active_use
        WHERE active_use.reservation_id = ? AND active_use.type = 'USE' AND active_use.id <> ?
          AND NOT EXISTS (
            SELECT 1 FROM pass_ledger restored
            WHERE restored.type = 'RESTORE' AND restored.reference_id = active_use.id
          )
      ) THEN memo ELSE trim(replace(replace(replace(
          memo,
          char(10) || '다회권 사용',
          ''
        ), '다회권 사용' || char(10), ''), '다회권 사용', '')) END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(regularAmount, regularAmount, regularAmount, reservationId, ledgerId, reservationId));
    statements.push(db.prepare(`INSERT OR IGNORE INTO stamp_ledger (
      id, member_id, reservation_id, type, amount, reason, source, reference_key, created_by
    ) SELECT ?, cancelled.member_id, cancelled.reservation_id, 'ADJUST', ABS(cancelled.amount),
      '다회권 사용 취소로 스탬프 복원', 'PASS', ?, ?
    FROM stamp_ledger cancelled
    WHERE cancelled.reference_key IN (?, ?)
      AND cancelled.type = 'CANCEL'
    ORDER BY cancelled.created_at DESC
    LIMIT 1`)
      .bind(
        `stamp-ledger:pass-use-restore:${ledgerId}`,
        `stamp-restore:pass-use:${ledgerId}`,
        createdBy,
        `stamp-cancel:pass-use:${ledgerId}`,
        `stamp-cancel:pass-use:${reservationId}`,
      ));
  }
  await db.batch(statements);
  return getMemberBenefits(pass.member_id);
}

export async function previewLegacyMembers(input: LegacyMemberInput[]) {
  await ensureMemberBenefitSchema();
  const db = getD1();
  const [existingResult, mappedResult] = await Promise.all([
    db.prepare(`SELECT id, normalized_phone FROM members`).all<{ id: string; normalized_phone: string }>(),
    db.prepare(`SELECT legacy_member_id, member_id FROM legacy_migration_map WHERE legacy_source = ?`).bind(LEGACY_SOURCE).all<{ legacy_member_id: string; member_id: string }>(),
  ]);
  const existing = new Map(existingResult.results.map((row) => [row.normalized_phone, row.id]));
  const mapped = new Map(mappedResult.results.map((row) => [row.legacy_member_id, row.member_id]));
  const seen = new Map<string, string>();
  const actions: Array<{ legacyId: string; phoneLast4: string; action: string; memberId: string; reason: string }> = [];
  for (const item of input) {
    const phone = normalizeMemberPhone(item.phone || item.legacyId);
    let action = "CREATE";
    let memberId = "";
    let reason = "";
    if (mapped.has(item.legacyId)) {
      action = "SKIP";
      memberId = mapped.get(item.legacyId) ?? "";
      reason = "이미 마이그레이션됨";
    } else if (phone.length < 9) {
      action = "ERROR";
      reason = "전화번호 없음 또는 형식 오류";
    } else if (seen.has(phone) && seen.get(phone) !== item.legacyId) {
      action = "CONFLICT";
      reason = "레거시 내 중복 전화번호";
    } else if (existing.has(phone)) {
      action = "MERGE";
      memberId = existing.get(phone) ?? "";
    }
    seen.set(phone, item.legacyId);
    actions.push({ legacyId: item.legacyId, phoneLast4: phone.slice(-4), action, memberId, reason });
  }
  const count = (action: string) => actions.filter((item) => item.action === action).length;
  return {
    total: input.length,
    create: count("CREATE"), merge: count("MERGE"), skip: count("SKIP"),
    conflict: count("CONFLICT"), error: count("ERROR"),
    stampHolders: input.filter((item) => finiteInt(item.stamp) > 0).length,
    passHolders: input.filter((item) => item.passes.some((pass) => finiteInt(pass.remainingUses) > 0)).length,
    actions,
  };
}

export async function createLegacyMigrationBackup(createdBy: string) {
  await ensureMemberBenefitSchema();
  const db = getD1();
  const [members, stamps, passes, ledger, coupons] = await Promise.all([
    db.prepare(`SELECT * FROM members ORDER BY id`).all(),
    db.prepare(`SELECT * FROM stamp_ledger ORDER BY id`).all(),
    db.prepare(`SELECT * FROM member_passes ORDER BY id`).all(),
    db.prepare(`SELECT * FROM pass_ledger ORDER BY id`).all(),
    db.prepare(`SELECT * FROM member_coupons ORDER BY id`).all(),
  ]);
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO legacy_migration_backups (
    id, legacy_source, members_json, stamp_ledger_json, member_passes_json,
    pass_ledger_json, member_coupons_json, created_by
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, LEGACY_SOURCE, JSON.stringify(members.results), JSON.stringify(stamps.results), JSON.stringify(passes.results), JSON.stringify(ledger.results), JSON.stringify(coupons.results), createdBy).run();
  return { id, memberCount: members.results.length, stampRows: stamps.results.length, passRows: passes.results.length, passLedgerRows: ledger.results.length, couponRows: coupons.results.length };
}

export async function getLegacyMigrationStats() {
  await ensureMemberBenefitSchema();
  const db = getD1();
  const [mapping, members, profiles, stamps, passes, ledgers, backups] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM legacy_migration_map WHERE legacy_source = ?`).bind(LEGACY_SOURCE).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(DISTINCT member_id) AS count FROM legacy_migration_map WHERE legacy_source = ?`).bind(LEGACY_SOURCE).first<{ count: number }>(),
    db.prepare(`SELECT
        SUM(CASE WHEN trim(m.team_name) <> '' THEN 1 ELSE 0 END) AS teams,
        SUM(CASE WHEN trim(m.email) <> '' THEN 1 ELSE 0 END) AS emails,
        SUM(CASE WHEN trim(m.vehicle_number) <> '' THEN 1 ELSE 0 END) AS vehicles
      FROM legacy_migration_map lm
      JOIN members m ON m.id = lm.member_id
      WHERE lm.legacy_source = ?`).bind(LEGACY_SOURCE).first<{ teams: number; emails: number; vehicles: number }>(),
    db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(amount), 0) AS balance FROM stamp_ledger WHERE source = ? AND type = 'MIGRATION'`).bind(LEGACY_SOURCE).first<{ rows: number; balance: number }>(),
    db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(remaining_uses), 0) AS balance FROM member_passes WHERE source = ?`).bind(LEGACY_SOURCE).first<{ rows: number; balance: number }>(),
    db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(uses), 0) AS balance FROM pass_ledger WHERE source = ? AND type = 'MIGRATION'`).bind(LEGACY_SOURCE).first<{ rows: number; balance: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM legacy_migration_backups WHERE legacy_source = ?`).bind(LEGACY_SOURCE).first<{ count: number }>(),
  ]);
  return {
    mappingRows: Number(mapping?.count) || 0,
    memberRows: Number(members?.count) || 0,
    teamProfiles: Number(profiles?.teams) || 0,
    emailProfiles: Number(profiles?.emails) || 0,
    vehicleProfiles: Number(profiles?.vehicles) || 0,
    stampLedgerRows: Number(stamps?.rows) || 0,
    stampBalance: Number(stamps?.balance) || 0,
    memberPassRows: Number(passes?.rows) || 0,
    remainingPassUses: Number(passes?.balance) || 0,
    passLedgerRows: Number(ledgers?.rows) || 0,
    passLedgerBalance: Number(ledgers?.balance) || 0,
    backupRows: Number(backups?.count) || 0,
  };
}

export async function refreshLegacyMemberProfiles(input: LegacyMemberInput[], backupId: string) {
  await ensureMemberBenefitSchema();
  const db = getD1();
  const backup = await db.prepare(`SELECT id FROM legacy_migration_backups
    WHERE id = ? AND legacy_source = ? LIMIT 1`).bind(backupId, LEGACY_SOURCE).first();
  if (!backup) throw new Error("LEGACY_MIGRATION_BACKUP_REQUIRED");
  const counts = { updated: 0, missingMapping: 0, missingMember: 0 };
  for (const item of input) {
    const mapped = await db.prepare(`SELECT member_id FROM legacy_migration_map
      WHERE legacy_source = ? AND legacy_member_id = ? LIMIT 1`)
      .bind(LEGACY_SOURCE, item.legacyId).first<{ member_id: string }>();
    if (!mapped) { counts.missingMapping += 1; continue; }
    const result = await db.prepare(`UPDATE members SET
        name = CASE WHEN trim(name) = '' OR name = '이름 미상' THEN ? ELSE name END,
        team_name = CASE WHEN trim(team_name) = '' THEN ? ELSE team_name END,
        email = CASE WHEN trim(email) = '' THEN ? ELSE email END,
        vehicle_number = CASE WHEN trim(vehicle_number) = '' THEN ? ELSE vehicle_number END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`)
      .bind(safeText(item.name, 40) || "이름 미상", safeText(item.team, 80),
        safeText(item.email, 160), safeText(item.car, 20), mapped.member_id)
      .run();
    if (Number(result.meta.changes ?? 0) > 0) counts.updated += 1;
    else counts.missingMember += 1;
  }
  return counts;
}

async function stableId(prefix: string, value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const token = Array.from(new Uint8Array(hash)).slice(0, 16).map((part) => part.toString(16).padStart(2, "0")).join("");
  return `${prefix}:${token}`;
}

function legacyMemo(item: LegacyMemberInput) {
  const parts = [item.note && `기존메모: ${safeText(item.note, 300)}`].filter(Boolean);
  return parts.join(" · ").slice(0, 1000);
}

function validIso(value: unknown) {
  const text = safeText(value, 40);
  return Number.isFinite(Date.parse(text)) ? text : null;
}

function legacyRegularPrice(productCode: string, pricing: PricingSettings) {
  if (productCode.startsWith("YOUTH_")) return pricing.youthPrice;
  if (productCode.startsWith("ADULT_")) return pricing.adultPrice;
  return 0;
}

export async function applyLegacyMembers(input: LegacyMemberInput[], backupId: string, createdBy: string) {
  const preview = await previewLegacyMembers(input);
  if (preview.conflict || preview.error) throw new Error("LEGACY_MIGRATION_HAS_CONFLICTS");
  const backup = await getD1().prepare(`SELECT id FROM legacy_migration_backups WHERE id = ? AND legacy_source = ? LIMIT 1`).bind(backupId, LEGACY_SOURCE).first();
  if (!backup) throw new Error("LEGACY_MIGRATION_BACKUP_REQUIRED");
  const pricing = await getPricingSettings();
  const counts = { created: 0, merged: 0, skipped: 0, stamps: 0, passes: 0, coupons: 0 };
  for (const item of input) {
    const mapped = await getD1().prepare(`SELECT member_id FROM legacy_migration_map WHERE legacy_source = ? AND legacy_member_id = ? LIMIT 1`).bind(LEGACY_SOURCE, item.legacyId).first<{ member_id: string }>();
    if (mapped) { counts.skipped += 1; continue; }
    const phone = normalizeMemberPhone(item.phone || item.legacyId);
    const existing = await getD1().prepare(`SELECT id, name, memo FROM members WHERE normalized_phone = ? LIMIT 1`).bind(phone).first<{ id: string; name: string; memo: string }>();
    const memberId = existing?.id ?? await stableId("legacy-member", item.legacyId);
    const action = existing ? "MERGE" : "CREATE";
    const memo = legacyMemo(item);
    const statements = [];
    if (existing) {
      const mergedMemo = [existing.memo, memo].filter(Boolean).join(" · ").slice(0, 1000);
      statements.push(getD1().prepare(`UPDATE members SET
        name = CASE WHEN trim(name) = '' OR name = '이름 미상' THEN ? ELSE name END,
        team_name = CASE WHEN trim(team_name) = '' THEN ? ELSE team_name END,
        email = CASE WHEN trim(email) = '' THEN ? ELSE email END,
        vehicle_number = CASE WHEN trim(vehicle_number) = '' THEN ? ELSE vehicle_number END,
        memo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(safeText(item.name, 40) || "이름 미상", safeText(item.team, 80), safeText(item.email, 160), safeText(item.car, 20), mergedMemo, memberId));
      counts.merged += 1;
    } else {
      statements.push(getD1().prepare(`INSERT INTO members (
        id, name, phone, normalized_phone, phone_last4, team_name, email, vehicle_number,
        memo, status, created_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))`)
        .bind(memberId, safeText(item.name, 40) || "이름 미상", formatMemberPhone(phone), phone, phone.slice(-4),
          safeText(item.team, 80), safeText(item.email, 160), safeText(item.car, 20), memo,
          `migration:${createdBy}`, validIso(item.createdAt), validIso(item.updatedAt)));
      counts.created += 1;
    }
    statements.push(getD1().prepare(`INSERT INTO legacy_migration_map (legacy_source, legacy_member_id, member_id, action) VALUES (?, ?, ?, ?)`)
      .bind(LEGACY_SOURCE, item.legacyId, memberId, action));
    const stamp = finiteInt(item.stamp, 0, 10_000);
    if (stamp > 0) {
      const referenceKey = `legacy:${item.legacyId}:stamp`;
      statements.push(getD1().prepare(`INSERT INTO stamp_ledger (
        id, member_id, type, amount, reason, source, reference_key, created_by
      ) VALUES (?, ?, 'MIGRATION', ?, '기존 Firebase 스탬프', ?, ?, ?)
      ON CONFLICT(reference_key) DO NOTHING`)
        .bind(await stableId("legacy-stamp", item.legacyId), memberId, stamp, LEGACY_SOURCE, referenceKey, createdBy));
      counts.stamps += 1;
    }
    for (const pass of item.passes) {
      const uses = finiteInt(pass.remainingUses, 0, 10_000);
      if (uses <= 0) continue;
      const sourceReference = `${item.legacyId}:${pass.sourceReference}`;
      if (["LEGACY_STAMP_REWARD", "LEGACY_WEEKDAY"].includes(pass.productCode)) {
        const couponType: MemberCouponType = pass.productCode === "LEGACY_WEEKDAY" ? "WEEKDAY_EVENT" : "STAMP_REWARD";
        const couponName = couponType === "WEEKDAY_EVENT" ? "평일 이용 쿠폰" : "스탬프 적립 쿠폰";
        const issuedAt = validIso(item.updatedAt) ?? new Date().toISOString();
        const explicitExpiry = validIso(pass.expiresAt);
        const calculatedExpiry = new Date(issuedAt);
        calculatedExpiry.setUTCMonth(calculatedExpiry.getUTCMonth() + 1);
        const expiresAt = explicitExpiry ?? calculatedExpiry.toISOString();
        const status = Date.parse(expiresAt) <= Date.now() ? "EXPIRED" : "ACTIVE";
        for (let sequence = 1; sequence <= uses; sequence += 1) {
          const unitReference = `${sourceReference}:coupon:${sequence}`;
          statements.push(getD1().prepare(`INSERT INTO member_coupons (
            id, member_id, coupon_type, name, status, issued_at, expires_at,
            source, source_reference, issued_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_reference) DO NOTHING`)
            .bind(await stableId("legacy-coupon", unitReference), memberId, couponType, couponName,
              status, issuedAt, expiresAt, LEGACY_SOURCE, unitReference, createdBy));
          counts.coupons += 1;
        }
        continue;
      }
      const passId = await stableId("legacy-pass", sourceReference);
      const expiresAt = validIso(pass.expiresAt);
      const status = expiresAt && Date.parse(expiresAt) < Date.now() ? "EXPIRED" : "ACTIVE";
      statements.push(
        getD1().prepare(`INSERT INTO member_passes (
          id, member_id, product_code, product_name_at_purchase, age_group,
          purchased_uses, remaining_uses, purchase_price, regular_unit_price_at_purchase,
          purchased_at, expires_at, status, source, source_reference
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?)
        ON CONFLICT(source_reference) DO NOTHING`)
          .bind(passId, memberId, safeText(pass.productCode, 80), safeText(pass.name, 100), safeText(pass.ageGroup, 20) || "other", uses, uses, legacyRegularPrice(pass.productCode, pricing), validIso(item.updatedAt), expiresAt, status, LEGACY_SOURCE, sourceReference),
        getD1().prepare(`INSERT INTO pass_ledger (
          id, member_pass_id, member_id, type, uses, reference_id, reference_key,
          reason, source, created_by
        ) VALUES (?, ?, ?, 'MIGRATION', ?, ?, ?, '기존 Firebase 잔여횟수', ?, ?)
        ON CONFLICT(reference_key) DO NOTHING`)
          .bind(await stableId("legacy-pass-ledger", sourceReference), passId, memberId, uses, pass.sourceReference, `legacy-pass:${sourceReference}`, LEGACY_SOURCE, createdBy),
      );
      counts.passes += 1;
    }
    await getD1().batch(statements);
    await issueAutomaticStampCoupons(memberId, createdBy);
  }
  return { ...counts, preview: await previewLegacyMembers(input) };
}
