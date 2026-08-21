import { ensureReservationSchema } from "./reservations";
import { getD1 } from "./control";

export type DailySharedSales = {
  date: string;
  slush: {
    card: number;
    cash: number;
    account: number;
  };
  beverage: {
    card: number;
    cash: number;
    account: number;
  };
  other: {
    card: number;
    cash: number;
    account: number;
  };
  youthPass10: {
    card: number;
    cash: number;
    account: number;
  };
  youthPass20: {
    card: number;
    cash: number;
    account: number;
  };
  adultPass10: {
    card: number;
    cash: number;
    account: number;
  };
  adultPass20: {
    card: number;
    cash: number;
    account: number;
  };
  updatedAt: string;
};

type DailySharedSalesRow = {
  sales_date: string;
  slush_card_count: number;
  slush_cash_count: number;
  slush_account_count: number;
  beverage_card_count: number;
  beverage_cash_count: number;
  beverage_account_count: number;
  other_card_count: number;
  other_cash_count: number;
  other_account_count: number;
  youth_pass_10_card_count: number;
  youth_pass_10_cash_count: number;
  youth_pass_10_account_count: number;
  youth_pass_20_card_count: number;
  youth_pass_20_cash_count: number;
  youth_pass_20_account_count: number;
  adult_pass_10_card_count: number;
  adult_pass_10_cash_count: number;
  adult_pass_10_account_count: number;
  adult_pass_20_card_count: number;
  adult_pass_20_cash_count: number;
  adult_pass_20_account_count: number;
  updated_at: string;
};

export function emptyDailySharedSales(date: string): DailySharedSales {
  return {
    date,
    slush: { card: 0, cash: 0, account: 0 },
    beverage: { card: 0, cash: 0, account: 0 },
    other: { card: 0, cash: 0, account: 0 },
    youthPass10: { card: 0, cash: 0, account: 0 },
    youthPass20: { card: 0, cash: 0, account: 0 },
    adultPass10: { card: 0, cash: 0, account: 0 },
    adultPass20: { card: 0, cash: 0, account: 0 },
    updatedAt: "",
  };
}

function toDailySharedSales(row: DailySharedSalesRow): DailySharedSales {
  return {
    date: row.sales_date,
    slush: {
      card: row.slush_card_count,
      cash: row.slush_cash_count,
      account: row.slush_account_count,
    },
    beverage: {
      card: row.beverage_card_count,
      cash: row.beverage_cash_count,
      account: row.beverage_account_count,
    },
    other: {
      card: row.other_card_count,
      cash: row.other_cash_count,
      account: row.other_account_count,
    },
    youthPass10: {
      card: row.youth_pass_10_card_count,
      cash: row.youth_pass_10_cash_count,
      account: row.youth_pass_10_account_count,
    },
    youthPass20: {
      card: row.youth_pass_20_card_count,
      cash: row.youth_pass_20_cash_count,
      account: row.youth_pass_20_account_count,
    },
    adultPass10: {
      card: row.adult_pass_10_card_count,
      cash: row.adult_pass_10_cash_count,
      account: row.adult_pass_10_account_count,
    },
    adultPass20: {
      card: row.adult_pass_20_card_count,
      cash: row.adult_pass_20_cash_count,
      account: row.adult_pass_20_account_count,
    },
    updatedAt: row.updated_at,
  };
}

export async function getDailySharedSales(date: string) {
  await ensureReservationSchema();
  const row = await getD1()
    .prepare(`
      SELECT sales_date, slush_card_count, slush_cash_count, slush_account_count,
        beverage_card_count, beverage_cash_count, beverage_account_count,
        other_card_count, other_cash_count, other_account_count,
        youth_pass_10_card_count, youth_pass_10_cash_count, youth_pass_10_account_count,
        youth_pass_20_card_count, youth_pass_20_cash_count, youth_pass_20_account_count,
        adult_pass_10_card_count, adult_pass_10_cash_count, adult_pass_10_account_count,
        adult_pass_20_card_count, adult_pass_20_cash_count, adult_pass_20_account_count,
        updated_at
      FROM daily_shared_sales WHERE sales_date = ? LIMIT 1
    `)
    .bind(date)
    .first<DailySharedSalesRow>();
  return row ? toDailySharedSales(row) : emptyDailySharedSales(date);
}

