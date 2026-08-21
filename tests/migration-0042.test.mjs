import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sql = fs.readFileSync(new URL("../drizzle/0042_local_direct_payment_intents.sql", import.meta.url), "utf8");

test("local direct payment intent migration keeps signed, expiring, idempotent state", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS payment_intents/i);
  assert.match(sql, /transaction_uuid TEXT NOT NULL/i);
  assert.match(sql, /payment_intents_transaction_uuid_idx/i);
  assert.match(sql, /request_key TEXT NOT NULL UNIQUE/i);
  assert.match(sql, /nonce TEXT NOT NULL UNIQUE/i);
  assert.match(sql, /signature TEXT NOT NULL/i);
  assert.match(sql, /expires_at TEXT NOT NULL/i);
  assert.match(sql, /cloud_synced_at TEXT/i);
});
