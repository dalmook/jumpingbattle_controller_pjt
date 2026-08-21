CREATE TABLE IF NOT EXISTS member_coupons (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  coupon_type TEXT NOT NULL CHECK(coupon_type IN ('STAMP_REWARD','WEEKDAY_EVENT')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_reservation_id TEXT,
  used_payment_attempt_id TEXT,
  source TEXT NOT NULL DEFAULT 'ADMIN',
  source_reference TEXT NOT NULL UNIQUE,
  issued_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS member_coupons_member_status_idx
  ON member_coupons(member_id, status, expires_at, issued_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS member_coupons_used_reservation_idx
  ON member_coupons(used_reservation_id, used_at DESC);
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN member_coupon_id TEXT;
--> statement-breakpoint
ALTER TABLE legacy_migration_backups
  ADD COLUMN member_coupons_json TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
WITH RECURSIVE coupon_units(pass_id, member_id, product_code, purchased_at, expires_at, source_reference, sequence, max_sequence) AS (
  SELECT id, member_id, product_code, purchased_at, expires_at, source_reference, 1, remaining_uses
  FROM member_passes
  WHERE product_code IN ('LEGACY_STAMP_REWARD', 'LEGACY_WEEKDAY')
    AND remaining_uses > 0
  UNION ALL
  SELECT pass_id, member_id, product_code, purchased_at, expires_at, source_reference, sequence + 1, max_sequence
  FROM coupon_units
  WHERE sequence < max_sequence
)
INSERT OR IGNORE INTO member_coupons (
  id, member_id, coupon_type, name, status, issued_at, expires_at,
  source, source_reference, issued_by, created_at, updated_at
)
SELECT
  'legacy-coupon:' || pass_id || ':' || sequence,
  member_id,
  CASE WHEN product_code = 'LEGACY_WEEKDAY' THEN 'WEEKDAY_EVENT' ELSE 'STAMP_REWARD' END,
  CASE WHEN product_code = 'LEGACY_WEEKDAY' THEN '평일 이용 쿠폰' ELSE '스탬프 적립 쿠폰' END,
  CASE
    WHEN datetime(COALESCE(expires_at, datetime(purchased_at, '+1 month'))) <= CURRENT_TIMESTAMP THEN 'EXPIRED'
    ELSE 'ACTIVE'
  END,
  purchased_at,
  COALESCE(expires_at, datetime(purchased_at, '+1 month')),
  'LEGACY_JUMPINGMANAGER',
  source_reference || ':coupon:' || sequence,
  'migration:0027',
  purchased_at,
  CURRENT_TIMESTAMP
FROM coupon_units;
--> statement-breakpoint
UPDATE member_passes
SET remaining_uses = 0, status = 'MIGRATED_COUPON', updated_at = CURRENT_TIMESTAMP
WHERE product_code IN ('LEGACY_STAMP_REWARD', 'LEGACY_WEEKDAY')
  AND remaining_uses > 0;
--> statement-breakpoint
PRAGMA optimize;
