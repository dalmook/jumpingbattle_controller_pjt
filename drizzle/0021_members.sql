CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  normalized_phone TEXT NOT NULL,
  phone_last4 TEXT NOT NULL DEFAULT '',
  birthday TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  merged_into_id TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS members_normalized_phone_uidx
  ON members(normalized_phone)
  WHERE normalized_phone <> '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS members_name_idx ON members(name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS members_phone_last4_idx
  ON members(phone_last4, updated_at);
--> statement-breakpoint
ALTER TABLE reservations ADD COLUMN member_id TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS reservations_member_idx
  ON reservations(member_id, scheduled_date DESC);
