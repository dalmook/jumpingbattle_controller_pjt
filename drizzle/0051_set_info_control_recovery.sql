ALTER TABLE agent_runtime ADD COLUMN manager_state TEXT NOT NULL DEFAULT 'UNAVAILABLE';
--> statement-breakpoint
ALTER TABLE agent_runtime ADD COLUMN manager_probe_at TEXT;
--> statement-breakpoint
ALTER TABLE agent_runtime ADD COLUMN manager_probe_success_count INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE agent_runtime ADD COLUMN manager_modal_active INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE agent_runtime ADD COLUMN control_loop_last_seen TEXT;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS room_control_runtime (
  room_id TEXT PRIMARY KEY,
  control_state TEXT NOT NULL DEFAULT 'READY',
  current_action TEXT NOT NULL DEFAULT '',
  current_command_id TEXT NOT NULL DEFAULT '',
  last_success_at TEXT,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  last_error_at TEXT,
  state_seen_at TEXT,
  observed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint

INSERT OR IGNORE INTO room_control_runtime (room_id)
SELECT room_id FROM rooms;
