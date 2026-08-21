ALTER TABLE payment_attempts ADD COLUMN trace_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_attempts_trace_idx
  ON payment_attempts(trace_id, requested_at)
  WHERE trace_id <> '';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS payment_latency_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  component TEXT NOT NULL,
  stage TEXT NOT NULL,
  iso_timestamp TEXT NOT NULL,
  elapsed_ms REAL NOT NULL DEFAULT 0,
  duration_ms REAL,
  reservation_id TEXT NOT NULL DEFAULT '',
  payment_id TEXT NOT NULL DEFAULT '',
  attempt_id TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_latency_trace_stage_idx
  ON payment_latency_events(trace_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_latency_created_idx
  ON payment_latency_events(created_at);

