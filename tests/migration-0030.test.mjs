import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("0030 targets queued commands at the explicitly configured store agent", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE commands (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO commands (id) VALUES ('existing-command');
  `);
  const migration = await readFile(
    new URL("../drizzle/0030_payment_fast_lane.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  const row = db.prepare(
    "SELECT target_agent_id FROM commands WHERE id = 'existing-command'",
  ).get();
  assert.equal(row.target_agent_id, "store-main");
  const indexes = db.prepare("PRAGMA index_list(commands)").all();
  assert.ok(indexes.some((index) => index.name === "commands_agent_status_created_idx"));
});
