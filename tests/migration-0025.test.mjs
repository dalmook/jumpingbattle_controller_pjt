import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("0025 creates transactional add-on sale orders", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE reservations (id TEXT PRIMARY KEY)`);
  const migration = await readFile(
    new URL("../drizzle/0025_add_on_payment_orders.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
  const columns = db.prepare(`PRAGMA table_info(add_on_sale_orders)`).all().map((row) => row.name);
  for (const name of [
    "reservation_id",
    "sales_date",
    "slush_count",
    "beverage_count",
    "other_count",
    "payment_card_amount",
    "payment_cash_amount",
    "payment_account_amount",
  ]) assert.ok(columns.includes(name));
  db.prepare(`INSERT INTO reservations (id) VALUES ('r1')`).run();
  db.prepare(`INSERT INTO add_on_sale_orders (
    id, reservation_id, sales_date, slush_count, slush_unit_price, amount
  ) VALUES ('o1', 'r1', '2026-08-10', 2, 1500, 3000)`).run();
  assert.equal(db.prepare(`SELECT amount FROM add_on_sale_orders WHERE id = 'o1'`).get().amount, 3000);
  assert.throws(() => db.prepare(`INSERT INTO add_on_sale_orders (
    id, reservation_id, sales_date
  ) VALUES ('o2', 'r1', '2026-08-10')`).run());
});
