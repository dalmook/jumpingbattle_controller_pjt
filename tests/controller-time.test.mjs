import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../app/admin/controller-time.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  ROOM_SYNC_STALE_AFTER_MS,
  correctedRemainingSeconds,
  isRoomSampleFresh,
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const runningRoom = (remainingSeconds, updatedAt) => ({
  status: "running",
  remainingSeconds,
  updatedAt,
});

test("게임을 시작하지 않은 방의 남은시간은 항상 00:00 기준이다", () => {
  const observedAt = "2026-08-01T04:48:00.000Z";
  const waitingRoom = {
    status: "waiting",
    remainingSeconds: 55,
    updatedAt: observedAt,
  };

  assert.equal(
    correctedRemainingSeconds(waitingRoom, Date.parse(observedAt) + 2_000),
    0,
  );
});

test("마지막 측정 뒤 흐른 초만큼 컨트롤러 잔여시간을 보정한다", () => {
  const observedAt = "2026-08-01T04:48:00.000Z";
  const room = runningRoom(55, observedAt);

  assert.equal(
    correctedRemainingSeconds(room, Date.parse(observedAt) + 2_900),
    53,
  );
});

test("1초 미만의 전송 지연은 잔여시간에서 미리 빼지 않는다", () => {
  const observedAt = "2026-08-01T04:48:00.000Z";
  const room = runningRoom(55, observedAt);

  assert.equal(
    correctedRemainingSeconds(room, Date.parse(observedAt) + 999),
    55,
  );
});

test("보정 잔여시간은 0 아래로 내려가지 않는다", () => {
  const observedAt = "2026-08-01T04:48:00.000Z";
  const room = runningRoom(2, observedAt);

  assert.equal(
    correctedRemainingSeconds(room, Date.parse(observedAt) + 8_000),
    0,
  );
});

test("5초를 넘긴 상태값은 동기화 지연으로 판단한다", () => {
  const observedAt = "2026-08-01T04:48:00.000Z";
  const room = runningRoom(55, observedAt);

  assert.equal(
    isRoomSampleFresh(room, Date.parse(observedAt) + ROOM_SYNC_STALE_AFTER_MS),
    true,
  );
  assert.equal(
    isRoomSampleFresh(room, Date.parse(observedAt) + ROOM_SYNC_STALE_AFTER_MS + 1),
    false,
  );
});
