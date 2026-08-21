ALTER TABLE pass_purchase_orders ADD COLUMN list_amount INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE pass_purchase_orders ADD COLUMN credit_amount INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE pass_purchase_orders ADD COLUMN credit_reservation_id TEXT;
--> statement-breakpoint
ALTER TABLE pass_purchase_orders ADD COLUMN initial_used_uses INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE pass_purchase_orders SET list_amount = amount WHERE list_amount = 0;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS pass_purchase_orders_credit_reservation_uidx
  ON pass_purchase_orders(credit_reservation_id)
  WHERE credit_reservation_id IS NOT NULL AND status <> 'CANCELLED';
--> statement-breakpoint
PRAGMA optimize;
