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

test("0023 adds searchable member profile fields without losing members", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE reservations (
    id TEXT PRIMARY KEY,
    scheduled_date TEXT NOT NULL DEFAULT ''
  )`);
  await executeMigration(db, "0021_members.sql");
  db.prepare(`INSERT INTO members (id, name, phone, normalized_phone, phone_last4)
    VALUES ('m1', '김점핑', '010-1234-5678', '01012345678', '5678')`).run();

  await executeMigration(db, "0023_member_profiles.sql");
  const columns = db.prepare(`PRAGMA table_info(members)`).all().map((row) => row.name);
  assert.ok(columns.includes("team_name"));
  assert.ok(columns.includes("email"));
  assert.ok(columns.includes("vehicle_number"));
  assert.equal(db.prepare(`SELECT name FROM members WHERE id = 'm1'`).get().name, "김점핑");
});
