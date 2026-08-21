CREATE TABLE IF NOT EXISTS pass_purchase_credits (
  order_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 1,
  used_uses INTEGER NOT NULL DEFAULT 0,
  credit_amount INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (order_id, reservation_id),
  UNIQUE (reservation_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pass_purchase_credits_order_idx
  ON pass_purchase_credits(order_id, sequence);
--> statement-breakpoint
INSERT OR IGNORE INTO pass_purchase_credits (
  order_id, reservation_id, sequence, used_uses, credit_amount
)
SELECT id, credit_reservation_id, 1, initial_used_uses, credit_amount
FROM pass_purchase_orders
WHERE credit_reservation_id IS NOT NULL AND trim(credit_reservation_id) <> ''
  AND status <> 'CANCELLED';
--> statement-breakpoint
UPDATE pass_purchase_orders
SET status = 'CANCELLED', payment_status = 'CANCELLED',
    cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  '948d33e9-2564-4f05-b398-9250faa4f9b2',
  'b7ba93ae-7d1f-48c5-9938-2be237de84a0',
  'cd5836e3-0ac7-41ed-9136-4db29ca87470'
) AND member_id = 'bdde54f4-da1f-41fb-b384-a3772bd60ded'
  AND status = 'PENDING' AND payment_status = 'PENDING';
--> statement-breakpoint
UPDATE reservations
SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP),
    memo = CASE WHEN trim(memo) = '' THEN '잘못 생성된 미결제 다회권 주문 정리'
      ELSE memo || char(10) || '잘못 생성된 미결제 다회권 주문 정리' END,
    updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  '948d33e9-2564-4f05-b398-9250faa4f9b2',
  'b7ba93ae-7d1f-48c5-9938-2be237de84a0',
  'cd5836e3-0ac7-41ed-9136-4db29ca87470'
) AND member_id = 'bdde54f4-da1f-41fb-b384-a3772bd60ded'
  AND payment_status = 'unpaid';
--> statement-breakpoint
DELETE FROM pass_purchase_credits
WHERE order_id IN (
  '948d33e9-2564-4f05-b398-9250faa4f9b2',
  'b7ba93ae-7d1f-48c5-9938-2be237de84a0',
  'cd5836e3-0ac7-41fb-b384-a3772bd60ded'
);
--> statement-breakpoint
PRAGMA optimize;
