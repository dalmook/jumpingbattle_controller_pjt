import type {
  AnalyticsResponse,
  SalesBucket,
} from "@/app/admin/analytics-types";
import {
  classifyReservationSales,
  classifySharedSales,
  type ReservationSalesInput,
  type SharedSalesInput,
} from "@/app/admin/sales-classification";
import { OPERATING_SLOTS } from "@/app/reservation-config";
import type { PricingSettings } from "@/app/pricing-config";
import { getD1 } from "./control";
import { ensureReservationSchema } from "./reservations";
import { getPricingSettings } from "./pricing-settings";
import { ensureMemberBenefitSchema } from "./member-benefits";
import {
  addOnSaleBucketValues,
  listAddOnSalesForAnalytics,
} from "./add-on-sales";

type AnalyticsReservationRow = ReservationSalesInput & {
  scheduled_date: string;
  scheduled_time: string;
  total_count: number;
};

type SharedSalesRow = SharedSalesInput & {
  sales_date: string;
};

type MemberPassSaleRow = {
  sales_date: string;
  purchase_price: number;
  purchase_card_amount: number;
  purchase_cash_amount: number;
  purchase_account_amount: number;
  coupon_amount: number;
};

function emptyBucket(key: string): SalesBucket {
  return {
    key,
    games: 0,
    people: 0,
    expected: 0,
    revenue: 0,
    card: 0,
    cash: 0,
    account: 0,
    deposit: 0,
    cancellationFee: 0,
    other: 0,
    slush: 0,
    beverage: 0,
    sharedOther: 0,
    passes: 0,
    gameRevenue: 0,
    gameDeposit: 0,
    gameCard: 0,
    gameCash: 0,
    gameAccount: 0,
    gameUnclassified: 0,
    addOnRevenue: 0,
    addOnCard: 0,
    addOnCash: 0,
    addOnAccount: 0,
  };
}

function addBucket(target: SalesBucket, source: SalesBucket) {
  target.games += source.games;
  target.people += source.people;
  target.expected += source.expected;
  target.revenue += source.revenue;
  target.card += source.card;
  target.cash += source.cash;
  target.account += source.account;
  target.deposit += source.deposit;
  target.cancellationFee += source.cancellationFee;
  target.other += source.other;
  target.slush += source.slush;
  target.beverage += source.beverage;
  target.sharedOther += source.sharedOther;
  target.passes += source.passes;
  target.gameRevenue += source.gameRevenue;
  target.gameDeposit += source.gameDeposit;
  target.gameCard += source.gameCard;
  target.gameCash += source.gameCash;
  target.gameAccount += source.gameAccount;
  target.gameUnclassified += source.gameUnclassified;
  target.addOnRevenue += source.addOnRevenue;
  target.addOnCard += source.addOnCard;
  target.addOnCash += source.addOnCash;
  target.addOnAccount += source.addOnAccount;
}

function reservationBucket(
  row: AnalyticsReservationRow,
  pricing: PricingSettings,
) {
  const bucket = emptyBucket("");
  const sales = classifyReservationSales(
    row,
    pricing.naverCancellationFeeAmount,
    pricing.naverDepositAmount,
  );
  if (row.same_day_naver_cancel === 1) {
    bucket.expected = sales.expected;
    bucket.revenue = sales.gameRevenue;
    bucket.cancellationFee = sales.cancellationFee;
    bucket.gameRevenue = sales.gameRevenue;
    bucket.gameDeposit = sales.gameDeposit;
    return bucket;
  }

  bucket.games = 1;
  bucket.people = row.total_count;
  bucket.expected = sales.expected;
  bucket.deposit = sales.gameDeposit;
  bucket.revenue = sales.gameRevenue;
  bucket.card = sales.gameCard;
  bucket.cash = sales.gameCash;
  bucket.account = sales.gameAccount;
  bucket.other = sales.gameUnclassified;
  bucket.gameRevenue = sales.gameRevenue;
  bucket.gameDeposit = sales.gameDeposit;
  bucket.gameCard = sales.gameCard;
  bucket.gameCash = sales.gameCash;
  bucket.gameAccount = sales.gameAccount;
  bucket.gameUnclassified = sales.gameUnclassified;
  return bucket;
}

