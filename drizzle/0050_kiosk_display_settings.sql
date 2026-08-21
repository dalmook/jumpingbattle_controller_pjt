CREATE TABLE IF NOT EXISTS kiosk_display_settings (
  id TEXT PRIMARY KEY,
  home_title TEXT NOT NULL DEFAULT '오늘도 신나게 뛰어볼까요?',
  home_subtitle TEXT NOT NULL DEFAULT '예약 확인 또는 현장 이용을 선택해주세요.',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO kiosk_display_settings
  (id, home_title, home_subtitle, updated_by)
VALUES
  ('main', '오늘도 신나게 뛰어볼까요?', '예약 확인 또는 현장 이용을 선택해주세요.', 'system');
