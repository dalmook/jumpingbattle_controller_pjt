CREATE TABLE IF NOT EXISTS kiosk_payment_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  operation_mode TEXT NOT NULL DEFAULT 'STAFFED',
  card_enabled INTEGER NOT NULL DEFAULT 1,
  cash_enabled INTEGER NOT NULL DEFAULT 1,
  bank_transfer_enabled INTEGER NOT NULL DEFAULT 0,
  pass_enabled INTEGER NOT NULL DEFAULT 1,
  coupon_enabled INTEGER NOT NULL DEFAULT 1,
  bank_name TEXT NOT NULL DEFAULT '',
  custom_bank_name TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  account_holder TEXT NOT NULL DEFAULT '',
  guide_text TEXT NOT NULL DEFAULT 'QR을 스캔해 계좌번호를 복사해주세요.',
  depositor_guide TEXT NOT NULL DEFAULT '예약자명 또는 팀명으로 입금해주세요.',
  confirmation_mode TEXT NOT NULL DEFAULT 'STAFF_CONFIRM',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO kiosk_payment_settings (
  id, operation_mode, card_enabled, cash_enabled, bank_transfer_enabled,
  pass_enabled, coupon_enabled, guide_text, depositor_guide, confirmation_mode
) VALUES (
  1, 'STAFFED', 1, 1, 0, 1, 1,
  'QR을 스캔해 계좌번호를 복사해주세요.',
  '예약자명 또는 팀명으로 입금해주세요.',
  'STAFF_CONFIRM'
);

CREATE TABLE IF NOT EXISTS kiosk_bank_transfer_sessions (
  token TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  bank_name_at_payment TEXT NOT NULL,
  account_number_at_payment TEXT NOT NULL,
  account_holder_at_payment TEXT NOT NULL,
  guide_text_at_payment TEXT NOT NULL DEFAULT '',
  depositor_guide_at_payment TEXT NOT NULL DEFAULT '',
  confirmation_mode TEXT NOT NULL DEFAULT 'STAFF_CONFIRM',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS kiosk_bank_transfer_sessions_visit_idx
ON kiosk_bank_transfer_sessions(visit_id, status, updated_at);

CREATE INDEX IF NOT EXISTS kiosk_bank_transfer_sessions_expiry_idx
ON kiosk_bank_transfer_sessions(status, expires_at);
