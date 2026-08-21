CREATE TABLE `room_game_runtime` (
	`room_id` text PRIMARY KEY NOT NULL,
	`game_started_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
