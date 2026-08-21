import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("migration restores the reported Naver completion and latest admin details", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY, booking_code TEXT, source TEXT, status TEXT,
      active_slot_key TEXT, cancelled_at TEXT, schedule_overridden INTEGER DEFAULT 0,
      room_code TEXT, team_name TEXT, difficulty_code TEXT, difficulty_label TEXT,
      map_index INTEGER, adult_count INTEGER, youth_count INTEGER, total_count INTEGER,
      vehicle_last4 TEXT, base_amount INTEGER, memo TEXT, updated_at TEXT
    );
    CREATE TABLE reservation_events (
      id TEXT PRIMARY KEY, reservation_id TEXT, event_type TEXT,
      details_json TEXT, created_at TEXT
    );
  `);
  db.prepare(`
    INSERT INTO reservations VALUES (
      'r1', 'JB-260801-4B0F7C', 'naver', 'cancelled', NULL, CURRENT_TIMESTAMP, 1,
      'A1', 'SVP H팀화이팅', 'santa', '산타', 9, 0, 0, 0, '', 0, '', CURRENT_TIMESTAMP
    )
  `).run();
  db.prepare(`
    INSERT INTO reservation_events VALUES (
      'e1', 'r1', 'details', ?, CURRENT_TIMESTAMP
    )
  `).run(JSON.stringify({
    teamName: "SVP H팀화이팅",
    difficultyCode: "normal",
    difficultyLabel: "노멀",
    mapIndex: 3,
    adultCount: 2,
    youthCount: 0,
    totalCount: 2,
    vehicleLast4: "",
    baseAmount: 21_000,
    memo: "",
  }));

  const migration = await readFile(
    new URL("../drizzle/0012_superb_loners.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  const restoredRow = db.prepare(`
    SELECT status, room_code, difficulty_code, difficulty_label, map_index,
      details_overridden, cancelled_at
    FROM reservations WHERE id = 'r1'
  `).get();
  const restored = { ...restoredRow };
  assert.deepEqual(restored, {
    status: "completed",
    room_code: "A1",
    difficulty_code: "normal",
    difficulty_label: "노멀",
    map_index: 3,
    details_overridden: 1,
    cancelled_at: null,
  });
});
