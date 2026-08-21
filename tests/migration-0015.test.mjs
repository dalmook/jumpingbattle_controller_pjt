import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("migration restores the omitted August 1 Naver sale and preserves payment", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY, booking_code TEXT, source TEXT, status TEXT,
      active_slot_key TEXT, cancelled_at TEXT, schedule_overridden INTEGER DEFAULT 0,
      details_overridden INTEGER DEFAULT 0, scheduled_date TEXT,
      payment_amount INTEGER, payment_card_amount INTEGER, payment_status TEXT,
      updated_at TEXT
    );
    CREATE TABLE reservation_events (
      id TEXT PRIMARY KEY, reservation_id TEXT, event_type TEXT,
      details_json TEXT, created_by TEXT, created_at TEXT
    );
    INSERT INTO reservations VALUES (
      'reported-booking', 'JB-260801-4B0F7C', 'naver', 'cancelled', NULL,
      '2026-08-01 10:30:00', 1, 1, '2026-08-01', 21000, 21000, 'paid',
      CURRENT_TIMESTAMP
    );
    INSERT INTO reservations VALUES (
      'different-booking', 'JB-260801-OTHER', 'naver', 'cancelled', NULL,
      '2026-08-01 10:30:00', 0, 0, '2026-08-01', 14000, 14000, 'paid',
      CURRENT_TIMESTAMP
    );
  `);

  const migration = await readFile(
    new URL("../drizzle/0015_restore_august_first_sale.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  const restored = { ...db.prepare(`
    SELECT status, active_slot_key, cancelled_at, schedule_overridden,
      details_overridden, payment_amount, payment_card_amount, payment_status
    FROM reservations WHERE id = 'reported-booking'
  `).get() };
  assert.deepEqual(restored, {
    status: "completed",
    active_slot_key: null,
    cancelled_at: null,
    schedule_overridden: 1,
    details_overridden: 1,
    payment_amount: 21000,
    payment_card_amount: 21000,
    payment_status: "paid",
  });
  assert.equal(
    db.prepare("SELECT status FROM reservations WHERE id = 'different-booking'").get().status,
    "cancelled",
  );
  assert.deepEqual(
    { ...db.prepare(`
      SELECT event_type, created_by
      FROM reservation_events WHERE reservation_id = 'reported-booking'
    `).get() },
    { event_type: "complete", created_by: "data-repair" },
  );
});
