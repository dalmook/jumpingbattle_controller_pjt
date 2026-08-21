import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(
  new URL("../drizzle/0009_closed_spectrum.sql", import.meta.url),
  "utf8",
);

test("다회권 판매 수량 열을 기존 공용 부가매출 기록을 보존하며 추가한다", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE daily_shared_sales (
      sales_date TEXT PRIMARY KEY,
      other_card_count INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO daily_shared_sales (sales_date, other_card_count)
    VALUES ('2026-08-01', 3);
  `);

  database.exec(migration.replaceAll("--> statement-breakpoint", ""));
  const row = database
    .prepare(`
      SELECT other_card_count, youth_pass_10_card_count,
        youth_pass_20_account_count, adult_pass_10_cash_count,
        adult_pass_20_account_count
      FROM daily_shared_sales WHERE sales_date = '2026-08-01'
    `)
    .get();

  assert.equal(row.other_card_count, 3);
  assert.equal(row.youth_pass_10_card_count, 0);
  assert.equal(row.youth_pass_20_account_count, 0);
  assert.equal(row.adult_pass_10_cash_count, 0);
  assert.equal(row.adult_pass_20_account_count, 0);
  database.close();
});
