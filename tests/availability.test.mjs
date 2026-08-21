import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../app/admin/availability.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  calculateNextGameAvailability,
  GAME_MINUTES,
  SLOT_MINUTES,
  START_GRACE_MINUTES,
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const at = (time) => Date.parse(`2026-07-30T${time}:00+09:00`);
const reservation = (time, status = "booked", teamName = "예약팀") => ({
  startsAt: at(time),
  status,
  scheduledTime: time,
  teamName,
});
const calculate = ({
  now,
  gameStartedAt = null,
  controllerRemainingSeconds,
  currentTeamName = "",
  currentReservationStartsAt = null,
  reservations = [],
}) =>
  calculateNextGameAvailability({
    now,
    gameStartedAt,
    controllerRemainingSeconds,
    currentTeamName,
    currentReservationStartsAt,
    reservations,
  });

test("설정값은 20분 슬롯, 16분 게임, 5분 경계로 분리되어 있다", () => {
  assert.equal(SLOT_MINUTES, 20);
  assert.equal(GAME_MINUTES, 16);
  assert.equal(START_GRACE_MINUTES, 5);
});

test("현재 게임 없음, 4분 이내, 다음 예약 있음: 지금 이용 가능", () => {
  const now = Date.parse("2026-07-30T12:04:59+09:00");
  const result = calculate({ now, reservations: [reservation("12:20")] });

  assert.equal(result.availableAt, now);
  assert.equal(result.availableSeconds, 0);
  assert.equal(result.basis, "available");
});

test("현재 게임 없음, 5분 이상, 다음 예약 있음: 다음 예약 시각 + 20분", () => {
  const now = at("12:05");
  const result = calculate({ now, reservations: [reservation("12:20")] });

  assert.equal(result.availableAt, at("12:40"));
  assert.equal(result.availableSeconds, 35 * 60);
  assert.equal(result.basis, "schedule");
});

test("현재 게임 없음, 5분 이상, 다음 예약 없음: 지금 이용 가능", () => {
  const now = at("12:08");
  const result = calculate({ now });

  assert.equal(result.availableAt, now);
  assert.equal(result.availableSeconds, 0);
  assert.equal(result.basis, "available");
});

test("현재 게임 없음, 현재와 다음 시간대 예약 있음: 두 예약 뒤 이용 가능", () => {
  const now = Date.parse("2026-07-30T12:42:00+09:00");
  const result = calculate({
    now,
    reservations: [reservation("12:40"), reservation("13:00")],
  });

  assert.equal(result.availableAt, at("13:20"));
  assert.equal(result.availableSeconds, 38 * 60);
  assert.equal(result.queuedReservations, 2);
  assert.equal(result.nextReservationTime, "12:40");
  assert.equal(result.basis, "schedule");
});

test("현재 게임 진행 중, 다음 예약 없음: 실제 시작 + 16분", () => {
  const now = at("12:05");
  const result = calculate({ now, gameStartedAt: at("12:00") });

  assert.equal(result.availableAt, at("12:16"));
  assert.equal(result.availableSeconds, 11 * 60);
  assert.equal(result.basis, "controller");
});

test("현재 게임 진행 중, 바로 다음 예약 있음: 실제 시작 + 32분", () => {
  const now = at("12:05");
  const result = calculate({
    now,
    gameStartedAt: at("12:00"),
    reservations: [reservation("12:20")],
  });

  assert.equal(result.availableAt, at("12:32"));
  assert.equal(result.availableSeconds, 27 * 60);
  assert.equal(result.queuedReservations, 1);
});

test("현재 게임 뒤 연속 예약은 마지막 예약 게임까지 모두 계산한다", () => {
  const now = at("20:05");
  const result = calculate({
    now,
    gameStartedAt: at("20:00"),
    controllerRemainingSeconds: 14 * 60 + 38,
    reservations: [
      reservation("20:20"),
      reservation("20:40"),
      reservation("21:00"),
    ],
  });

  assert.equal(result.availableAt, at("21:07") + 38_000);
  assert.equal(result.availableSeconds, 62 * 60 + 38);
  assert.equal(result.queuedReservations, 3);
  assert.equal(result.nextReservationTime, "20:20");
  assert.equal(result.basis, "controller");
});

test("같은 시간대의 중복 예약은 한 게임으로 계산한다", () => {
  const now = at("20:05");
  const result = calculate({
    now,
    gameStartedAt: at("20:00"),
    controllerRemainingSeconds: 15 * 60,
    reservations: [
      reservation("20:20", "booked", "첫 팀"),
      reservation("20:20", "booked", "두 번째 팀"),
      reservation("20:40", "booked", "세 번째 팀"),
    ],
  });

  assert.equal(result.availableAt, at("20:52"));
  assert.equal(result.queuedReservations, 2);
});

