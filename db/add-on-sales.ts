import { getD1 } from "./control";
import { getPricingSettings } from "./pricing-settings";
import { getReservationById } from "./reservations";
import type { PricingSettings } from "@/app/pricing-config";
import { allocateAddOnPaymentMethods } from "@/app/add-on-allocation";

export type AddOnSaleCounts = {
  slush: number;
  beverage: number;
  other: number;
};

export type AddOnSaleItemInput = {
  code: string;
  quantity: unknown;
};

export type AddOnSaleSelectionInput = {
  slush: unknown;
  beverage: unknown;
  other: unknown;
  items?: AddOnSaleItemInput[];
};

type AddOnSaleItemSnapshot = {
  code: string;
  name: string;
  count: number;
  unitPrice: number;
  amount: number;
};

export type AddOnSaleDraft = {
  counts: AddOnSaleCounts;
  extraItems: AddOnSaleItemSnapshot[];
  summary: string;
  amount: number;
};

export type AttachedAddOnSale = {
  reservationId: string;
  salesDate: string;
  summary: string;
  amount: number;
  status: string;
  paymentStatus: string;
  counts: AddOnSaleCounts;
  items: Array<{
    code: string;
    name: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
};

type AddOnSaleOrderRow = {
  id: string;
  reservation_id: string;
  sales_date: string;
  item_summary: string;
  slush_count: number;
  beverage_count: number;
  other_count: number;
  slush_unit_price: number;
  beverage_unit_price: number;
  other_unit_price: number;
  items_json: string;
  amount: number;
  status: string;
  payment_status: string;
  payment_id: string | null;
  payment_card_amount: number;
  payment_cash_amount: number;
  payment_account_amount: number;
  created_at: string;
  updated_at: string;
};

function count(value: unknown) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(99, parsed)) : 0;
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function itemSummary(counts: AddOnSaleCounts, extraItems: AddOnSaleItemSnapshot[]) {
  return [
    counts.slush ? `슬러시 ${counts.slush}` : "",
    counts.beverage ? `음료 ${counts.beverage}` : "",
    counts.other ? `양말 ${counts.other}` : "",
    ...extraItems.map((item) => `${item.name} ${item.count}`),
  ].filter(Boolean).join(" · ");
}

function parseItemSnapshots(value: string | null | undefined): AddOnSaleItemSnapshot[] {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const source = item as Record<string, unknown>;
      const itemCount = count(source.count);
      const unitPrice = Math.max(0, Math.trunc(Number(source.unitPrice) || 0));
      if (!itemCount) return [];
      return [{
        code: String(source.code ?? ""),
        name: String(source.name ?? "추가 상품"),
        count: itemCount,
        unitPrice,
        amount: itemCount * unitPrice,
      }];
    });
  } catch {
    return [];
  }
}

export function quoteAddOnSale(
  input: AddOnSaleSelectionInput,
  pricing: PricingSettings,
): AddOnSaleDraft {
  const counts: AddOnSaleCounts = {
    slush: count(input.slush),
    beverage: count(input.beverage),
    other: count(input.other),
  };
  const configuredItems = new Map(
    pricing.extraAddOnItems
      .filter((item) => item.active)
      .map((item) => [item.code, item]),
  );
  const requestedItems = Array.isArray(input.items) ? input.items : [];
  if (requestedItems.length > 30) throw new Error("ADD_ON_SALE_ITEMS_INVALID");
  const extraItems: AddOnSaleItemSnapshot[] = [];
  const seen = new Set<string>();
  for (const requestedItem of requestedItems) {
    const code = String(requestedItem?.code ?? "").trim().toLowerCase();
    const itemCount = count(requestedItem?.quantity);
    if (!itemCount) continue;
    const configured = configuredItems.get(code);
    if (!configured || seen.has(code)) throw new Error("ADD_ON_SALE_ITEMS_INVALID");
    seen.add(code);
    extraItems.push({
      code,
      name: configured.name,
      count: itemCount,
      unitPrice: configured.price,
      amount: itemCount * configured.price,
    });
  }
  const amount =
    counts.slush * pricing.slushPrice +
    counts.beverage * pricing.beveragePrice +
    counts.other * pricing.otherPrice +
    extraItems.reduce((sum, item) => sum + item.amount, 0);
  return {
    counts,
    extraItems,
    summary: itemSummary(counts, extraItems),
    amount,
  };
}

let addOnSaleSchemaReady: Promise<void> | null = null;

export async function ensureAddOnSaleSchema() {
  if (!addOnSaleSchemaReady) {
    addOnSaleSchemaReady = initializeAddOnSaleSchema().catch((error) => {
      addOnSaleSchemaReady = null;
      throw error;
    });
  }
  await addOnSaleSchemaReady;
}

