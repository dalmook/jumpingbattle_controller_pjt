CREATE TABLE `daily_shared_sales` (
	`sales_date` text PRIMARY KEY NOT NULL,
	`slush_card` integer DEFAULT 0 NOT NULL,
	`slush_cash` integer DEFAULT 0 NOT NULL,
	`slush_account` integer DEFAULT 0 NOT NULL,
	`beverage_card` integer DEFAULT 0 NOT NULL,
	`beverage_cash` integer DEFAULT 0 NOT NULL,
	`beverage_account` integer DEFAULT 0 NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
