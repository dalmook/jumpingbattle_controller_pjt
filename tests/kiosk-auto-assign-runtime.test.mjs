import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const FIXED_NOW = new Date("2026-08-19T01:00:00.000Z");
const FIXED_SQL_NOW = "'2026-08-19 01:00:00'";

function boundValue(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

class TestD1Statement {
  constructor(owner, sql, values = []) {
    this.owner = owner;
    this.sql = sql.replace(/\bCURRENT_TIMESTAMP\b/g, FIXED_SQL_NOW);
    this.values = values;
  }

  bind(...values) {
    return new TestD1Statement(this.owner, this.sql, values.map(boundValue));
  }

  async first(column) {
    await this.owner.runHook(this.sql, this.values, "first");
    const row = this.owner.sqlite.prepare(this.sql).get(...this.values) ?? null;
    return column && row ? row[column] ?? null : row;
  }

  async all() {
    await this.owner.runHook(this.sql, this.values, "all");
    const results = this.owner.sqlite.prepare(this.sql).all(...this.values);
    return { success: true, results, meta: { changes: 0 } };
  }

  async run() {
    await this.owner.runHook(this.sql, this.values, "run");
    return this.runSync();
  }

  runSync() {
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(result.changes ?? 0),
        last_row_id: Number(result.lastInsertRowid ?? 0),
      },
    };
  }
}

class TestD1Database {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.beforeExecute = null;
  }

  prepare(sql) {
    return new TestD1Statement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(statement.runSync());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async runHook(sql, values, kind) {
    if (this.beforeExecute) await this.beforeExecute({ sql, values, kind, sqlite: this.sqlite });
  }

  close() {
    this.sqlite.close();
  }
}

function errorCode(reason) {
  return reason instanceof Error ? reason.message : String(reason);
}

