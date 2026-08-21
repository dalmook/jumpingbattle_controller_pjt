CREATE TABLE IF NOT EXISTS customer_visits (
  id TEXT PRIMARY KEY,
  session_token_hash TEXT NOT NULL UNIQUE,
  kiosk_id TEXT NOT NULL DEFAULT '',
  flow_type TEXT NOT NULL DEFAULT 'WALK_IN',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  party_count INTEGER NOT NULL DEFAULT 1,
  adult_count INTEGER NOT NULL DEFAULT 0,
  youth_count INTEGER NOT NULL DEFAULT 1,
  representative_member_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  team_name TEXT NOT NULL DEFAULT '',
  scheduled_date TEXT NOT NULL DEFAULT '',
  scheduled_time TEXT NOT NULL DEFAULT '',
  room_code TEXT NOT NULL DEFAULT '',
  difficulty_code TEXT NOT NULL DEFAULT '',
  difficulty_label TEXT NOT NULL DEFAULT '',
  map_index INTEGER NOT NULL DEFAULT 0,
  reservation_id TEXT UNIQUE,
  hold_id TEXT,
  add_ons_json TEXT NOT NULL DEFAULT '{}',
  settlement_json TEXT NOT NULL DEFAULT '{}',
  stamp_allocations_json TEXT NOT NULL DEFAULT '[]',
  base_amount INTEGER NOT NULL DEFAULT 0,
  add_on_amount INTEGER NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  final_amount INTEGER NOT NULL DEFAULT 0,
  start_token_hash TEXT NOT NULL DEFAULT '',
  start_token_expires_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS customer_visits_status_updated_idx
ON customer_visits(status, updated_at);
CREATE INDEX IF NOT EXISTS customer_visits_room_status_idx
ON customer_visits(room_code, status, updated_at);
CREATE INDEX IF NOT EXISTS customer_visits_reservation_idx
ON customer_visits(reservation_id);

CREATE TABLE IF NOT EXISTS customer_visit_members (
  visit_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'PARTICIPANT',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (visit_id, member_id)
);

CREATE INDEX IF NOT EXISTS customer_visit_members_member_idx
ON customer_visit_members(member_id, created_at);

CREATE TABLE IF NOT EXISTS customer_room_holds (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL UNIQUE,
  store_code TEXT NOT NULL DEFAULT 'HWASEONG_BYEONGJEOM',
  scheduled_date TEXT NOT NULL,
  scheduled_time TEXT NOT NULL,
  room_code TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE',
  active_slot_key TEXT UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS customer_room_holds_schedule_idx
ON customer_room_holds(scheduled_date, scheduled_time, room_code, state);
CREATE INDEX IF NOT EXISTS customer_room_holds_expiry_idx
ON customer_room_holds(state, expires_at);

CREATE TABLE IF NOT EXISTS customer_product_availability (
  product_code TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'SALE',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_stamp_allocations (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING',
  reference_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS customer_stamp_allocations_visit_idx
ON customer_stamp_allocations(visit_id, status);
