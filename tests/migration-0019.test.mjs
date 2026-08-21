import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("MPOS payment migration enforces durable UUID and active-attempt uniqueness", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE reservations (id TEXT PRIMARY KEY);
    INSERT INTO reservations(id) VALUES ('reservation-1');
  `);
  const migration = await readFile(
    new URL("../drizzle/0019_mpos_payment_attempts.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  const insert = db.prepare(`
    INSERT INTO payment_attempts
      (id, reservation_id, attempt_type, attempt_number, amount, active_key,
       requested_by)
    VALUES (?, 'reservation-1', 'PAY', ?, 1000, ?, 'tester')
  `);
  insert.run("reservation-1-PAY-1", 1, "reservation-1:PAY");
  assert.throws(
    () => insert.run("reservation-1-PAY-2", 2, "reservation-1:PAY"),
    /UNIQUE constraint failed/,
  );
  db.prepare(`UPDATE payment_attempts SET active_key = NULL WHERE id = ?`).run(
    "reservation-1-PAY-1",
  );
  insert.run("reservation-1-PAY-2", 2, "reservation-1:PAY");
  assert.throws(
    () => insert.run("reservation-1-PAY-2", 3, null),
    /UNIQUE constraint failed/,
  );

  const columns = db
    .prepare(`PRAGMA table_info(payment_attempts)`)
    .all()
    .map((column) => column.name);
  for (const unsafe of ["card_number", "track1", "track2", "ic_data", "pin"]) {
    assert.equal(columns.includes(unsafe), false);
  }
  for (const required of [
    "auth_no",
    "auth_date",
    "masked_card_no",
    "mpos_transaction_id",
    "original_attempt_id",
    "original_mpos_transaction_id",
  ]) {
    assert.equal(columns.includes(required), true);
  }
});

