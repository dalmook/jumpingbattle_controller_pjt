CREATE TABLE `pricing_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`adult_price` integer DEFAULT 7000 NOT NULL,
	`youth_price` integer DEFAULT 5000 NOT NULL,
	`naver_deposit_amount` integer DEFAULT 5000 NOT NULL,
	`naver_cancellation_fee_amount` integer DEFAULT 5000 NOT NULL,
	`slush_price` integer DEFAULT 1500 NOT NULL,
	`beverage_price` integer DEFAULT 1000 NOT NULL,
	`other_price` integer DEFAULT 1000 NOT NULL,
	`youth_pass_10_price` integer DEFAULT 45000 NOT NULL,
	`youth_pass_20_price` integer DEFAULT 80000 NOT NULL,
	`adult_pass_10_price` integer DEFAULT 60000 NOT NULL,
	`adult_pass_20_price` integer DEFAULT 110000 NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "pricing_settings_singleton" CHECK (`id` = 1)
);
--> statement-breakpoint
INSERT INTO `pricing_settings` (`id`) VALUES (1);
