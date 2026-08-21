import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sql = fs.readFileSync(
  new URL("../drizzle/0045_mobile_remote_operations.sql", import.meta.url),
  "utf8",
);

test("mobile remote migration adds kiosk heartbeat and deduplicated operational notifications", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS kiosk_runtime/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS push_operational_settings/i);
  assert.match(sql, /dedup_key TEXT NOT NULL UNIQUE/i);
  assert.match(sql, /PRIMARY KEY \(event_id, device_id\)/i);
  assert.match(sql, /KIOSK_PAYMENT_CONFIRM_REQUIRED/i);
  assert.match(sql, /BRIDGE_OFFLINE/i);
});
