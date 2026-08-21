CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  attempt_type TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  sale_amount INTEGER NOT NULL DEFAULT 0,
  add_on_amount INTEGER NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  response_code TEXT NOT NULL DEFAULT '',
  response_message TEXT NOT NULL DEFAULT '',
  auth_no TEXT NOT NULL DEFAULT '',
  auth_date TEXT NOT NULL DEFAULT '',
  issuer_name TEXT NOT NULL DEFAULT '',
  acquirer_name TEXT NOT NULL DEFAULT '',
  masked_card_no TEXT NOT NULL DEFAULT '',
  raw_return_code INTEGER,
  error_code TEXT NOT NULL DEFAULT 'NONE',
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  mpos_transaction_id INTEGER,
  original_attempt_id TEXT,
  original_mpos_transaction_id INTEGER,
  command_id TEXT UNIQUE,
  active_key TEXT UNIQUE,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(reservation_id) REFERENCES reservations(id),
  FOREIGN KEY(original_attempt_id) REFERENCES payment_attempts(id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_attempts_reservation_idx
  ON payment_attempts(reservation_id, requested_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_attempts_original_idx
  ON payment_attempts(original_attempt_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS payment_terminal_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  connected INTEGER NOT NULL DEFAULT 0,
  payment_ready INTEGER NOT NULL DEFAULT 0,
  response_code TEXT NOT NULL DEFAULT '',
  response_message TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  firmware TEXT NOT NULL DEFAULT '',
  integrity TEXT NOT NULL DEFAULT '',
  raw_return_code INTEGER,
  error_code TEXT NOT NULL DEFAULT 'DEVICE_OFFLINE',
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
