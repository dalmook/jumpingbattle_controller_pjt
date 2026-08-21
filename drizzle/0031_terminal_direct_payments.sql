ALTER TABLE payment_attempts ADD COLUMN transaction_source TEXT NOT NULL DEFAULT 'POS_BRIDGE';
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'VERIFIED';
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN approval_time TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN terminal_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN external_transaction_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN external_transaction_key TEXT;
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN operator_note TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_external_key_uidx
ON payment_attempts(external_transaction_key)
WHERE external_transaction_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_attempts_source_idx
ON payment_attempts(transaction_source, requested_at);
