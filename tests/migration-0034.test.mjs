import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("0034 adds kiosk guidance, product overrides and resumable start token", async () => {
  const sql = await readFile(new URL("../drizzle/0034_kiosk_operating_ux.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS customer_product_overrides/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS kiosk_guidance_items/);
  assert.match(sql, /ALTER TABLE customer_visits ADD COLUMN start_token_value/);
  assert.match(sql, /BEFORE_GAME_START/);
  assert.match(sql, /AFTER_PAYMENT/);
});
