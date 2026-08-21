import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const sql = await readFile(
  new URL("../drizzle/0051_set_info_control_recovery.sql", import.meta.url),
  "utf8",
);
const controlSource = await readFile(
  new URL("../db/control.ts", import.meta.url),
  "utf8",
);

const migrationStatements = sql
  .split(/\s*--> statement-breakpoint\s*/u)
  .map((statement) => statement.trim())
  .filter(Boolean);

test("set_info recovery migration separates manager and room control runtime", () => {
  assert.match(sql, /ADD COLUMN manager_state TEXT NOT NULL DEFAULT 'UNAVAILABLE'/i);
  assert.match(sql, /ADD COLUMN manager_probe_at TEXT/i);
  assert.match(sql, /ADD COLUMN manager_probe_success_count INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /ADD COLUMN control_loop_last_seen TEXT/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS room_control_runtime/i);
  assert.match(sql, /control_state TEXT NOT NULL DEFAULT 'READY'/i);
  assert.match(sql, /current_command_id TEXT NOT NULL DEFAULT ''/i);
  assert.match(sql, /last_error_code TEXT NOT NULL DEFAULT ''/i);
  assert.match(sql, /observed_at TEXT/i);
  assert.match(sql, /INSERT OR IGNORE INTO room_control_runtime/i);
  assert.doesNotMatch(sql, /CREATE TRIGGER/i);
  assert.equal(migrationStatements.length, 7);
});

test("runtime schema bootstrap installs atomic control guards before command handling", () => {
  assert.match(controlSource, /CREATE TRIGGER IF NOT EXISTS commands_control_active_insert_guard/i);
  assert.match(controlSource, /CREATE TRIGGER IF NOT EXISTS commands_control_active_update_guard/i);
  assert.match(controlSource, /CREATE TRIGGER IF NOT EXISTS commands_control_pending_runtime_insert/i);
  assert.match(controlSource, /CREATE TRIGGER IF NOT EXISTS commands_control_pending_runtime_update/i);
  assert.match(controlSource, /RAISE\(ABORT, 'CONTROL_ROOM_BUSY'\)/i);
  assert.match(controlSource, /export async function assertControlCommandReady[\s\S]*?await getControlCommandReadiness/i);
});

function databaseWithMigration() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agent_runtime (agent_id TEXT PRIMARY KEY);
    CREATE TABLE rooms (room_id TEXT PRIMARY KEY);
    INSERT INTO rooms (room_id) VALUES ('0'), ('1'), ('2'), ('3');
    CREATE TABLE commands (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT NOT NULL DEFAULT 'test',
      target_agent_id TEXT NOT NULL DEFAULT 'test',
      result TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL DEFAULT '2099-01-01T00:00:00.000Z',
      claimed_at TEXT,
      completed_at TEXT
    );
  `);
  for (const statement of migrationStatements) {
    db.exec(statement);
  }
  const triggerSource = controlSource.match(
    /CREATE TRIGGER IF NOT EXISTS commands_control_active_insert_guard[\s\S]*?END\s*`\),[\s\S]*?CREATE TRIGGER IF NOT EXISTS commands_control_pending_runtime_insert[\s\S]*?END\s*`\),[\s\S]*?CREATE TRIGGER IF NOT EXISTS commands_control_active_update_guard[\s\S]*?END\s*`\),[\s\S]*?CREATE TRIGGER IF NOT EXISTS commands_control_pending_runtime_update[\s\S]*?END\s*`\),/i,
  )?.[0];
  assert.ok(triggerSource);
  const triggerStatements = [...triggerSource.matchAll(/CREATE TRIGGER IF NOT EXISTS[\s\S]*?\n\s*END(?=\s*`\),)/gi)]
    .map((match) => match[0]);
  assert.equal(triggerStatements.length, 4);
  for (const statement of triggerStatements) {
    db.exec(statement);
  }
  return db;
}

function insertCommand(db, id, roomId, action = "set_info", status = "pending") {
  db.prepare(`INSERT INTO commands (id, room_id, action, status)
    VALUES (?, ?, ?, ?)`).run(id, roomId, action, status);
}

test("active control trigger atomically rejects same-room duplicates but permits another room", () => {
  const db = databaseWithMigration();
  insertCommand(db, "first", "0");
  assert.throws(() => insertCommand(db, "same-room", "0", "start"), /CONTROL_ROOM_BUSY/);
  assert.doesNotThrow(() => insertCommand(db, "other-room", "1", "start"));
  db.prepare(`UPDATE commands SET status = 'completed' WHERE id = 'first'`).run();
  assert.doesNotThrow(() => insertCommand(db, "room-released", "0", "stop"));
  db.close();
});

