ALTER TABLE pricing_settings
  ADD COLUMN extra_add_on_items_json TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE add_on_sale_orders
  ADD COLUMN items_json TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
PRAGMA optimize;
