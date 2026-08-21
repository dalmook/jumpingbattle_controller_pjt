ALTER TABLE agent_runtime ADD COLUMN bridge_instance_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_runtime ADD COLUMN control_state TEXT NOT NULL DEFAULT 'IDLE';
ALTER TABLE agent_runtime ADD COLUMN current_control_action TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_runtime ADD COLUMN control_started_at TEXT;
ALTER TABLE agent_runtime ADD COLUMN last_control_success_at TEXT;
ALTER TABLE agent_runtime ADD COLUMN last_control_error TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_runtime ADD COLUMN state_stale INTEGER NOT NULL DEFAULT 0;
