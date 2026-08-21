ALTER TABLE reservations ADD COLUMN repeat_group_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE reservations ADD COLUMN repeat_sequence INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS reservations_repeat_group_idx
  ON reservations(repeat_group_id, repeat_sequence)
  WHERE repeat_group_id <> '';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS payment_allocations (
  payment_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 1,
  final_amount INTEGER NOT NULL DEFAULT 0,
  deposit_amount INTEGER NOT NULL DEFAULT 0,
  payable_amount INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (payment_id, reservation_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_allocations_reservation_idx
  ON payment_allocations(reservation_id, payment_id);
