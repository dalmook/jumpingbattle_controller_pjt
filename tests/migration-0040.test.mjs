import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("parking auto-registration migration is durable and auditable", async () => {
  const sql = await readFile(new URL("../drizzle/0040_parking_auto_registration.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN auto_registration_enabled INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS parking_discount_requests/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS parking_discount_requests_idempotency_idx/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS parking_discount_requests_command_idx/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS parking_setting_audit/);
});
