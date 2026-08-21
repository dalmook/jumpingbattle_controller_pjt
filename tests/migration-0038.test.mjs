import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("parking settings migration creates one durable configuration row", async () => {
  const sql = await readFile(new URL("../drizzle/0038_kiosk_parking_settings.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS kiosk_parking_settings/);
  assert.match(sql, /id INTEGER PRIMARY KEY CHECK \(id = 1\)/);
  assert.match(sql, /session_max_seconds INTEGER NOT NULL DEFAULT 30/);
  assert.match(sql, /INSERT OR IGNORE INTO kiosk_parking_settings/);
  assert.match(sql, /parking\.example\.com\/discount\/registration/);
});

test("parking timeout migration updates an existing store setting to 30 seconds", async () => {
  const sql = await readFile(new URL("../drizzle/0039_parking_timeout_30_seconds.sql", import.meta.url), "utf8");
  assert.match(sql, /UPDATE kiosk_parking_settings/);
  assert.match(sql, /SET session_max_seconds = 30/);
  assert.match(sql, /WHERE id = 1/);
});
