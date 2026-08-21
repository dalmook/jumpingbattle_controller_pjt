ALTER TABLE customer_visits ADD COLUMN game_count INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS customer_visit_games (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'HOLD',
  scheduled_date TEXT NOT NULL,
  scheduled_time TEXT NOT NULL,
  room_code TEXT NOT NULL,
  room_size TEXT NOT NULL,
  difficulty_code TEXT NOT NULL,
  difficulty_label TEXT NOT NULL DEFAULT '',
  map_index INTEGER NOT NULL DEFAULT 0,
  adult_count INTEGER NOT NULL DEFAULT 0,
  youth_count INTEGER NOT NULL DEFAULT 0,
  party_count INTEGER NOT NULL DEFAULT 0,
  base_amount INTEGER NOT NULL DEFAULT 0,
  hold_id TEXT NOT NULL DEFAULT '',
  active_slot_key TEXT,
  reservation_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(visit_id, sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_visit_games_active_slot_idx
ON customer_visit_games(active_slot_key);

CREATE INDEX IF NOT EXISTS customer_visit_games_visit_idx
ON customer_visit_games(visit_id, sequence);

CREATE INDEX IF NOT EXISTS customer_visit_games_reservation_idx
ON customer_visit_games(reservation_id);

CREATE INDEX IF NOT EXISTS customer_visit_games_schedule_idx
ON customer_visit_games(scheduled_date, scheduled_time, room_code, status);

CREATE INDEX IF NOT EXISTS customer_visit_games_expiry_idx
ON customer_visit_games(status, expires_at);
