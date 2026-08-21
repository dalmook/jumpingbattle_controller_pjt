import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

async function executeMigration(db, name) {
  const migration = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

test("0021 adds members without changing existing reservation data", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY,
      scheduled_date TEXT NOT NULL DEFAULT '',
      team_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'booked',
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      payment_amount INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO reservations (id, scheduled_date, team_name) VALUES ('r1', '2026-08-10', '기존 예약');
  `);
  await executeMigration(db, "0021_members.sql");
  const original = { ...db.prepare(`SELECT id, team_name, member_id FROM reservations WHERE id = 'r1'`).get() };
  assert.deepEqual(original, { id: "r1", team_name: "기존 예약", member_id: null });

  db.prepare(`INSERT INTO members (id, name, phone, normalized_phone, phone_last4) VALUES (?, ?, ?, ?, ?)`)
    .run("m1", "김점핑", "010-1234-5678", "01012345678", "5678");
  db.prepare(`UPDATE reservations SET member_id = 'm1' WHERE id = 'r1'`).run();
  assert.equal(db.prepare(`SELECT member_id FROM reservations WHERE id = 'r1'`).get().member_id, "m1");
  assert.throws(() => db.prepare(`INSERT INTO members (id, name, phone, normalized_phone) VALUES ('m2','중복','010-1234-5678','01012345678')`).run(), /UNIQUE constraint failed/);
});