test("control insert atomically marks the target room pending in the same SQLite statement", () => {
  const db = databaseWithMigration();
  insertCommand(db, "pending-room", "0", "set_info");
  const runtime = db.prepare(`SELECT control_state, current_action, current_command_id,
      state_seen_at, observed_at FROM room_control_runtime WHERE room_id = '0'`).get();
  assert.equal(runtime.control_state, "CONTROL_PENDING");
  assert.equal(runtime.current_action, "set_info");
  assert.equal(runtime.current_command_id, "pending-room");
  assert.match(runtime.state_seen_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(runtime.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  db.close();
});

test("ALL insert atomically marks every room pending", () => {
  const db = databaseWithMigration();
  insertCommand(db, "pending-all", "ALL", "all_stop");
  const rooms = db.prepare(`SELECT room_id, control_state, current_command_id
    FROM room_control_runtime ORDER BY room_id`).all();
  assert.equal(rooms.length, 4);
  assert.ok(rooms.every((room) => room.control_state === "CONTROL_PENDING"));
  assert.ok(rooms.every((room) => room.current_command_id === "pending-all"));
  db.close();
});

test("ALL and room-specific active control commands conflict in both directions", () => {
  const roomFirst = databaseWithMigration();
  insertCommand(roomFirst, "room-first", "2");
  assert.throws(() => insertCommand(roomFirst, "all-after-room", "ALL", "all_stop"), /CONTROL_ROOM_BUSY/);
  roomFirst.close();

  const allFirst = databaseWithMigration();
  insertCommand(allFirst, "all-first", "ALL", "all_stop");
  assert.throws(() => insertCommand(allFirst, "room-after-all", "3", "set_info"), /CONTROL_ROOM_BUSY/);
  allFirst.close();
});

test("active control update guard closes prepared-to-pending TOCTOU without affecting payment", () => {
  const db = databaseWithMigration();
  insertCommand(db, "active", "0");
  insertCommand(db, "prepared", "0", "start", "prepared");
  assert.throws(
    () => db.prepare(`UPDATE commands SET status = 'pending' WHERE id = 'prepared'`).run(),
    /CONTROL_ROOM_BUSY/,
  );
  assert.doesNotThrow(() => insertCommand(db, "payment", "0", "payment_pay"));
  db.close();
});

test("prepared control transition marks room pending atomically", () => {
  const db = databaseWithMigration();
  insertCommand(db, "prepared-only", "2", "start", "prepared");
  db.prepare(`UPDATE commands SET status = 'pending' WHERE id = 'prepared-only'`).run();
  const runtime = db.prepare(`SELECT control_state, current_action, current_command_id
    FROM room_control_runtime WHERE room_id = '2'`).get();
  assert.equal(runtime.control_state, "CONTROL_PENDING");
  assert.equal(runtime.current_action, "start");
  assert.equal(runtime.current_command_id, "prepared-only");
  db.close();
});

test("an ambiguous claimed control timeout is failed and never returned to pending", () => {
  const db = databaseWithMigration();
  insertCommand(db, "timed-out", "0", "set_info");
  db.prepare(`UPDATE commands SET status = 'claimed', claimed_at = '2026-08-19 09:00:00'
    WHERE id = 'timed-out'`).run();
  const finalizedAt = "2026-08-19T09:01:00.000Z";
  db.prepare(`UPDATE commands SET status = 'failed', result = 'CONTROL_ACK_TIMEOUT_AMBIGUOUS', completed_at = ?
    WHERE status = 'claimed' AND action IN ('set_info', 'start', 'stop', 'all_stop')
      AND datetime(claimed_at) < datetime(?)`).run(finalizedAt, "2026-08-19T09:00:30.000Z");
  db.prepare(`UPDATE room_control_runtime SET control_state = 'SET_INFO_FAILED', current_command_id = '',
    last_error_code = 'CONTROL_ACK_TIMEOUT_AMBIGUOUS', state_seen_at = ?, observed_at = ?, updated_at = ?
    WHERE current_command_id = 'timed-out'`).run(finalizedAt, finalizedAt, finalizedAt);
  db.prepare(`UPDATE commands SET status = 'pending', claimed_at = NULL
    WHERE status = 'claimed'
      AND action NOT IN ('parking_register', 'set_info', 'start', 'stop', 'all_stop')`).run();
  const command = db.prepare(`SELECT status, result FROM commands WHERE id = 'timed-out'`).get();
  const room = db.prepare(`SELECT control_state, current_command_id, last_error_code
    FROM room_control_runtime WHERE room_id = '0'`).get();
  assert.equal(command.status, "failed");
  assert.equal(command.result, "CONTROL_ACK_TIMEOUT_AMBIGUOUS");
  assert.equal(room.control_state, "SET_INFO_FAILED");
  assert.equal(room.current_command_id, "");
  assert.equal(room.last_error_code, "CONTROL_ACK_TIMEOUT_AMBIGUOUS");
  const lateAck = db.prepare(`UPDATE commands SET status = 'completed'
    WHERE id = 'timed-out' AND status = 'claimed' RETURNING id`).get();
  assert.equal(lateAck, undefined);
  db.close();
});
