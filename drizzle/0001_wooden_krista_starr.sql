CREATE TABLE `agent_runtime` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`armed` integer DEFAULT 0 NOT NULL,
	`simulate` integer DEFAULT 0 NOT NULL,
	`manager_visible` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `room_metadata` (
	`room_id` text PRIMARY KEY NOT NULL,
	`map_options_json` text DEFAULT '[]' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
