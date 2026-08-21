import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sql = fs.readFileSync(new URL("../drizzle/0049_kiosk_multi_game_order.sql", import.meta.url), "utf8");

test("kiosk multi-game migration keeps ordered game items under one visit", () => {
  assert.match(sql, /ALTER TABLE customer_visits ADD COLUMN game_count/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS customer_visit_games/i);
  assert.match(sql, /UNIQUE\s*\(visit_id,\s*sequence\)/i);
  assert.match(sql, /customer_visit_games_active_slot_idx/i);
  assert.match(sql, /reservation_id TEXT/i);
});

test("kiosk multi-game migration indexes visit and room schedule lookups", () => {
  assert.match(sql, /customer_visit_games_visit_idx/i);
  assert.match(sql, /customer_visit_games_schedule_idx/i);
  assert.match(sql, /customer_visit_games_expiry_idx/i);
});
