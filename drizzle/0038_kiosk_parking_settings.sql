CREATE TABLE IF NOT EXISTS kiosk_parking_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  registration_url TEXT NOT NULL,
  session_max_seconds INTEGER NOT NULL DEFAULT 30,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO kiosk_parking_settings (
  id,
  enabled,
  registration_url,
  session_max_seconds
) VALUES (
  1,
  0,
  'https://parking.example.com/discount/registration?SWversion=ATS3000V2.89_20231018',
  30
);
