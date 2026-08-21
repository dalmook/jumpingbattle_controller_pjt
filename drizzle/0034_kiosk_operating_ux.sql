CREATE TABLE IF NOT EXISTS customer_product_overrides (
  product_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kiosk_guidance_items (
  id TEXT PRIMARY KEY,
  placement TEXT NOT NULL DEFAULT 'BEFORE_GAME_START',
  content TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS kiosk_guidance_placement_order_idx
ON kiosk_guidance_items(placement, sort_order);

ALTER TABLE customer_visits ADD COLUMN start_token_value TEXT NOT NULL DEFAULT '';

INSERT OR IGNORE INTO customer_product_overrides (product_code, name, sort_order, updated_by)
VALUES
  ('slush', '슬러시', 10, 'migration'),
  ('beverage', '음료', 20, 'migration'),
  ('other', '양말', 30, 'migration');

INSERT OR IGNORE INTO kiosk_guidance_items (id, placement, content, sort_order, active)
VALUES
  ('after-payment-locker', 'AFTER_PAYMENT', '소지품과 짐은 락커에 보관해주세요.', 10, 1),
  ('after-payment-shoes', 'AFTER_PAYMENT', '실내화로 갈아 신어주세요.', 20, 1),
  ('after-payment-return', 'AFTER_PAYMENT', '준비가 끝나면 첫 화면에서 방을 선택하고 게임을 시작해주세요.', 30, 1),
  ('before-start-locker', 'BEFORE_GAME_START', '소지품과 짐을 락커에 보관했어요.', 10, 1),
  ('before-start-shoes', 'BEFORE_GAME_START', '실내화로 갈아 신었어요.', 20, 1),
  ('before-start-safety', 'BEFORE_GAME_START', '안전 안내를 확인했어요.', 30, 1),
  ('before-start-party', 'BEFORE_GAME_START', '입장 인원을 확인했어요.', 40, 1),
  ('before-start-level', 'BEFORE_GAME_START', '선택한 난이도를 확인했어요.', 50, 1),
  ('after-game-timelapse', 'AFTER_GAME', '게임이 끝나면 타임랩스 영상은 프론트에서 받아가세요.', 10, 1);
