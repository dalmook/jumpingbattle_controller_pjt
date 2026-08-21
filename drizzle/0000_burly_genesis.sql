CREATE TABLE `agents` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`version` text DEFAULT '' NOT NULL,
	`last_seen` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`action` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text NOT NULL,
	`result` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL,
	`claimed_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `commands_status_created_idx` ON `commands` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `commands_room_status_idx` ON `commands` (`room_id`,`status`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`room_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`size` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`team_name` text DEFAULT '' NOT NULL,
	`map_name` text DEFAULT '' NOT NULL,
	`map_index` integer DEFAULT 0 NOT NULL,
	`people` integer DEFAULT 0 NOT NULL,
	`remaining_seconds` integer DEFAULT 0 NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`level` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