test("예약 전 한 게임을 온전히 할 수 있는 빈 시간에서 연쇄 계산을 멈춘다", () => {
  const now = at("20:05");
  const result = calculate({
    now,
    gameStartedAt: at("20:00"),
    controllerRemainingSeconds: 5 * 60,
    reservations: [reservation("20:40")],
  });

  assert.equal(result.availableAt, at("20:10"));
  assert.equal(result.queuedReservations, 0);
});

test("게임이 없어도 바로 다음부터 이어진 예약 시간대를 모두 계산한다", () => {
  const now = at("20:05");
  const result = calculate({
    now,
    reservations: [
      reservation("20:20"),
      reservation("20:40"),
      reservation("21:00"),
    ],
  });

  assert.equal(result.availableAt, at("21:20"));
  assert.equal(result.queuedReservations, 3);
  assert.equal(result.nextReservationTime, "20:20");
  assert.equal(result.basis, "schedule");
});

test("컨트롤러 잔여시간이 0이고 다음 예약이 없으면 현재 시각부터 이용 가능", () => {
  const now = at("11:43");
  const result = calculate({
    now,
    gameStartedAt: at("11:27"),
    controllerRemainingSeconds: 0,
    currentTeamName: "시준이네",
    currentReservationStartsAt: at("12:00"),
    reservations: [reservation("11:40", "arrived", "시준이네")],
  });

  assert.equal(result.availableAt, now);
  assert.equal(result.availableSeconds, 0);
  assert.equal(result.queuedReservations, 0);
  assert.equal(result.basis, "available");
});

test("컨트롤러 잔여시간이 있으면 저장된 시작시각보다 실제 잔여시간을 우선한다", () => {
  const now = at("12:04");
  const result = calculate({
    now,
    gameStartedAt: at("11:40"),
    controllerRemainingSeconds: 13 * 60,
    currentTeamName: "현재팀",
    currentReservationStartsAt: at("12:20"),
    reservations: [reservation("12:20", "booked", "현재팀")],
  });

  assert.equal(result.availableAt, at("12:17"));
  assert.equal(result.availableSeconds, 13 * 60);
  assert.equal(result.queuedReservations, 0);
  assert.equal(result.basis, "controller");
});

test("3분 경계로 넘어간 같은 팀 예약칸은 진행 중 게임으로 보고 다시 더하지 않는다", () => {
  const now = at("12:04");
  const result = calculate({
    now,
    gameStartedAt: at("12:01"),
    currentTeamName: "현재팀",
    currentReservationStartsAt: at("12:20"),
    reservations: [reservation("12:20", "booked", "현재팀")],
  });

  assert.equal(result.availableAt, at("12:17"));
  assert.equal(result.availableSeconds, 13 * 60);
  assert.equal(result.queuedReservations, 0);
});

test("3분 경계 이후라도 다른 팀의 다음 예약은 대기시간에 포함한다", () => {
  const now = at("12:04");
  const result = calculate({
    now,
    gameStartedAt: at("12:01"),
    currentTeamName: "현재팀",
    currentReservationStartsAt: at("12:20"),
    reservations: [reservation("12:20", "booked", "다음팀")],
  });

  assert.equal(result.availableAt, at("12:33"));
  assert.equal(result.queuedReservations, 1);
});

test("취소된 다음 예약은 계산에서 제외", () => {
  const now = at("12:05");
  const result = calculate({
    now,
    reservations: [reservation("12:20", "cancelled")],
  });

  assert.equal(result.availableAt, now);
  assert.equal(result.queuedReservations, 0);
  assert.equal(result.nextReservationTime, "");
});

test("노쇼 및 삭제 예약은 계산에서 제외", () => {
  const now = at("12:05");
  for (const status of ["no_show", "no-show", "noshow", "deleted"]) {
    const result = calculate({
      now,
      reservations: [reservation("12:20", status)],
    });
    assert.equal(result.availableAt, now, status);
  }
});

test("자정을 넘는 바로 다음 예약도 timestamp로 계산", () => {
  const now = Date.parse("2026-07-30T23:45:00+09:00");
  const nextReservation = {
    startsAt: Date.parse("2026-07-31T00:00:00+09:00"),
    status: "booked",
    scheduledTime: "00:00",
  };
  const result = calculate({ now, reservations: [nextReservation] });

  assert.equal(
    result.availableAt,
    Date.parse("2026-07-31T00:20:00+09:00"),
  );
});
