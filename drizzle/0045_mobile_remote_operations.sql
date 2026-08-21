CREATE TABLE IF NOT EXISTS kiosk_runtime (
  kiosk_id TEXT PRIMARY KEY,
  current_visit_id TEXT NOT NULL DEFAULT '',
  current_status TEXT NOT NULL DEFAULT 'HOME',
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_operational_settings (
  event_type TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_operational_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  target_url TEXT NOT NULL DEFAULT '/admin/remote',
  tag TEXT NOT NULL DEFAULT 'jumping-battle-operation',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS push_operational_events_created_idx
  ON push_operational_events(created_at);

CREATE TABLE IF NOT EXISTS push_operational_deliveries (
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, device_id)
);

INSERT OR IGNORE INTO push_operational_settings (event_type, enabled, updated_by) VALUES
  ('KIOSK_PAYMENT_CONFIRM_REQUIRED', 1, 'system'),
  ('KIOSK_READY_TO_PLAY', 1, 'system'),
  ('KIOSK_START_FAILED', 1, 'system'),
  ('KIOSK_STOP_FAILED', 1, 'system'),
  ('KIOSK_STAFF_HELP', 1, 'system'),
  ('KIOSK_ERROR', 1, 'system'),
  ('BRIDGE_OFFLINE', 1, 'system'),
  ('CONTROL_ERROR', 1, 'system'),
  ('KIOSK_SESSION_STARTED', 0, 'system');
