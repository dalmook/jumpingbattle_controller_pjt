CREATE TABLE `reservation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`event_type` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_by` text DEFAULT 'system' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reservation_events_reservation_idx` ON `reservation_events` (`reservation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `reservation_rate_limits` (
	`client_key` text PRIMARY KEY NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`window_started` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_code` text NOT NULL,
	`source` text DEFAULT 'web_walkin' NOT NULL,
	`source_booking_no` text,
	`source_product` text DEFAULT '' NOT NULL,
	`source_status` text DEFAULT '' NOT NULL,
	`source_link` text DEFAULT '' NOT NULL,
	`customer_name` text DEFAULT '' NOT NULL,
	`customer_phone` text DEFAULT '' NOT NULL,
	`scheduled_date` text DEFAULT '' NOT NULL,
	`scheduled_time` text DEFAULT '' NOT NULL,
	`room_code` text DEFAULT '' NOT NULL,
	`active_slot_key` text,
	`team_name` text DEFAULT '' NOT NULL,
	`difficulty_code` text DEFAULT '' NOT NULL,
	`difficulty_label` text DEFAULT '' NOT NULL,
	`map_index` integer DEFAULT 0 NOT NULL,
	`adult_count` integer DEFAULT 0 NOT NULL,
	`youth_count` integer DEFAULT 0 NOT NULL,
	`total_count` integer DEFAULT 0 NOT NULL,
	`vehicle_last4` text DEFAULT '' NOT NULL,
	`consent_text` text DEFAULT '' NOT NULL,
	`game_minutes` integer DEFAULT 16 NOT NULL,
	`base_amount` integer DEFAULT 0 NOT NULL,
	`add_on_amount` integer DEFAULT 0 NOT NULL,
	`discount_amount` integer DEFAULT 0 NOT NULL,
	`payment_amount` integer DEFAULT 0 NOT NULL,
	`payment_method` text DEFAULT '' NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`status` text DEFAULT 'booked' NOT NULL,
	`memo` text DEFAULT '' NOT NULL,
	`idempotency_key` text,
	`manager_loaded_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_booking_code_uidx` ON `reservations` (`booking_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_source_booking_no_uidx` ON `reservations` (`source_booking_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_active_slot_key_uidx` ON `reservations` (`active_slot_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_idempotency_key_uidx` ON `reservations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `reservations_schedule_idx` ON `reservations` (`scheduled_date`,`scheduled_time`);--> statement-breakpoint
CREATE INDEX `reservations_status_idx` ON `reservations` (`status`,`updated_at`);