import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("pricing settings migration creates editable defaults", async () => {
  const db = new DatabaseSync(":memory:");
  const migration = await readFile(
    new URL("../drizzle/0014_pricing_settings.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  const row = db.prepare("SELECT * FROM pricing_settings WHERE id = 1").get();
  assert.equal(row.adult_price, 7_000);
  assert.equal(row.youth_price, 5_000);
  assert.equal(row.slush_price, 1_500);
  assert.equal(row.youth_pass_10_price, 45_000);
  assert.equal(row.adult_pass_20_price, 110_000);
  assert.equal(row.naver_deposit_amount, 5_000);
});
