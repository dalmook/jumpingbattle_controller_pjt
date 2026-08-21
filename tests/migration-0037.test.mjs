import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("0037 reverses stamps earned before a direct pass use was recorded", async () => {
  const sql = await readFile(new URL("../drizzle/0037_cancel_pass_use_stamps.sql", import.meta.url), "utf8");
  assert.match(sql, /INSERT OR IGNORE INTO stamp_ledger/);
  assert.match(sql, /used\.source = 'POS'/);
  assert.match(sql, /restored\.type = 'RESTORE'/);
  assert.match(sql, /'stamp-cancel:pass-use:' \|\| earned\.reservation_id/);
  assert.match(sql, /-ABS\(earned\.amount\)/);
});
