import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("0027 creates member coupons and converts legacy coupon balances", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE payment_attempts (id TEXT PRIMARY KEY);
    CREATE TABLE legacy_migration_backups (id TEXT PRIMARY KEY);
    CREATE TABLE member_passes (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL, product_code TEXT NOT NULL,
      remaining_uses INTEGER NOT NULL, purchased_at TEXT NOT NULL, expires_at TEXT,
      status TEXT NOT NULL, source_reference TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO member_passes VALUES
      ('weekday', 'member-1', 'LEGACY_WEEKDAY', 2, datetime('now','-10 days'), datetime('now','+10 days'), 'ACTIVE', 'legacy:weekday', CURRENT_TIMESTAMP),
      ('stamp', 'member-1', 'LEGACY_STAMP_REWARD', 1, datetime('now','-2 months'), NULL, 'ACTIVE', 'legacy:stamp', CURRENT_TIMESTAMP),
      ('adult', 'member-1', 'ADULT_PASS_10', 7, CURRENT_TIMESTAMP, NULL, 'ACTIVE', 'legacy:adult', CURRENT_TIMESTAMP);
  `);
  const migration = await readFile(new URL("../drizzle/0027_member_coupons.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  const coupons = db.prepare(`SELECT coupon_type, status, COUNT(*) AS count FROM member_coupons GROUP BY coupon_type, status ORDER BY coupon_type, status`).all().map((row) => ({ ...row }));
  assert.deepEqual(coupons, [
    { coupon_type: "STAMP_REWARD", status: "EXPIRED", count: 1 },
    { coupon_type: "WEEKDAY_EVENT", status: "ACTIVE", count: 2 },
  ]);
  assert.deepEqual(db.prepare(`SELECT id, remaining_uses, status FROM member_passes ORDER BY id`).all().map((row) => ({ ...row })), [
    { id: "adult", remaining_uses: 7, status: "ACTIVE" },
    { id: "stamp", remaining_uses: 0, status: "MIGRATED_COUPON" },
    { id: "weekday", remaining_uses: 0, status: "MIGRATED_COUPON" },
  ]);
  assert.ok(db.prepare(`PRAGMA table_info(payment_attempts)`).all().some((column) => column.name === "member_coupon_id"));
  assert.ok(db.prepare(`PRAGMA table_info(legacy_migration_backups)`).all().some((column) => column.name === "member_coupons_json"));
});