test("actual customer-flow auto assignment preserves its core D1 invariants", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW });
  const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = mkdtempSync(path.join(tmpdir(), "jb-kiosk-auto-assign-"));
  cpSync(path.join(sourceRoot, "app"), path.join(root, "app"), { recursive: true });
  cpSync(path.join(sourceRoot, "db"), path.join(root, "db"), { recursive: true });
  symlinkSync(path.join(sourceRoot, "node_modules"), path.join(root, "node_modules"), "junction");
  const cacheDir = path.join(root, ".vite-test-cache");
  const database = new TestD1Database();
  globalThis.__KIOSK_AUTO_ASSIGN_TEST_ENV__ = { DB: database };
  const vite = await createServer({
    configFile: false,
    root,
    appType: "custom",
    cacheDir,
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false },
    resolve: { alias: { "@": root } },
    plugins: [{
      name: "kiosk-test-cloudflare-env",
      enforce: "pre",
      resolveId(id) {
        return id === "cloudflare:workers" ? "\0kiosk-test-cloudflare-env" : null;
      },
      load(id) {
        if (id !== "\0kiosk-test-cloudflare-env") return null;
        return "export const env = globalThis.__KIOSK_AUTO_ASSIGN_TEST_ENV__;";
      },
    }],
  });
  t.after(async () => {
    database.beforeExecute = null;
    await vite.close();
    database.close();
    delete globalThis.__KIOSK_AUTO_ASSIGN_TEST_ENV__;
    rmSync(root, { recursive: true, force: true });
  });

  const service = await vite.ssrLoadModule("/db/customer-flow.ts");
  await service.ensureKioskSchema();

  function resetFixture() {
    database.beforeExecute = null;
    for (const table of [
      "kiosk_guidance_agreements",
      "customer_visit_games",
      "customer_room_holds",
      "customer_visits",
      "reservations",
      "room_game_runtime",
    ]) database.sqlite.exec(`DELETE FROM ${table}`);
    database.sqlite.exec("UPDATE rooms SET status = 'idle', remaining_seconds = 0");
  }

  async function createVisit({ revision = 1, expiresAt = "2026-08-19T01:30:00.000Z" } = {}) {
    const id = crypto.randomUUID();
    const token = `runtime-${crypto.randomUUID()}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const tokenHash = Buffer.from(digest).toString("hex");
    database.sqlite.prepare(`INSERT INTO customer_visits
      (id, session_token_hash, kiosk_id, flow_type, status, adult_count, youth_count, party_count,
       client_revision, expires_at)
      VALUES (?, ?, 'runtime-test', 'WALK_IN', 'DRAFT', 2, 0, 2, ?, ?)`)
      .run(id, tokenHash, revision, expiresAt);
    const required = database.sqlite.prepare(`SELECT id, version FROM kiosk_guidance_items
      WHERE placement = 'REQUIRED_AGREEMENT' AND active = 1 AND required = 1`).all();
    for (const item of required) {
      database.sqlite.prepare(`INSERT INTO kiosk_guidance_agreements
        (id, visit_id, guidance_id, guidance_version, agreed, agreed_at)
        VALUES (?, ?, ?, ?, 1, ${FIXED_SQL_NOW})`)
        .run(crypto.randomUUID(), id, item.id, item.version);
    }
    return { id, token, revision };
  }

  function draft(revision) {
    return { clientRevision: revision, adultCount: 2, youthCount: 0 };
  }

  await t.test("first assignment, append and the ten-game limit execute against SQLite", async () => {
    resetFixture();
    const visit = await createVisit();
    const first = await service.autoAssignKioskSlot(visit.token, {
      roomSize: "SMALL", difficultyCode: "basic", draft: draft(visit.revision),
    });
    assert.equal(first.assigned.sequence, 1);
    assert.equal(first.visit.games.length, 1);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM customer_room_holds WHERE state = 'ACTIVE'").get().count, 1);

    const second = await service.autoAssignKioskSlot(visit.token, {
      roomSize: "SMALL", difficultyCode: "easy", appendGame: true, draft: draft(visit.revision),
    });
    assert.equal(second.assigned.sequence, 2);
    assert.equal(second.visit.games.length, 2);

    for (let sequence = 3; sequence <= 10; sequence += 1) {
      database.sqlite.prepare(`INSERT INTO customer_visit_games
        (id, visit_id, sequence, status, scheduled_date, scheduled_time, room_code, room_size,
         difficulty_code, difficulty_label, map_index, adult_count, youth_count, party_count,
         base_amount, hold_id, active_slot_key, expires_at)
        VALUES (?, ?, ?, 'HOLD', '2026-08-19', '13:00', 'C1', 'SMALL', 'basic', 'Basic', 1,
          2, 0, 2, 14000, ?, NULL, '2026-08-19T01:30:00.000Z')`)
        .run(crypto.randomUUID(), visit.id, sequence, crypto.randomUUID());
    }
    await assert.rejects(
      service.autoAssignKioskSlot(visit.token, {
        roomSize: "SMALL", difficultyCode: "basic", appendGame: true, draft: draft(visit.revision),
      }),
      (reason) => errorCode(reason) === "KIOSK_GAME_COUNT_INVALID",
    );
  });

  await t.test("an existing hold is replaced once and B1 medium mapping remains authoritative", async () => {
    resetFixture();
    const visit = await createVisit();
    await service.autoAssignKioskSlot(visit.token, {
      roomSize: "SMALL", difficultyCode: "basic", draft: draft(visit.revision),
    });
    database.sqlite.exec("UPDATE rooms SET status = 'offline' WHERE room_id = '0'");
    const replaced = await service.autoAssignKioskSlot(visit.token, {
      roomSize: "MEDIUM", difficultyCode: "basic", draft: draft(visit.revision),
    });
    assert.equal(replaced.assigned.roomCode, "B1");
    assert.equal(replaced.assigned.difficulty.code, "b1-medium-basic");
    assert.equal(replaced.assigned.difficulty.mapIndex, 11);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM customer_room_holds WHERE visit_id = ?").get(visit.id).count, 1);
    assert.equal(database.sqlite.prepare("SELECT room_code FROM customer_room_holds WHERE visit_id = ? AND state = 'ACTIVE'").get(visit.id).room_code, "B1");
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM customer_visit_games WHERE visit_id = ? AND status = 'HOLD'").get(visit.id).count, 1);
  });

  await t.test("the exact-slot recheck rejects a reservation inserted after candidate selection", async () => {
    resetFixture();
    const visit = await createVisit();
    let injected = false;
    database.beforeExecute = async ({ sql, values, kind, sqlite }) => {
      if (injected || kind !== "first" || !sql.includes("FROM customer_visits AS visits")) return;
      injected = true;
      sqlite.prepare(`INSERT INTO reservations
        (id, booking_code, scheduled_date, scheduled_time, room_code, status)
        VALUES (?, ?, ?, ?, ?, 'booked')`)
        .run(crypto.randomUUID(), `RUNTIME-${crypto.randomUUID()}`, values[0], values[1], values[2]);
    };
    await assert.rejects(
      service.autoAssignKioskSlot(visit.token, {
        roomSize: "SMALL", difficultyCode: "basic", draft: draft(visit.revision),
      }),
      (reason) => errorCode(reason) === "KIOSK_SLOT_OCCUPIED",
    );
    assert.equal(injected, true);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM customer_room_holds").get().count, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM customer_visit_games").get().count, 0);
  });

  await t.test("newer drafts and expired sessions fail closed without creating a hold", async () => {
    resetFixture();
    const newer = await createVisit({ revision: 2 });
    await assert.rejects(
      service.autoAssignKioskSlot(newer.token, {
        roomSize: "SMALL", difficultyCode: "basic", draft: draft(1),
      }),
      (reason) => errorCode(reason) === "KIOSK_DRAFT_STALE",
    );
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM customer_room_holds").get().count, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM customer_visit_games").get().count, 0);

    resetFixture();
    const expired = await createVisit({ expiresAt: "2026-08-19T00:59:00.000Z" });
    await assert.rejects(
      service.autoAssignKioskSlot(expired.token, {
        roomSize: "SMALL", difficultyCode: "basic", draft: draft(expired.revision),
      }),
      (reason) => errorCode(reason) === "KIOSK_SESSION_EXPIRED",
    );
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM customer_room_holds").get().count, 0);
  });
});
