ALTER TABLE commands ADD COLUMN target_agent_id TEXT NOT NULL DEFAULT 'store-main';
--> statement-breakpoint
UPDATE commands
SET target_agent_id = 'store-main'
WHERE target_agent_id = '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS commands_agent_status_created_idx
ON commands(target_agent_id, status, created_at);
