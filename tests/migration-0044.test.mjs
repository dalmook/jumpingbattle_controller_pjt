import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sql = fs.readFileSync(
  new URL("../drizzle/0044_bridge_control_reliability.sql", import.meta.url),
  "utf8",
);

test("bridge reliability migration separates online, control and freshness state", () => {
  assert.match(sql, /ADD COLUMN bridge_instance_id TEXT NOT NULL DEFAULT ''/i);
  assert.match(sql, /ADD COLUMN control_state TEXT NOT NULL DEFAULT 'IDLE'/i);
  assert.match(sql, /ADD COLUMN current_control_action TEXT NOT NULL DEFAULT ''/i);
  assert.match(sql, /ADD COLUMN state_stale INTEGER NOT NULL DEFAULT 0/i);
});