async function initializeAddOnSaleSchema() {
  const db = getD1();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS add_on_sale_orders (
        id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL UNIQUE,
        sales_date TEXT NOT NULL,
        item_summary TEXT NOT NULL DEFAULT '',
        slush_count INTEGER NOT NULL DEFAULT 0,
        beverage_count INTEGER NOT NULL DEFAULT 0,
        other_count INTEGER NOT NULL DEFAULT 0,
        slush_unit_price INTEGER NOT NULL DEFAULT 0,
        beverage_unit_price INTEGER NOT NULL DEFAULT 0,
        other_unit_price INTEGER NOT NULL DEFAULT 0,
        items_json TEXT NOT NULL DEFAULT '[]',
        amount INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'PAYMENT_PENDING',
        payment_status TEXT NOT NULL DEFAULT 'PENDING',
        payment_id TEXT,
        payment_card_amount INTEGER NOT NULL DEFAULT 0,
        payment_cash_amount INTEGER NOT NULL DEFAULT 0,
        payment_account_amount INTEGER NOT NULL DEFAULT 0,
        requested_by TEXT NOT NULL DEFAULT '',
        paid_at TEXT,
        cancelled_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(reservation_id) REFERENCES reservations(id)
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS add_on_sale_orders_date_status_idx
      ON add_on_sale_orders(sales_date, status, created_at DESC)
    `),
  ]);
}

export async function getAttachedAddOnSale(
  reservationId: string,
): Promise<AttachedAddOnSale | null> {
  await ensureAddOnSaleSchema();
  const row = await getD1().prepare(`
    SELECT reservation_id, sales_date, item_summary,
      slush_count, beverage_count, other_count, items_json,
      amount, status, payment_status
    FROM add_on_sale_orders
    WHERE reservation_id = ? LIMIT 1
  `).bind(reservationId).first<Pick<AddOnSaleOrderRow,
    "reservation_id" | "sales_date" | "item_summary" |
    "slush_count" | "beverage_count" | "other_count" | "items_json" |
    "amount" | "status" | "payment_status"
  >>();
  if (!row) return null;
  return {
    reservationId: row.reservation_id,
    salesDate: row.sales_date,
    summary: row.item_summary,
    amount: Number(row.amount) || 0,
    status: row.status,
    paymentStatus: row.payment_status,
    counts: {
      slush: Number(row.slush_count) || 0,
      beverage: Number(row.beverage_count) || 0,
      other: Number(row.other_count) || 0,
    },
    items: parseItemSnapshots(row.items_json).map((item) => ({
      code: item.code,
      name: item.name,
      quantity: item.count,
      unitPrice: item.unitPrice,
      amount: item.amount,
    })),
  };
}

export async function createAddOnSaleOrder(input: {
  date: string;
  slush: unknown;
  beverage: unknown;
  other: unknown;
  items?: AddOnSaleItemInput[];
  requestedBy: string;
}) {
  await ensureAddOnSaleSchema();
  const salesDate = String(input.date ?? "");
  if (!validDate(salesDate)) throw new Error("ADD_ON_SALE_DATE_INVALID");
  const pricing = await getPricingSettings();
  const { counts, extraItems, summary, amount } = quoteAddOnSale(input, pricing);
  if (counts.slush + counts.beverage + counts.other + extraItems.reduce((sum, item) => sum + item.count, 0) < 1) {
    throw new Error("ADD_ON_SALE_ITEMS_REQUIRED");
  }
  if (amount < 1) throw new Error("ADD_ON_SALE_AMOUNT_INVALID");

  const id = crypto.randomUUID();
  const db = getD1();
  await db.batch([
    db.prepare(`
      INSERT INTO reservations (
        id, booking_code, source, customer_name, scheduled_date, scheduled_time,
        team_name, difficulty_label, base_amount, payment_amount, payment_status,
        status, memo, idempotency_key
      ) VALUES (?, ?, 'add_on_sale_purchase', '부가매출', '0001-01-01', '00:00', ?,
        '부가매출 결제', ?, ?, 'unpaid', 'completed', ?, ?)
    `).bind(
      id,
      `ADDON-${id.slice(0, 8).toUpperCase()}`,
      summary,
      amount,
      amount,
      `${salesDate} 부가매출 · ${summary}`,
      `add-on-sale:${id}`,
    ),
    db.prepare(`
      INSERT INTO add_on_sale_orders (
        id, reservation_id, sales_date, item_summary,
        slush_count, beverage_count, other_count,
        slush_unit_price, beverage_unit_price, other_unit_price,
        items_json, amount, requested_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      id,
      salesDate,
      summary,
      counts.slush,
      counts.beverage,
      counts.other,
      pricing.slushPrice,
      pricing.beveragePrice,
      pricing.otherPrice,
      JSON.stringify(extraItems),
      amount,
      input.requestedBy,
    ),
  ]);
  const reservation = await getReservationById(id);
  if (!reservation) throw new Error("ADD_ON_SALE_RESERVATION_NOT_CREATED");
  return { orderId: id, reservation, counts, extraItems, amount, pricing };
}

