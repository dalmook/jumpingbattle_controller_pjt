ALTER TABLE reservations
ADD COLUMN parking_registration_status TEXT NOT NULL DEFAULT '';

ALTER TABLE reservations
ADD COLUMN parking_registration_request_id TEXT NOT NULL DEFAULT '';

ALTER TABLE reservations
ADD COLUMN parking_registered_vehicle_last4 TEXT NOT NULL DEFAULT '';

ALTER TABLE reservations
ADD COLUMN parking_registration_completed_at TEXT;

ALTER TABLE parking_discount_requests
ADD COLUMN reservation_id TEXT NOT NULL DEFAULT '';

ALTER TABLE parking_discount_requests
ADD COLUMN trigger_mode TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS parking_discount_requests_reservation_idx
ON parking_discount_requests(reservation_id, created_at);
