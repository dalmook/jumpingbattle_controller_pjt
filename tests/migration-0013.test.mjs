import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("migration reopens imported Naver completions but preserves local completions and cancellations", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY, source TEXT, source_status TEXT, status TEXT,
      active_slot_key TEXT UNIQUE, cancelled_at TEXT, scheduled_date TEXT,
      scheduled_time TEXT, room_code TEXT, updated_at TEXT
    );
    CREATE TABLE reservation_events (
      reservation_id TEXT, event_type TEXT
    );
    INSERT INTO reservations VALUES
      ('import-finished', 'naver', '이용완료', 'completed', NULL, NULL,
        '2999-08-02', '10:00', 'A1', CURRENT_TIMESTAMP),
      ('store-finished', 'naver', '이용완료', 'completed', NULL, NULL,
        '2999-08-02', '10:20', 'B1', CURRENT_TIMESTAMP),
      ('naver-cancelled', 'naver', '이용완료 취소', 'completed', NULL, NULL,
        '2999-08-02', '10:40', 'C1', CURRENT_TIMESTAMP);
    INSERT INTO reservation_events VALUES
      ('import-finished', 'import_completed'),
      ('store-finished', 'auto_complete_game_stopped');
  `);

  const migration = await readFile(
    new URL("../drizzle/0013_keep_naver_operation_state.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  const rows = db
    .prepare(`
      SELECT id, status, active_slot_key, cancelled_at
      FROM reservations ORDER BY id
    `)
    .all()
    .map((row) => ({ ...row }));

  assert.equal(rows[0].id, "import-finished");
  assert.equal(rows[0].status, "booked");
  assert.match(rows[0].active_slot_key, /^2999-08-02\|10:00\|A1\|naver-reopen\|/);
  assert.equal(rows[0].cancelled_at, null);

  assert.deepEqual(rows[1], {
    id: "naver-cancelled",
    status: "cancelled",
    active_slot_key: null,
    cancelled_at: rows[1].cancelled_at,
  });
  assert.ok(rows[1].cancelled_at);

  assert.deepEqual(rows[2], {
    id: "store-finished",
    status: "completed",
    active_slot_key: null,
    cancelled_at: null,
  });
});
