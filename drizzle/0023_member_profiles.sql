ALTER TABLE members ADD COLUMN team_name TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE members ADD COLUMN email TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE members ADD COLUMN vehicle_number TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS members_team_name_idx ON members(team_name);
--> statement-breakpoint
PRAGMA optimize;
