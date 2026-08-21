import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sql = fs.readFileSync(
  new URL("../drizzle/0046_kiosk_payment_settings.sql", import.meta.url),
  "utf8",
);

test("kiosk payment settings migration stores operation mode and all payment switches", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS kiosk_payment_settings/i);
  assert.match(sql, /operation_mode TEXT NOT NULL DEFAULT 'STAFFED'/i);
  for (const column of ["card_enabled", "cash_enabled", "bank_transfer_enabled", "pass_enabled", "coupon_enabled"]) {
    assert.match(sql, new RegExp(`${column} INTEGER NOT NULL`, "i"));
  }
});

test("bank transfer sessions keep immutable transaction account snapshots and expiry", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS kiosk_bank_transfer_sessions/i);
  assert.match(sql, /transaction_id TEXT NOT NULL UNIQUE/i);
  assert.match(sql, /bank_name_at_payment TEXT NOT NULL/i);
  assert.match(sql, /account_number_at_payment TEXT NOT NULL/i);
  assert.match(sql, /account_holder_at_payment TEXT NOT NULL/i);
  assert.match(sql, /expires_at TEXT NOT NULL/i);
});
