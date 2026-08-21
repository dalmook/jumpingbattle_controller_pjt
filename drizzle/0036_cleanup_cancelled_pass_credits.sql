DELETE FROM pass_purchase_credits
WHERE order_id IN (
  SELECT id FROM pass_purchase_orders WHERE status = 'CANCELLED'
);
--> statement-breakpoint
PRAGMA optimize;
