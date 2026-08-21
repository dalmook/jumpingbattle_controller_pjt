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

test("0020 migration preserves legacy payments and creates split-payment graph", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'booked',
      base_amount INTEGER NOT NULL DEFAULT 0,
      add_on_amount INTEGER NOT NULL DEFAULT 0,
      discount_amount INTEGER NOT NULL DEFAULT 0,
      payment_amount INTEGER NOT NULL DEFAULT 0,
      payment_card_amount INTEGER NOT NULL DEFAULT 0,
      payment_cash_amount INTEGER NOT NULL DEFAULT 0,
      payment_account_amount INTEGER NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO reservations (
      id, base_amount, payment_amount, payment_card_amount,
      payment_cash_amount, payment_status
    ) VALUES ('reservation-1', 14000, 14000, 5000, 9000, 'paid');
  `);
  await executeMigration(db, "0019_mpos_payment_attempts.sql");
  await executeMigration(db, "0020_split_payments.sql");

  const payment = { ...db.prepare(`
    SELECT reservation_id, split_count, final_amount, payable_amount, status
    FROM payments WHERE reservation_id = 'reservation-1'
  `).get() };
  assert.deepEqual(payment, {
    reservation_id: "reservation-1",
    split_count: 2,
    final_amount: 14_000,
    payable_amount: 14_000,
    status: "PAID",
  });

  const rows = db.prepare(`
    SELECT payment_method, amount, status, payment_id, split_index
    FROM payment_attempts WHERE reservation_id = 'reservation-1'
    ORDER BY split_index
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    {
      payment_method: "card",
      amount: 5_000,
      status: "APPROVED",
      payment_id: "reservation-1-LEGACY-PAYMENT",
      split_index: 1,
    },
    {
      payment_method: "cash",
      amount: 9_000,
      status: "COMPLETED",
      payment_id: "reservation-1-LEGACY-PAYMENT",
      split_index: 2,
    },
  ]);

  db.prepare(`UPDATE payments SET plan_request_key = ? WHERE reservation_id = ?`)
    .run("plan-key-1", "reservation-1");
  db.prepare(`INSERT INTO reservations (id) VALUES ('reservation-2')`).run();
  assert.throws(
    () => db.prepare(`
      INSERT INTO payments (
        id, reservation_id, plan_request_key, requested_by
      ) VALUES ('payment-2', 'reservation-2', 'plan-key-1', 'mock')
    `).run(),
    /UNIQUE constraint failed/,
  );

  const columns = db.prepare(`PRAGMA table_info(payment_attempts)`).all().map((row) => row.name);
  for (const column of ["payment_id", "split_index", "payment_method", "request_key"]) {
    assert.equal(columns.includes(column), true);
  }
});
