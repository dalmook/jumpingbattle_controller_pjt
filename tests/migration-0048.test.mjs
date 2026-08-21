import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sql = fs.readFileSync(new URL("../drizzle/0048_kiosk_operating_flow.sql", import.meta.url), "utf8");

test("kiosk operating flow migration records versioned required agreements", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS kiosk_guidance_agreements/i);
  assert.match(sql, /UNIQUE\s*\(visit_id,\s*guidance_id,\s*guidance_version\)/i);
  for (const column of ["title", "summary", "agreement_text", "required", "version"]) {
    assert.match(sql, new RegExp(`ALTER TABLE kiosk_guidance_items ADD COLUMN ${column}`, "i"));
  }
});

test("kiosk operating flow migration seeds editable room recommendation rules", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS kiosk_room_recommendation_rules/i);
  assert.match(sql, /primary_size/i);
  assert.match(sql, /secondary_size/i);
  assert.match(sql, /default-small-1-4/i);
  assert.match(sql, /default-medium-5-6/i);
  assert.match(sql, /default-large-7-10/i);
});
