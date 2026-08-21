CREATE TABLE IF NOT EXISTS kiosk_visit_admin_audit (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  previous_status TEXT NOT NULL DEFAULT '',
  next_status TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kiosk_visit_admin_audit_visit_created_idx
  ON kiosk_visit_admin_audit(visit_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kiosk_visit_admin_audit_action_created_idx
  ON kiosk_visit_admin_audit(action, created_at DESC);
--> statement-breakpoint
PRAGMA optimize;
