import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

async function executeMigration(db, name) {
  const migration = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

test("0022 adds ledger-based stamps, passes and payment links", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE payments (id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE);
    CREATE TABLE payment_attempts (id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL);
  `);
  await executeMigration(db, "0022_member_benefits.sql");
  const paymentColumns = db.prepare(`PRAGMA table_info(payments)`).all().map((row) => row.name);
  assert.ok(paymentColumns.includes("payment_type"));
  assert.ok(paymentColumns.includes("member_id"));
  assert.ok(paymentColumns.includes("member_pass_id"));

  db.prepare(`INSERT INTO stamp_ledger (id, member_id, type, amount, reference_key) VALUES ('s1','m1','MIGRATION',7,'legacy:m1:stamp')`).run();
  assert.equal(db.prepare(`SELECT SUM(amount) AS balance FROM stamp_ledger WHERE member_id='m1'`).get().balance, 7);
  assert.throws(() => db.prepare(`INSERT INTO stamp_ledger (id, member_id, type, amount, reference_key) VALUES ('s2','m1','MIGRATION',7,'legacy:m1:stamp')`).run(), /UNIQUE constraint failed/);

  db.prepare(`INSERT INTO member_passes (id, member_id, product_code, product_name_at_purchase, purchased_uses, remaining_uses, source_reference) VALUES ('p1','m1','YOUTH_PASS_10','청소년 10회권',10,10,'legacy:m1:p1')`).run();
  db.prepare(`INSERT INTO pass_ledger (id, member_pass_id, member_id, type, uses, reference_key) VALUES ('l1','p1','m1','MIGRATION',10,'legacy-pass:m1:p1')`).run();
  db.prepare(`UPDATE member_passes SET remaining_uses = remaining_uses - 1 WHERE id='p1'`).run();
  db.prepare(`INSERT INTO pass_ledger (id, member_pass_id, member_id, type, uses, reference_key) VALUES ('l2','p1','m1','USE',-1,'use:r1')`).run();
  db.prepare(`UPDATE member_passes SET remaining_uses = remaining_uses + 1 WHERE id='p1'`).run();
  db.prepare(`INSERT INTO pass_ledger (id, member_pass_id, member_id, type, uses, reference_id, reference_key) VALUES ('l3','p1','m1','RESTORE',1,'l2','restore:l2')`).run();
  assert.equal(db.prepare(`SELECT remaining_uses FROM member_passes WHERE id='p1'`).get().remaining_uses, 10);
  assert.equal(db.prepare(`SELECT SUM(uses) AS uses FROM pass_ledger WHERE member_pass_id='p1'`).get().uses, 10);
});
