CREATE TABLE `naver_stock_managed_slots` (
	`slot_key` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`scheduled_date` text NOT NULL,
	`scheduled_time` text NOT NULL,
	`biz_item_id` integer NOT NULL,
	`original_stock` integer DEFAULT 1 NOT NULL,
	`managed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `naver_stock_managed_schedule_idx` ON `naver_stock_managed_slots` (`scheduled_date`,`scheduled_time`);