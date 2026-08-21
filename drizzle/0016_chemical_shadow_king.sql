CREATE TABLE `game_records` (
	`id` text PRIMARY KEY NOT NULL,
	`session_key` text NOT NULL,
	`reservation_id` text,
	`booking_code` text DEFAULT '' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`customer_name` text DEFAULT '' NOT NULL,
	`room_id` text NOT NULL,
	`room_code` text DEFAULT '' NOT NULL,
	`room_name` text DEFAULT '' NOT NULL,
	`team_name` text DEFAULT '' NOT NULL,
	`map_name` text DEFAULT '' NOT NULL,
	`difficulty_label` text DEFAULT '' NOT NULL,
	`adult_count` integer DEFAULT 0 NOT NULL,
	`youth_count` integer DEFAULT 0 NOT NULL,
	`people` integer DEFAULT 0 NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`level` text DEFAULT '' NOT NULL,
	`base_amount` integer DEFAULT 0 NOT NULL,
	`add_on_amount` integer DEFAULT 0 NOT NULL,
	`discount_amount` integer DEFAULT 0 NOT NULL,
	`deposit_amount` integer DEFAULT 0 NOT NULL,
	`payment_amount` integer DEFAULT 0 NOT NULL,
	`payment_card_amount` integer DEFAULT 0 NOT NULL,
	`payment_cash_amount` integer DEFAULT 0 NOT NULL,
	`payment_account_amount` integer DEFAULT 0 NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`game_date` text NOT NULL,
	`game_time` text NOT NULL,
	`scheduled_date` text DEFAULT '' NOT NULL,
	`scheduled_time` text DEFAULT '' NOT NULL,
	`started_at` text DEFAULT '' NOT NULL,
	`ended_at` text NOT NULL,
	`duration_seconds` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_records_session_key_unique` ON `game_records` (`session_key`);--> statement-breakpoint
CREATE INDEX `game_records_ended_at_idx` ON `game_records` (`ended_at`);--> statement-breakpoint
CREATE INDEX `game_records_date_room_idx` ON `game_records` (`game_date`,`room_code`,`ended_at`);--> statement-breakpoint
CREATE INDEX `game_records_reservation_idx` ON `game_records` (`reservation_id`);--> statement-breakpoint
PRAGMA optimize;
