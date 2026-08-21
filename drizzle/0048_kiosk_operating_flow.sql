ALTER TABLE kiosk_guidance_items ADD COLUMN title TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE kiosk_guidance_items ADD COLUMN summary TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE kiosk_guidance_items ADD COLUMN agreement_text TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE kiosk_guidance_items ADD COLUMN required INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE kiosk_guidance_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kiosk_guidance_agreements (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  guidance_id TEXT NOT NULL,
  guidance_version INTEGER NOT NULL,
  agreed INTEGER NOT NULL DEFAULT 1,
  agreed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(visit_id, guidance_id, guidance_version)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kiosk_guidance_agreements_visit_idx
  ON kiosk_guidance_agreements(visit_id, agreed_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kiosk_room_recommendation_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  adult_min INTEGER NOT NULL DEFAULT 0,
  adult_max INTEGER NOT NULL DEFAULT 10,
  youth_min INTEGER NOT NULL DEFAULT 0,
  youth_max INTEGER NOT NULL DEFAULT 10,
  total_min INTEGER NOT NULL DEFAULT 1,
  total_max INTEGER NOT NULL DEFAULT 10,
  primary_size TEXT NOT NULL,
  secondary_size TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kiosk_room_recommendation_active_priority_idx
  ON kiosk_room_recommendation_rules(active, priority, total_min, total_max);
--> statement-breakpoint
INSERT OR IGNORE INTO kiosk_room_recommendation_rules
  (id, name, adult_min, adult_max, youth_min, youth_max, total_min, total_max, primary_size, secondary_size, priority)
VALUES
  ('default-small-1-4', '1~4명', 0, 10, 0, 10, 1, 4, 'SMALL', 'MEDIUM', 10),
  ('default-medium-5-6', '5~6명', 0, 10, 0, 10, 5, 6, 'MEDIUM', 'LARGE', 20),
  ('default-large-7-10', '7명 이상', 0, 10, 0, 10, 7, 10, 'LARGE', '', 30);
--> statement-breakpoint
INSERT OR IGNORE INTO kiosk_guidance_items
  (id, placement, content, title, summary, agreement_text, required, version, sort_order, active)
VALUES
  ('required-safety-consent', 'REQUIRED_AGREEMENT',
   '부주의로 인한 사고·부상 및 LED로 인한 어지러움·구토 등의 증상 발생 시, 이에 대한 책임은 이용자에게 있습니다.',
   '안전 이용 안내', '게임 전 안전수칙과 이용자 책임 범위를 확인해주세요.',
   '필수 이용안내를 확인했고 동의합니다.', 1, 1, 10, 1);
--> statement-breakpoint
UPDATE kiosk_guidance_items
SET title = CASE id
    WHEN 'before-start-safety' THEN '안전 이용 안내'
    ELSE CASE placement
      WHEN 'BEFORE_GAME_START' THEN '게임 시작 전 확인'
      WHEN 'AFTER_PAYMENT' THEN '이용 준비 안내'
      ELSE '이용 안내'
    END
  END,
  summary = CASE WHEN summary = '' THEN content ELSE summary END,
  agreement_text = CASE WHEN id = 'before-start-safety' THEN '안전 이용안내를 확인했고 동의합니다.' ELSE agreement_text END,
  required = CASE WHEN id = 'before-start-safety' THEN 1 ELSE required END,
  version = CASE WHEN version < 1 THEN 1 ELSE version END;
--> statement-breakpoint
PRAGMA optimize;
