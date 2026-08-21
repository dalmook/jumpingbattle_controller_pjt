import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("0031 adds terminal-direct provenance and a reusable duplicate guard", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE payment_attempts (
      id TEXT PRIMARY KEY,
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO payment_attempts (id) VALUES ('existing-attempt');
  `);
  const migration = await readFile(
    new URL("../drizzle/0031_terminal_direct_payments.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  const row = db.prepare(`SELECT transaction_source, verification_status,
      terminal_id, external_transaction_key FROM payment_attempts
      WHERE id = 'existing-attempt'`).get();
  assert.equal(row.transaction_source, "POS_BRIDGE");
  assert.equal(row.verification_status, "VERIFIED");
  assert.equal(row.terminal_id, "");
  assert.equal(row.external_transaction_key, null);

  const indexes = db.prepare("PRAGMA index_list(payment_attempts)").all();
  assert.ok(indexes.some((index) => index.name === "payment_attempts_external_key_uidx"));
  assert.ok(indexes.some((index) => index.name === "payment_attempts_source_idx"));

  db.prepare(`INSERT INTO payment_attempts (id, external_transaction_key)
    VALUES ('first', 'TERMINAL_DIRECT:MPOS-1700AE:20260810:00104911:17000')`).run();
  assert.throws(() => db.prepare(`INSERT INTO payment_attempts (id, external_transaction_key)
    VALUES ('duplicate', 'TERMINAL_DIRECT:MPOS-1700AE:20260810:00104911:17000')`).run());
  db.prepare("INSERT INTO payment_attempts (id) VALUES ('unlinked-one'), ('unlinked-two')").run();
});
