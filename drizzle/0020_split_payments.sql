CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'single',
  split_count INTEGER NOT NULL DEFAULT 0,
  final_amount INTEGER NOT NULL DEFAULT 0,
  deposit_amount INTEGER NOT NULL DEFAULT 0,
  payable_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  full_cancel_requested INTEGER NOT NULL DEFAULT 0,
  plan_request_key TEXT,
  requested_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(reservation_id) REFERENCES reservations(id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payments_plan_request_key_uidx
  ON payments(plan_request_key)
  WHERE plan_request_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payments_reservation_status_idx
  ON payments(reservation_id, status);
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN payment_id TEXT;
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN split_index INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card';
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN request_key TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_attempts_payment_split_idx
  ON payment_attempts(payment_id, split_index, requested_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_request_key_uidx
  ON payment_attempts(request_key)
  WHERE request_key IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO payments (
  id, reservation_id, mode, split_count, final_amount, deposit_amount,
  payable_amount, status, requested_by, created_at, updated_at
)
SELECT
  r.id || '-LEGACY-PAYMENT',
  r.id,
  'legacy',
  MAX(
    (CASE WHEN r.payment_card_amount > 0 THEN 1 ELSE 0 END) +
      (CASE WHEN r.payment_cash_amount > 0 THEN 1 ELSE 0 END) +
      (CASE WHEN r.payment_account_amount > 0 THEN 1 ELSE 0 END),
    (SELECT COUNT(*) FROM payment_attempts pa
      WHERE pa.reservation_id = r.id AND pa.attempt_type = 'PAY')
  ),
  MAX(0, r.base_amount + r.add_on_amount - r.discount_amount),
  CASE WHEN r.source = 'naver'
    THEN MIN(5000, MAX(0, r.base_amount + r.add_on_amount - r.discount_amount))
    ELSE 0 END,
  MAX(0, MAX(0, r.base_amount + r.add_on_amount - r.discount_amount) -
    CASE WHEN r.source = 'naver'
      THEN MIN(5000, MAX(0, r.base_amount + r.add_on_amount - r.discount_amount))
      ELSE 0 END
  ),
  CASE
    WHEN r.payment_status = 'paid' THEN 'PAID'
    ELSE 'PARTIALLY_PAID'
  END,
  'legacy-migration',
  r.updated_at,
  r.updated_at
FROM reservations r
WHERE r.payment_card_amount + r.payment_cash_amount + r.payment_account_amount > 0
   OR EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.reservation_id = r.id);
--> statement-breakpoint
UPDATE payment_attempts
SET payment_id = reservation_id || '-LEGACY-PAYMENT',
    split_index = attempt_number
WHERE payment_id IS NULL
  AND EXISTS (SELECT 1 FROM payments p WHERE p.reservation_id = payment_attempts.reservation_id);
--> statement-breakpoint
UPDATE payment_attempts
SET active_key = NULL
WHERE attempt_type = 'PAY'
  AND status IN ('APPROVED', 'COMPLETED', 'DECLINED', 'USER_CANCELLED', 'CANCELLED');
--> statement-breakpoint
INSERT OR IGNORE INTO payment_attempts (
  id, reservation_id, payment_id, split_index, attempt_type, attempt_number,
  amount, sale_amount, add_on_amount, discount_amount, payment_method, status,
  requested_by, requested_at, completed_at, updated_at
)
SELECT
  r.id || '-LEGACY-CARD', r.id, r.id || '-LEGACY-PAYMENT', 1, 'PAY', 9001,
  r.payment_card_amount, r.payment_amount, r.add_on_amount, r.discount_amount,
  'card', 'APPROVED', 'legacy-migration', r.updated_at, r.updated_at, r.updated_at
FROM reservations r
WHERE r.payment_card_amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM payment_attempts p
    WHERE p.reservation_id = r.id AND p.attempt_type = 'PAY'
      AND p.payment_method = 'card' AND p.status IN ('APPROVED', 'COMPLETED')
  );
--> statement-breakpoint
INSERT OR IGNORE INTO payment_attempts (
  id, reservation_id, payment_id, split_index, attempt_type, attempt_number,
  amount, sale_amount, add_on_amount, discount_amount, payment_method, status,
  requested_by, requested_at, completed_at, updated_at
)
SELECT
  r.id || '-LEGACY-CASH', r.id, r.id || '-LEGACY-PAYMENT',
  CASE WHEN r.payment_card_amount > 0 THEN 2 ELSE 1 END,
  'PAY', 9002, r.payment_cash_amount, r.payment_amount, r.add_on_amount,
  r.discount_amount, 'cash', 'COMPLETED', 'legacy-migration',
  r.updated_at, r.updated_at, r.updated_at
FROM reservations r
WHERE r.payment_cash_amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM payment_attempts p
    WHERE p.reservation_id = r.id AND p.attempt_type = 'PAY'
      AND p.payment_method = 'cash' AND p.status IN ('APPROVED', 'COMPLETED')
  );
--> statement-breakpoint
INSERT OR IGNORE INTO payment_attempts (
  id, reservation_id, payment_id, split_index, attempt_type, attempt_number,
  amount, sale_amount, add_on_amount, discount_amount, payment_method, status,
  requested_by, requested_at, completed_at, updated_at
)
SELECT
  r.id || '-LEGACY-ACCOUNT', r.id, r.id || '-LEGACY-PAYMENT',
  (CASE WHEN r.payment_card_amount > 0 THEN 1 ELSE 0 END) +
    (CASE WHEN r.payment_cash_amount > 0 THEN 1 ELSE 0 END) + 1,
  'PAY', 9003, r.payment_account_amount, r.payment_amount, r.add_on_amount,
  r.discount_amount, 'account', 'COMPLETED', 'legacy-migration',
  r.updated_at, r.updated_at, r.updated_at
FROM reservations r
WHERE r.payment_account_amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM payment_attempts p
    WHERE p.reservation_id = r.id AND p.attempt_type = 'PAY'
      AND p.payment_method = 'account' AND p.status IN ('APPROVED', 'COMPLETED')
  );
