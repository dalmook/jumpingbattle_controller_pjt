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
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS add_on_sale_orders_date_status_idx
  ON add_on_sale_orders(sales_date, status, created_at DESC);
--> statement-breakpoint
PRAGMA optimize;