function sharedSalesBucket(row: SharedSalesRow, pricing: PricingSettings) {
  const bucket = emptyBucket("");
  const sales = classifySharedSales(row, pricing);
  bucket.slush = sales.slush;
  bucket.beverage = sales.beverage;
  bucket.sharedOther = sales.sharedOther;
  bucket.passes = sales.passes;
  bucket.gameRevenue = sales.gameRevenue;
  bucket.gameCard = sales.gameCard;
  bucket.gameCash = sales.gameCash;
  bucket.gameAccount = sales.gameAccount;
  bucket.addOnRevenue = sales.addOnRevenue;
  bucket.addOnCard = sales.addOnCard;
  bucket.addOnCash = sales.addOnCash;
  bucket.addOnAccount = sales.addOnAccount;
  bucket.card = sales.gameCard + sales.addOnCard;
  bucket.cash = sales.gameCash + sales.addOnCash;
  bucket.account = sales.gameAccount + sales.addOnAccount;
  bucket.expected = sales.gameRevenue + sales.addOnRevenue;
  bucket.revenue = bucket.expected;
  return bucket;
}

export async function getMonthlyAnalytics(
  month: string,
): Promise<AnalyticsResponse> {
  await Promise.all([ensureReservationSchema(), ensureMemberBenefitSchema()]);
  const db = getD1();
  const [reservationsResult, sharedSalesResult, memberPassSalesResult, addOnSalesResult, pricing] = await Promise.all([
    db
      .prepare(`
        SELECT reservations.scheduled_date, reservations.scheduled_time,
          reservations.source, reservations.total_count,
          reservations.base_amount, reservations.add_on_amount,
          reservations.discount_amount, reservations.payment_amount,
          reservations.payment_card_amount, reservations.payment_cash_amount,
          reservations.payment_account_amount,
          CASE WHEN ao.status = 'PAID' THEN ao.amount ELSE 0 END AS linked_add_on_amount,
          CASE WHEN ao.status = 'PAID' THEN ao.payment_card_amount ELSE 0 END AS linked_add_on_card_amount,
          CASE WHEN ao.status = 'PAID' THEN ao.payment_cash_amount ELSE 0 END AS linked_add_on_cash_amount,
          CASE WHEN ao.status = 'PAID' THEN ao.payment_account_amount ELSE 0 END AS linked_add_on_account_amount,
          COALESCE((
            SELECT SUM(pa.amount) FROM payment_attempts pa
            WHERE pa.reservation_id = reservations.id
              AND pa.attempt_type = 'PAY' AND pa.payment_method = 'coupon'
              AND pa.status IN ('APPROVED', 'COMPLETED')
              AND NOT EXISTS (
                SELECT 1 FROM payment_attempts pc
                WHERE pc.original_attempt_id = pa.id
                  AND pc.attempt_type = 'CANCEL' AND pc.status = 'CANCELLED'
              )
          ), 0) AS payment_coupon_amount,
          reservations.payment_method, reservations.payment_status,
          CASE
            WHEN reservations.source = 'naver'
              AND reservations.status = 'cancelled'
              AND reservations.cancelled_at IS NOT NULL
              AND date(reservations.cancelled_at, '+9 hours') = reservations.scheduled_date
            THEN 1 ELSE 0
          END AS same_day_naver_cancel
        FROM reservations
        LEFT JOIN add_on_sale_orders ao
          ON ao.reservation_id = reservations.id
          AND reservations.source <> 'add_on_sale_purchase'
        WHERE reservations.scheduled_date LIKE ?
          AND (
            reservations.status <> 'cancelled'
            OR (
              reservations.source = 'naver'
              AND reservations.cancelled_at IS NOT NULL
              AND date(reservations.cancelled_at, '+9 hours') = reservations.scheduled_date
            )
          )
        ORDER BY reservations.scheduled_date, reservations.scheduled_time
      `)
      .bind(`${month}-%`)
      .all<AnalyticsReservationRow>(),
    db
      .prepare(`
        SELECT sales_date, slush_card, slush_cash, slush_account,
          beverage_card, beverage_cash, beverage_account,
          slush_card_count, slush_cash_count, slush_account_count,
          beverage_card_count, beverage_cash_count, beverage_account_count,
          other_card_count, other_cash_count, other_account_count,
          youth_pass_10_card_count, youth_pass_10_cash_count, youth_pass_10_account_count,
          youth_pass_20_card_count, youth_pass_20_cash_count, youth_pass_20_account_count,
          adult_pass_10_card_count, adult_pass_10_cash_count, adult_pass_10_account_count,
          adult_pass_20_card_count, adult_pass_20_cash_count, adult_pass_20_account_count
        FROM daily_shared_sales
        WHERE sales_date LIKE ?
        ORDER BY sales_date
      `)
      .bind(`${month}-%`)
      .all<SharedSalesRow>(),
    db
      .prepare(`
        SELECT date(mp.purchased_at, '+9 hours') AS sales_date, mp.purchase_price,
          mp.purchase_card_amount, mp.purchase_cash_amount, mp.purchase_account_amount,
          COALESCE((
            SELECT SUM(pa.amount) FROM payment_attempts pa
            WHERE pa.payment_id = mp.payment_id
              AND pa.attempt_type = 'PAY' AND pa.payment_method = 'coupon'
              AND pa.status IN ('APPROVED', 'COMPLETED')
              AND NOT EXISTS (
                SELECT 1 FROM payment_attempts pc
                WHERE pc.original_attempt_id = pa.id
                  AND pc.attempt_type = 'CANCEL' AND pc.status = 'CANCELLED'
              )
          ), 0) AS coupon_amount
        FROM member_passes mp
        WHERE source = 'POS_PURCHASE' AND status <> 'CANCELLED'
          AND purchase_price IS NOT NULL
          AND date(mp.purchased_at, '+9 hours') LIKE ?
        ORDER BY mp.purchased_at
      `)
      .bind(`${month}-%`)
      .all<MemberPassSaleRow>(),
    listAddOnSalesForAnalytics(month),
    getPricingSettings(),
  ]);

  const days = new Map<string, SalesBucket>();
  const hours = new Map(
    OPERATING_SLOTS.map((time) => [time, emptyBucket(time)]),
  );
  for (const row of reservationsResult.results) {
    const values = reservationBucket(row, pricing);
    const day = days.get(row.scheduled_date) ?? emptyBucket(row.scheduled_date);
    addBucket(day, values);
    days.set(row.scheduled_date, day);
    const hour = hours.get(row.scheduled_time) ?? emptyBucket(row.scheduled_time);
    addBucket(hour, values);
    hours.set(row.scheduled_time, hour);
  }
  for (const row of sharedSalesResult.results) {
    const values = sharedSalesBucket(row, pricing);
    const day = days.get(row.sales_date) ?? emptyBucket(row.sales_date);
    addBucket(day, values);
    days.set(row.sales_date, day);
  }
  for (const row of memberPassSalesResult.results) {
    const values = emptyBucket("");
    const price = Number(row.purchase_price) || 0;
    const coupon = Math.max(0, Number(row.coupon_amount) || 0);
    const revenue = Math.max(0, price - coupon);
    values.passes = revenue;
    values.gameRevenue = revenue;
    values.gameCard = Number(row.purchase_card_amount) || 0;
    values.gameCash = Number(row.purchase_cash_amount) || 0;
    values.gameAccount = Number(row.purchase_account_amount) || 0;
    values.gameUnclassified = Math.max(0, revenue - values.gameCard - values.gameCash - values.gameAccount);
    values.card = values.gameCard;
    values.cash = values.gameCash;
    values.account = values.gameAccount;
    values.other = values.gameUnclassified;
    values.expected = price;
    values.revenue = revenue;
    const day = days.get(row.sales_date) ?? emptyBucket(row.sales_date);
    addBucket(day, values);
    days.set(row.sales_date, day);
  }
  for (const row of addOnSalesResult) {
    const sale = addOnSaleBucketValues(row);
    const values = emptyBucket("");
    values.slush = sale.slush;
    values.beverage = sale.beverage;
    values.sharedOther = sale.other;
    values.addOnRevenue = sale.revenue;
    values.addOnCard = sale.card;
    values.addOnCash = sale.cash;
    values.addOnAccount = sale.account;
    values.card = sale.card;
    values.cash = sale.cash;
    values.account = sale.account;
    values.expected = sale.revenue;
    values.revenue = sale.revenue;
    const day = days.get(sale.salesDate) ?? emptyBucket(sale.salesDate);
    addBucket(day, values);
    days.set(sale.salesDate, day);
  }

  const dayList = Array.from(days.values()).sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  const hourList = Array.from(hours.values()).filter(
    (bucket) => bucket.games > 0 || bucket.revenue > 0,
  );
  const monthSummary = emptyBucket(month);
  for (const day of dayList) addBucket(monthSummary, day);
  return { month, monthSummary, days: dayList, hours: hourList };
}
