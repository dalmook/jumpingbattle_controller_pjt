ALTER TABLE kiosk_parking_settings
ADD COLUMN auto_registration_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS parking_discount_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  car_last4 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  match_count INTEGER NOT NULL DEFAULT 0,
  results_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  dry_run INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT NOT NULL,
  command_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS parking_discount_requests_idempotency_idx
ON parking_discount_requests(idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS parking_discount_requests_command_idx
ON parking_discount_requests(command_id);

CREATE INDEX IF NOT EXISTS parking_discount_requests_status_created_idx
ON parking_discount_requests(status, created_at);

CREATE TABLE IF NOT EXISTS parking_setting_audit (
  id TEXT PRIMARY KEY,
  setting_key TEXT NOT NULL,
  previous_value TEXT NOT NULL,
  next_value TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
