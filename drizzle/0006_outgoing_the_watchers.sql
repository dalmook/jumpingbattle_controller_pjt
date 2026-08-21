ALTER TABLE `daily_shared_sales` ADD `other_card_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_shared_sales` ADD `other_cash_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_shared_sales` ADD `other_account_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `daily_shared_sales`
SET `other_card_count` = `other_card_count` + min(`beverage_card_count`, 12),
  `beverage_card_count` = max(`beverage_card_count` - 12, 0),
  `updated_at` = CURRENT_TIMESTAMP
WHERE `sales_date` = '2026-07-30';
