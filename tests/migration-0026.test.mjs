import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("0026 adds configurable add-on product snapshots without changing existing rows", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pricing_settings (id INTEGER PRIMARY KEY);
    INSERT INTO pricing_settings (id) VALUES (1);
    CREATE TABLE add_on_sale_orders (id TEXT PRIMARY KEY);
    INSERT INTO add_on_sale_orders (id) VALUES ('existing');
  `);
  const migration = await readFile(
    new URL("../drizzle/0026_configurable_add_on_items.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
  assert.equal(db.prepare(`SELECT extra_add_on_items_json FROM pricing_settings WHERE id = 1`).get().extra_add_on_items_json, "[]");
  assert.equal(db.prepare(`SELECT items_json FROM add_on_sale_orders WHERE id = 'existing'`).get().items_json, "[]");
});
