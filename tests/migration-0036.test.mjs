import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("0036 removes credit locks left by cancelled pass purchases", async () => {
  const sql = await readFile(new URL("../drizzle/0036_cleanup_cancelled_pass_credits.sql", import.meta.url), "utf8");
  assert.match(sql, /DELETE FROM pass_purchase_credits/);
  assert.match(sql, /SELECT id FROM pass_purchase_orders WHERE status = 'CANCELLED'/);
});
