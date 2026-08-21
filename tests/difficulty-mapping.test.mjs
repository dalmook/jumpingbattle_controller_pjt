import assert from "node:assert/strict";
import test from "node:test";
import {
  getDifficulty,
  resolveReservationDifficultyCode,
} from "../app/reservation-config.ts";

test("Naver difficulty descriptions map their English name to the correct game", () => {
  assert.equal(getDifficulty("Summer (15분 22단계) - new")?.code, "summer");
  assert.equal(getDifficulty("Basic (15분 16단계)")?.code, "basic");
  assert.equal(getDifficulty("HARD (15분 18단계)")?.code, "hard");
});

test("the booking editor falls back to the imported label for existing records", () => {
  assert.equal(
    resolveReservationDifficultyCode("", "Summer (15분 22단계) - new", "C2"),
    "summer",
  );
  assert.equal(
    resolveReservationDifficultyCode("", "b1-medium-summer (15분)", "B1"),
    "b1-medium-summer",
  );
});
