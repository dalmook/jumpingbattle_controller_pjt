import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("notification schedule migration preserves the previous single schedule", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE push_notification_settings (
      id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL,
      delivery_time TEXT NOT NULL,
      weekdays_json TEXT NOT NULL,
      last_sent_date TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO push_notification_settings VALUES (
      1, 1, '20:30', '[1,3,5]', '2026-08-07', 'owner@example.com', '2026-08-07 20:31:00'
    );
  `);

  const migration = await readFile(
    new URL("../drizzle/0018_clear_titania.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  assert.deepEqual(
    { ...db.prepare(`
      SELECT id, name, enabled, delivery_time, weekdays_json, last_sent_date, sort_order
      FROM push_notification_schedules
    `).get() },
    {
      id: "default",
      name: "마감 매출",
      enabled: 1,
      delivery_time: "20:30",
      weekdays_json: "[1,3,5]",
      last_sent_date: "2026-08-07",
      sort_order: 0,
    },
  );
});
