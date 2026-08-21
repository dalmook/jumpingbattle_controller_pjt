CREATE TABLE `push_dispatch_log` (
	`id` text PRIMARY KEY NOT NULL,
	`briefing_date` text NOT NULL,
	`dispatch_type` text DEFAULT 'scheduled' NOT NULL,
	`recipient_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`summary_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `push_dispatch_log_date_idx` ON `push_dispatch_log` (`briefing_date`,`created_at`);--> statement-breakpoint
CREATE TABLE `push_notification_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`delivery_time` text DEFAULT '21:30' NOT NULL,
	`weekdays_json` text DEFAULT '[0,1,2,3,4,5,6]' NOT NULL,
	`last_sent_date` text DEFAULT '' NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text DEFAULT '' NOT NULL,
	`auth` text DEFAULT '' NOT NULL,
	`device_name` text DEFAULT '' NOT NULL,
	`device_token_hash` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_success_at` text,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_uidx` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_token_uidx` ON `push_subscriptions` (`device_token_hash`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_enabled_idx` ON `push_subscriptions` (`enabled`,`updated_at`);--> statement-breakpoint
INSERT OR IGNORE INTO `push_notification_settings`
(`id`, `enabled`, `delivery_time`, `weekdays_json`)
VALUES (1, 0, '21:30', '[0,1,2,3,4,5,6]');--> statement-breakpoint
PRAGMA optimize;
