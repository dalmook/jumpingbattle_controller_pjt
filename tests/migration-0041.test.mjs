import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("parking registration state is attached durably to reservations", async () => {
  const sql = await readFile(new URL("../drizzle/0041_parking_registration_state.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN parking_registration_status TEXT NOT NULL DEFAULT ''/);
  assert.match(sql, /ADD COLUMN parking_registration_request_id TEXT NOT NULL DEFAULT ''/);
  assert.match(sql, /ADD COLUMN parking_registered_vehicle_last4 TEXT NOT NULL DEFAULT ''/);
  assert.match(sql, /ADD COLUMN reservation_id TEXT NOT NULL DEFAULT ''/);
  assert.match(sql, /ADD COLUMN trigger_mode TEXT NOT NULL DEFAULT 'manual'/);
  assert.match(sql, /parking_discount_requests_reservation_idx/);
});
