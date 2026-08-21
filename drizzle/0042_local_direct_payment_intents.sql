CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  transaction_uuid TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'CARD',
  request_key TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'READY',
  trace_id TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL DEFAULT '',
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '',
  local_durable_at TEXT,
  cloud_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS payment_intents_attempt_status_idx
  ON payment_intents(attempt_id, status, created_at);

CREATE INDEX IF NOT EXISTS payment_intents_transaction_uuid_idx
  ON payment_intents(transaction_uuid, created_at);

CREATE INDEX IF NOT EXISTS payment_intents_status_expiry_idx
ON payment_intents(status, expires_at);
