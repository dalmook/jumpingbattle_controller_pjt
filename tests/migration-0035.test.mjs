import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("0035 stores every repeat-game credit allocation and preserves the repair audit", async () => {
  const sql = await readFile(new URL("../drizzle/0035_repeat_pass_purchase_credit.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS pass_purchase_credits/);
  assert.match(sql, /PRIMARY KEY \(order_id, reservation_id\)/);
  assert.match(sql, /UNIQUE \(reservation_id\)/);
  assert.match(sql, /initial_used_uses, credit_amount/);
  assert.match(sql, /status = 'CANCELLED'/);
  assert.match(sql, /잘못 생성된 미결제 다회권 주문 정리/);
  assert.match(sql, /DELETE FROM pass_purchase_credits/);
});
