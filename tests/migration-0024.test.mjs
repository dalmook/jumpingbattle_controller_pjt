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

test("0024 adds pass purchase credit and initial multi-use fields", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE pass_purchase_orders (
    id TEXT PRIMARY KEY,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
  )`);
  db.prepare(`INSERT INTO pass_purchase_orders (id, amount) VALUES ('old', 45000)`).run();
  await executeMigration(db, "0024_multi_pass_usage.sql");
  const columns = db.prepare(`PRAGMA table_info(pass_purchase_orders)`).all().map((row) => row.name);
  for (const name of ["list_amount", "credit_amount", "initial_used_uses"]) assert.ok(columns.includes(name));
  assert.equal(db.prepare(`SELECT list_amount FROM pass_purchase_orders WHERE id = 'old'`).get().list_amount, 45_000);

  db.prepare(`INSERT INTO pass_purchase_orders (id, amount, credit_reservation_id) VALUES ('one', 40000, 'r1')`).run();
  assert.throws(() => db.prepare(`INSERT INTO pass_purchase_orders (id, amount, credit_reservation_id) VALUES ('two', 40000, 'r1')`).run());
  db.prepare(`UPDATE pass_purchase_orders SET status = 'CANCELLED' WHERE id = 'one'`).run();
  db.prepare(`INSERT INTO pass_purchase_orders (id, amount, credit_reservation_id) VALUES ('two', 40000, 'r1')`).run();
});
