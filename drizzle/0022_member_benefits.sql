ALTER TABLE payments ADD COLUMN payment_type TEXT NOT NULL DEFAULT 'RESERVATION';
--> statement-breakpoint
ALTER TABLE payments ADD COLUMN member_id TEXT;
--> statement-breakpoint
ALTER TABLE payments ADD COLUMN member_pass_id TEXT;
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN member_id TEXT;
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN member_pass_id TEXT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS benefit_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stamp_goal INTEGER NOT NULL DEFAULT 10,
  stamp_earn_per_game INTEGER NOT NULL DEFAULT 1,
  pass_validity_months INTEGER NOT NULL DEFAULT 12,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
INSERT OR IGNORE INTO benefit_settings (id) VALUES (1);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS stamp_ledger (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  reservation_id TEXT,
  payment_id TEXT,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'POS',
  reference_key TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stamp_ledger_member_created_idx
  ON stamp_ledger(member_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pass_purchase_orders (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE,
  member_id TEXT NOT NULL,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  age_group TEXT NOT NULL,
  purchased_uses INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  regular_unit_price INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  payment_status TEXT NOT NULL DEFAULT 'PENDING',
  payment_id TEXT,
  member_pass_id TEXT,
  requested_by TEXT NOT NULL DEFAULT '',
  paid_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pass_purchase_orders_member_status_idx
  ON pass_purchase_orders(member_id, status, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS member_passes (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  product_code TEXT NOT NULL,
  product_name_at_purchase TEXT NOT NULL,
  age_group TEXT NOT NULL DEFAULT 'other',
  purchased_uses INTEGER NOT NULL,
  remaining_uses INTEGER NOT NULL,
  purchase_price INTEGER,
  regular_unit_price_at_purchase INTEGER NOT NULL DEFAULT 0,
  purchased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  payment_id TEXT,
  payment_transaction_id TEXT,
  payment_method TEXT NOT NULL DEFAULT '',
  purchase_card_amount INTEGER NOT NULL DEFAULT 0,
  purchase_cash_amount INTEGER NOT NULL DEFAULT 0,
  purchase_account_amount INTEGER NOT NULL DEFAULT 0,
  purchase_order_id TEXT UNIQUE,
  source TEXT NOT NULL DEFAULT 'POS_PURCHASE',
  source_reference TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS member_passes_member_status_idx
  ON member_passes(member_id, status, expires_at, purchased_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pass_ledger (
  id TEXT PRIMARY KEY,
  member_pass_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  type TEXT NOT NULL,
  uses INTEGER NOT NULL,
  reservation_id TEXT,
  payment_id TEXT,
  reference_id TEXT,
  reference_key TEXT NOT NULL UNIQUE,
  regular_amount INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'POS',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pass_ledger_pass_created_idx
  ON pass_ledger(member_pass_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pass_ledger_member_created_idx
  ON pass_ledger(member_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS legacy_migration_map (
  legacy_source TEXT NOT NULL,
  legacy_member_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  action TEXT NOT NULL,
  migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (legacy_source, legacy_member_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS legacy_migration_backups (
  id TEXT PRIMARY KEY,
  legacy_source TEXT NOT NULL,
  members_json TEXT NOT NULL,
  stamp_ledger_json TEXT NOT NULL,
  member_passes_json TEXT NOT NULL,
  pass_ledger_json TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
PRAGMA optimize;
