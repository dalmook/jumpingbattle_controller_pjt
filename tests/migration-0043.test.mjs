import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sql = fs.readFileSync(new URL("../drizzle/0043_kiosk_draft_revision.sql", import.meta.url), "utf8");

test("kiosk draft revision migration protects write-behind ordering", () => {
  assert.match(sql, /ALTER TABLE customer_visits ADD COLUMN client_revision INTEGER NOT NULL DEFAULT 0/i);
});
