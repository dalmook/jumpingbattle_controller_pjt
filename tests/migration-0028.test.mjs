import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("0028 adds repeat groups and reservation payment allocations", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE reservations (id TEXT PRIMARY KEY);
    CREATE TABLE payments (id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL);
    INSERT INTO reservations (id) VALUES ('game-1'), ('game-2');
    INSERT INTO payments (id, reservation_id) VALUES ('payment-1', 'game-1');
  `);
  const migration = await readFile(new URL("../drizzle/0028_group_payments.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  const reservationColumns = db.prepare(`PRAGMA table_info(reservations)`).all();
  assert.ok(reservationColumns.some((column) => column.name === "repeat_group_id"));
  assert.ok(reservationColumns.some((column) => column.name === "repeat_sequence"));

  db.prepare(`INSERT INTO payment_allocations (
      payment_id, reservation_id, sequence, final_amount, deposit_amount, payable_amount
    ) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("payment-1", "game-1", 1, 19_000, 0, 19_000);
  db.prepare(`INSERT INTO payment_allocations (
      payment_id, reservation_id, sequence, final_amount, deposit_amount, payable_amount
    ) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("payment-1", "game-2", 2, 10_000, 0, 10_000);

  assert.deepEqual(
    db.prepare(`SELECT reservation_id, sequence, final_amount FROM payment_allocations ORDER BY sequence`)
      .all()
      .map((row) => ({ ...row })),
    [
      { reservation_id: "game-1", sequence: 1, final_amount: 19_000 },
      { reservation_id: "game-2", sequence: 2, final_amount: 10_000 },
    ],
  );
});
