import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  displayGameLevel,
  isStoppedGameTransition,
  normalizeFinalLevel,
  seoulGameDateTime,
} from "../app/admin/game-history-utils.ts";

test("a running-to-waiting transition closes a game even when the timer resets", () => {
  assert.equal(isStoppedGameTransition("running", "waiting", 0), true);
  assert.equal(isStoppedGameTransition("running", "waiting", 30), true);
  assert.equal(isStoppedGameTransition("running", "waiting", 16 * 60), true);
  assert.equal(isStoppedGameTransition("running", "running", 0), false);
  assert.equal(isStoppedGameTransition("waiting", "waiting", 0), false);
  assert.equal(isStoppedGameTransition("running", "offline", 0), false);
});

test("final level ignores controller placeholder values", () => {
  assert.equal(normalizeFinalLevel("gamestart"), "");
  assert.equal(normalizeFinalLevel("대기"), "");
  assert.equal(normalizeFinalLevel("level-16"), "level-16");
  assert.equal(displayGameLevel("level-16"), "Level 16");
});

test("game timestamps are stored using the Seoul calendar date", () => {
  assert.deepEqual(seoulGameDateTime("2026-08-07T15:31:00.000Z"), {
    date: "2026-08-08",
    time: "00:31",
  });
});

test("game history migration stores score, level, people and payment details", async () => {
  const migration = await readFile(
    new URL("../drizzle/0016_chemical_shadow_king.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE `game_records`/);
  for (const column of [
    "`score`", "`level`", "`adult_count`", "`youth_count`",
    "`deposit_amount`", "`payment_card_amount`", "`payment_cash_amount`",
    "`payment_account_amount`",
  ]) {
    assert.match(migration, new RegExp(column));
  }
  assert.doesNotMatch(migration, /CREATE TABLE `pricing_settings`/);
});

test("game history page provides search, timeline and Excel export", async () => {
  const [dashboard, api, admin, css] = await Promise.all([
    readFile(new URL("../app/admin/game-history/GameHistoryDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/game-history/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/ReservationsAdmin.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /통합 검색/);
  assert.match(dashboard, /성인 \{record\.adultCount\}/);
  assert.match(dashboard, /총 결제금액/);
  assert.match(dashboard, /queryString\(filters, "csv"\)/);
  assert.match(api, /text\/csv; charset=utf-8/);
  assert.match(api, /게임 날짜/);
  assert.match(admin, /\/admin\/game-history/);
  assert.match(css, /\.game-history-timeline/);
});

test("zero-score games are skipped and empty payment values stay finite", async () => {
  const gameHistorySource = await readFile(
    new URL("../db/game-history.ts", import.meta.url),
    "utf8",
  );
  assert.match(gameHistorySource, /if \(score <= 0\) return/);
  assert.match(gameHistorySource, /function finiteNumber\(value: unknown\)/);
  assert.match(gameHistorySource, /const clauses = \["score > 0"/);
  assert.match(
    gameHistorySource,
    /finiteNumber\(reservation\?\.payment_card_amount\)\s*\+/,
  );
});
