import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("0032 creates customer credentials, sessions, and login throttling", async () => {
  const db = new DatabaseSync(":memory:");
  const migration = await readFile(
    new URL("../drizzle/0032_customer_member_accounts.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  assert.ok(tables.some((table) => table.name === "member_credentials"));
  assert.ok(tables.some((table) => table.name === "member_sessions"));
  assert.ok(tables.some((table) => table.name === "member_auth_rate_limits"));

  db.prepare(`INSERT INTO member_credentials (
      member_id, password_hash, password_salt, password_iterations, terms_version
    ) VALUES (?, ?, ?, ?, ?)`)
    .run("member-1", "hash", "salt", 210000, "2026-08-12");
  assert.throws(() => db.prepare(`INSERT INTO member_credentials (
      member_id, password_hash, password_salt, password_iterations, terms_version
    ) VALUES (?, ?, ?, ?, ?)`)
    .run("member-1", "hash-2", "salt-2", 210000, "2026-08-12"));

  db.prepare(`INSERT INTO member_sessions (id, member_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)`)
    .run("session-1", "member-1", "token-hash", "2099-01-01T00:00:00.000Z");
  assert.throws(() => db.prepare(`INSERT INTO member_sessions (id, member_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)`)
    .run("session-2", "member-1", "token-hash", "2099-01-01T00:00:00.000Z"));

  const indexes = db.prepare("PRAGMA index_list(member_sessions)").all();
  assert.ok(indexes.some((index) => index.name === "member_sessions_member_expires_idx"));
});
