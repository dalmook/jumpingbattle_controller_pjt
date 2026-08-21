import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sql = fs.readFileSync(
  new URL("../drizzle/0047_kiosk_visit_cleanup.sql", import.meta.url),
  "utf8",
);

test("kiosk cleanup migration keeps an immutable operator audit trail", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS kiosk_visit_admin_audit/i);
  for (const column of ["visit_id", "reservation_id", "action", "previous_status", "next_status", "reason", "created_by", "created_at"]) {
    assert.match(sql, new RegExp(column, "i"));
  }
  assert.doesNotMatch(sql, /DELETE FROM payments|DELETE FROM reservations|DELETE FROM game_records/i);
});
