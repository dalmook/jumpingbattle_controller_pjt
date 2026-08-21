import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("0029 adds payment trace ids and structured latency events", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE payment_attempts (
      id TEXT PRIMARY KEY,
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const migration = await readFile(
    new URL("../drizzle/0029_payment_latency_trace.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  const columns = db.prepare("PRAGMA table_info(payment_attempts)").all();
  assert.ok(columns.some((column) => column.name === "trace_id"));
  db.prepare(`INSERT INTO payment_latency_events (
      trace_id, component, stage, iso_timestamp, elapsed_ms, duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      "PAY-20260811-201500-AB12CD",
      "mpos",
      "FDK_EXECUTE_DONE",
      "2026-08-11T20:15:01.000+09:00",
      6920.25,
      6910.5,
    );
  const row = db.prepare(
    "SELECT trace_id, elapsed_ms, duration_ms FROM payment_latency_events",
  ).get();
  assert.equal(row.trace_id, "PAY-20260811-201500-AB12CD");
  assert.equal(row.elapsed_ms, 6920.25);
  assert.equal(row.duration_ms, 6910.5);
});
