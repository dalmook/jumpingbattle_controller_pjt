import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("오늘 음료 카드 12개를 기타 카드로 한 번 분리한다", async () => {
  const migration = await readFile(
    new URL("../drizzle/0006_outgoing_the_watchers.sql", import.meta.url),
    "utf8",
  );
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE daily_shared_sales (
      sales_date TEXT PRIMARY KEY,
      beverage_card_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO daily_shared_sales (sales_date, beverage_card_count)
    VALUES ('2026-07-30', 20);
  `);

  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  const row = db
    .prepare(`
      SELECT beverage_card_count, other_card_count
      FROM daily_shared_sales WHERE sales_date = '2026-07-30'
    `)
    .get();
  assert.equal(row.beverage_card_count, 8);
  assert.equal(row.other_card_count, 12);
});
