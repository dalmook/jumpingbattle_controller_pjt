ALTER TABLE `daily_shared_sales` ADD `slush_card_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_shared_sales` ADD `slush_cash_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_shared_sales` ADD `slush_account_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_shared_sales` ADD `beverage_card_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_shared_sales` ADD `beverage_cash_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_shared_sales` ADD `beverage_account_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `reservations`
SET `base_amount` = `total_count` * 7000,
  `updated_at` = CURRENT_TIMESTAMP
WHERE `source` = 'naver' AND `base_amount` = 0 AND `total_count` > 0;