export async function syncAddOnSalePayment(
  reservationId: string,
  status: string,
  completedByMethod: Record<string, number>,
  paymentId: string,
) {
  await ensureAddOnSaleSchema();
  const db = getD1();
  const order = await db.prepare(`
    SELECT ao.id, ao.amount, r.source
    FROM add_on_sale_orders ao
    JOIN reservations r ON r.id = ao.reservation_id
    WHERE ao.reservation_id = ? LIMIT 1
  `).bind(reservationId).first<{ id: string; amount: number; source: string }>();
  if (!order) return;

  if (status === "PAID") {
    const allocation = allocateAddOnPaymentMethods(order.amount, completedByMethod);
    await db.batch([
      db.prepare(`
        UPDATE add_on_sale_orders SET status = 'PAID', payment_status = 'PAID',
          payment_id = ?, payment_card_amount = ?, payment_cash_amount = ?,
          payment_account_amount = ?, paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(
        paymentId,
        allocation.card,
        allocation.cash,
        allocation.account,
        order.id,
      ),
      ...(order.source === "add_on_sale_purchase"
        ? [db.prepare(`
            UPDATE payments SET payment_type = 'ADD_ON_SALE', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(paymentId)]
        : []),
    ]);
    return;
  }

  if (status === "CANCELLED") {
    await db.prepare(`
      UPDATE add_on_sale_orders SET status = 'CANCELLED', payment_status = 'CANCELLED',
        payment_card_amount = 0, payment_cash_amount = 0, payment_account_amount = 0,
        cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(order.id).run();
    return;
  }

  await db.prepare(`
    UPDATE add_on_sale_orders SET status = 'PAYMENT_PENDING', payment_status = ?,
      payment_card_amount = 0, payment_cash_amount = 0,
      payment_account_amount = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(status, order.id).run();
}

export async function listAddOnSalesForAnalytics(month: string) {
  await ensureAddOnSaleSchema();
  const result = await getD1().prepare(`
    SELECT id, reservation_id, sales_date, item_summary,
      slush_count, beverage_count, other_count,
      slush_unit_price, beverage_unit_price, other_unit_price,
      items_json,
      amount, status, payment_status, payment_id,
      payment_card_amount, payment_cash_amount, payment_account_amount,
      created_at, updated_at
    FROM add_on_sale_orders
    WHERE sales_date LIKE ? AND status = 'PAID'
    ORDER BY sales_date, created_at
  `).bind(`${month}-%`).all<AddOnSaleOrderRow>();
  return result.results;
}

export function addOnSaleBucketValues(
  row: AddOnSaleOrderRow,
) {
  const slush = Number(row.slush_count) * Number(row.slush_unit_price);
  const beverage = Number(row.beverage_count) * Number(row.beverage_unit_price);
  const other = Number(row.other_count) * Number(row.other_unit_price) +
    parseItemSnapshots(row.items_json).reduce((sum, item) => sum + item.amount, 0);
  const gross = slush + beverage + other;
  const card = Number(row.payment_card_amount) || 0;
  const cash = Number(row.payment_cash_amount) || 0;
  const account = Number(row.payment_account_amount) || 0;
  const revenue = card + cash + account;
  const recognizedRevenue = Math.min(gross, revenue);
  const recognizedSlush = gross > 0 ? Math.floor(slush * recognizedRevenue / gross) : 0;
  const recognizedBeverage = gross > 0 ? Math.floor(beverage * recognizedRevenue / gross) : 0;
  const recognizedOther = Math.max(0, recognizedRevenue - recognizedSlush - recognizedBeverage);
  return {
    salesDate: row.sales_date,
    slush: recognizedSlush,
    beverage: recognizedBeverage,
    other: recognizedOther,
    revenue,
    card,
    cash,
    account,
  };
}

export async function cancelPendingAddOnSaleOrder(reservationId: string) {
  await ensureAddOnSaleSchema();
  const db = getD1();
  const order = await db.prepare(`
    SELECT id, status FROM add_on_sale_orders WHERE reservation_id = ? LIMIT 1
  `).bind(reservationId).first<{ id: string; status: string }>();
  if (!order) throw new Error("ADD_ON_SALE_NOT_FOUND");
  if (order.status !== "PAYMENT_PENDING") throw new Error("ADD_ON_SALE_ALREADY_PROCESSED");
  const unsafeAttempt = await db.prepare(`
    SELECT id FROM payment_attempts
    WHERE reservation_id = ?
      AND (status <> 'PENDING' OR command_id IS NOT NULL OR auth_no <> '')
    LIMIT 1
  `).bind(reservationId).first<{ id: string }>();
  if (unsafeAttempt) throw new Error("ADD_ON_SALE_PAYMENT_STARTED");
  await db.batch([
    db.prepare(`DELETE FROM payment_attempts WHERE reservation_id = ?`).bind(reservationId),
    db.prepare(`DELETE FROM payments WHERE reservation_id = ?`).bind(reservationId),
    db.prepare(`DELETE FROM add_on_sale_orders WHERE reservation_id = ?`).bind(reservationId),
    db.prepare(`DELETE FROM reservation_events WHERE reservation_id = ?`).bind(reservationId),
    db.prepare(`DELETE FROM reservations WHERE id = ?`).bind(reservationId),
  ]);
  return { cancelled: true };
}

export async function deleteAddOnSaleOrder(reservationId: string) {
  await ensureAddOnSaleSchema();
  await getD1().prepare(`DELETE FROM add_on_sale_orders WHERE reservation_id = ?`).bind(reservationId).run();
}
