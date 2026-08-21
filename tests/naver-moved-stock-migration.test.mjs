import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../", import.meta.url);

test("migration marks only previously moved Naver reservations as schedule overrides", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL
    );
    CREATE TABLE reservation_events (
      reservation_id TEXT NOT NULL,
      event_type TEXT NOT NULL
    );
    INSERT INTO reservations (id, source) VALUES
      ('native-naver', 'naver'),
      ('moved-naver', 'naver'),
      ('moved-local', 'web_walkin');
    INSERT INTO reservation_events (reservation_id, event_type) VALUES
      ('moved-naver', 'move'),
      ('moved-local', 'move');
  `);

  const migration = await readFile(
    new URL("drizzle/0010_polite_madame_web.sql", root),
    "utf8",
  );
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  const rows = db
    .prepare(
      "SELECT id, schedule_overridden FROM reservations ORDER BY id",
    )
    .all()
    .map(({ id, schedule_overridden }) => ({ id, schedule_overridden }));

  assert.deepEqual(rows, [
    { id: "moved-local", schedule_overridden: 0 },
    { id: "moved-naver", schedule_overridden: 1 },
    { id: "native-naver", schedule_overridden: 0 },
  ]);
});