export async function addDailySharedSales(
  sales: DailySharedSales,
  operator: string,
) {
  await ensureReservationSchema();
  await getD1()
    .prepare(`
      INSERT INTO daily_shared_sales (
        sales_date, slush_card_count, slush_cash_count, slush_account_count,
        beverage_card_count, beverage_cash_count, beverage_account_count,
        other_card_count, other_cash_count, other_account_count,
        youth_pass_10_card_count, youth_pass_10_cash_count, youth_pass_10_account_count,
        youth_pass_20_card_count, youth_pass_20_cash_count, youth_pass_20_account_count,
        adult_pass_10_card_count, adult_pass_10_cash_count, adult_pass_10_account_count,
        adult_pass_20_card_count, adult_pass_20_cash_count, adult_pass_20_account_count,
        updated_by, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
      )
      ON CONFLICT(sales_date) DO UPDATE SET
        slush_card_count = daily_shared_sales.slush_card_count + excluded.slush_card_count,
        slush_cash_count = daily_shared_sales.slush_cash_count + excluded.slush_cash_count,
        slush_account_count = daily_shared_sales.slush_account_count + excluded.slush_account_count,
        beverage_card_count = daily_shared_sales.beverage_card_count + excluded.beverage_card_count,
        beverage_cash_count = daily_shared_sales.beverage_cash_count + excluded.beverage_cash_count,
        beverage_account_count = daily_shared_sales.beverage_account_count + excluded.beverage_account_count,
        other_card_count = daily_shared_sales.other_card_count + excluded.other_card_count,
        other_cash_count = daily_shared_sales.other_cash_count + excluded.other_cash_count,
        other_account_count = daily_shared_sales.other_account_count + excluded.other_account_count,
        youth_pass_10_card_count = daily_shared_sales.youth_pass_10_card_count + excluded.youth_pass_10_card_count,
        youth_pass_10_cash_count = daily_shared_sales.youth_pass_10_cash_count + excluded.youth_pass_10_cash_count,
        youth_pass_10_account_count = daily_shared_sales.youth_pass_10_account_count + excluded.youth_pass_10_account_count,
        youth_pass_20_card_count = daily_shared_sales.youth_pass_20_card_count + excluded.youth_pass_20_card_count,
        youth_pass_20_cash_count = daily_shared_sales.youth_pass_20_cash_count + excluded.youth_pass_20_cash_count,
        youth_pass_20_account_count = daily_shared_sales.youth_pass_20_account_count + excluded.youth_pass_20_account_count,
        adult_pass_10_card_count = daily_shared_sales.adult_pass_10_card_count + excluded.adult_pass_10_card_count,
        adult_pass_10_cash_count = daily_shared_sales.adult_pass_10_cash_count + excluded.adult_pass_10_cash_count,
        adult_pass_10_account_count = daily_shared_sales.adult_pass_10_account_count + excluded.adult_pass_10_account_count,
        adult_pass_20_card_count = daily_shared_sales.adult_pass_20_card_count + excluded.adult_pass_20_card_count,
        adult_pass_20_cash_count = daily_shared_sales.adult_pass_20_cash_count + excluded.adult_pass_20_cash_count,
        adult_pass_20_account_count = daily_shared_sales.adult_pass_20_account_count + excluded.adult_pass_20_account_count,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(
      sales.date,
      sales.slush.card,
      sales.slush.cash,
      sales.slush.account,
      sales.beverage.card,
      sales.beverage.cash,
      sales.beverage.account,
      sales.other.card,
      sales.other.cash,
      sales.other.account,
      sales.youthPass10.card,
      sales.youthPass10.cash,
      sales.youthPass10.account,
      sales.youthPass20.card,
      sales.youthPass20.cash,
      sales.youthPass20.account,
      sales.adultPass10.card,
      sales.adultPass10.cash,
      sales.adultPass10.account,
      sales.adultPass20.card,
      sales.adultPass20.cash,
      sales.adultPass20.account,
      operator,
    )
    .run();
  return getDailySharedSales(sales.date);
}

export async function replaceDailySharedSales(
  sales: DailySharedSales,
  operator: string,
) {
  await ensureReservationSchema();
  await getD1()
    .prepare(`
      INSERT INTO daily_shared_sales (
        sales_date, slush_card_count, slush_cash_count, slush_account_count,
        beverage_card_count, beverage_cash_count, beverage_account_count,
        other_card_count, other_cash_count, other_account_count,
        youth_pass_10_card_count, youth_pass_10_cash_count, youth_pass_10_account_count,
        youth_pass_20_card_count, youth_pass_20_cash_count, youth_pass_20_account_count,
        adult_pass_10_card_count, adult_pass_10_cash_count, adult_pass_10_account_count,
        adult_pass_20_card_count, adult_pass_20_cash_count, adult_pass_20_account_count,
        updated_by, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
      )
      ON CONFLICT(sales_date) DO UPDATE SET
        slush_card_count = excluded.slush_card_count,
        slush_cash_count = excluded.slush_cash_count,
        slush_account_count = excluded.slush_account_count,
        beverage_card_count = excluded.beverage_card_count,
        beverage_cash_count = excluded.beverage_cash_count,
        beverage_account_count = excluded.beverage_account_count,
        other_card_count = excluded.other_card_count,
        other_cash_count = excluded.other_cash_count,
        other_account_count = excluded.other_account_count,
        youth_pass_10_card_count = excluded.youth_pass_10_card_count,
        youth_pass_10_cash_count = excluded.youth_pass_10_cash_count,
        youth_pass_10_account_count = excluded.youth_pass_10_account_count,
        youth_pass_20_card_count = excluded.youth_pass_20_card_count,
        youth_pass_20_cash_count = excluded.youth_pass_20_cash_count,
        youth_pass_20_account_count = excluded.youth_pass_20_account_count,
        adult_pass_10_card_count = excluded.adult_pass_10_card_count,
        adult_pass_10_cash_count = excluded.adult_pass_10_cash_count,
        adult_pass_10_account_count = excluded.adult_pass_10_account_count,
        adult_pass_20_card_count = excluded.adult_pass_20_card_count,
        adult_pass_20_cash_count = excluded.adult_pass_20_cash_count,
        adult_pass_20_account_count = excluded.adult_pass_20_account_count,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(
      sales.date,
      sales.slush.card,
      sales.slush.cash,
      sales.slush.account,
      sales.beverage.card,
      sales.beverage.cash,
      sales.beverage.account,
      sales.other.card,
      sales.other.cash,
      sales.other.account,
      sales.youthPass10.card,
      sales.youthPass10.cash,
      sales.youthPass10.account,
      sales.youthPass20.card,
      sales.youthPass20.cash,
      sales.youthPass20.account,
      sales.adultPass10.card,
      sales.adultPass10.cash,
      sales.adultPass10.account,
      sales.adultPass20.card,
      sales.adultPass20.cash,
      sales.adultPass20.account,
      operator,
    )
    .run();
  return getDailySharedSales(sales.date);
}
