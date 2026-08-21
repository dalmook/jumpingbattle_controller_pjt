CREATE TABLE `push_notification_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '매출 브리핑' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`delivery_time` text DEFAULT '21:30' NOT NULL,
	`weekdays_json` text DEFAULT '[0,1,2,3,4,5,6]' NOT NULL,
	`last_sent_date` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `push_notification_schedules_due_idx` ON `push_notification_schedules` (`enabled`,`delivery_time`,`sort_order`);
--> statement-breakpoint
INSERT OR IGNORE INTO `push_notification_schedules`
  (`id`, `name`, `enabled`, `delivery_time`, `weekdays_json`, `last_sent_date`, `sort_order`, `updated_by`, `updated_at`)
SELECT 'default', '마감 매출', `enabled`, `delivery_time`, `weekdays_json`,
  `last_sent_date`, 0, `updated_by`, `updated_at`
FROM `push_notification_settings` WHERE `id` = 1;
--> statement-breakpoint
PRAGMA optimize;
