import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("kiosk display settings keep administrator editable home copy", async () => {
  const sql = await readFile(new URL("../drizzle/0050_kiosk_display_settings.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS kiosk_display_settings/);
  assert.match(sql, /home_title TEXT NOT NULL/);
  assert.match(sql, /home_subtitle TEXT NOT NULL/);
  assert.match(sql, /INSERT OR IGNORE INTO kiosk_display_settings/);
});
