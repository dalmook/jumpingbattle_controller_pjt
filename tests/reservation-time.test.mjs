import assert from "node:assert/strict";
import test from "node:test";
import { nextBookableTime } from "../app/reservation-config.ts";

function at(time) {
  return new Date(`2026-08-02T${time}:00+09:00`);
}

test("customer reservations stay in the current slot through minute 3", () => {
  assert.equal(nextBookableTime(at("12:00")), "12:00");
  assert.equal(nextBookableTime(at("12:03")), "12:00");
});

test("customer reservations move to the next slot from minute 4", () => {
  assert.equal(nextBookableTime(at("12:04")), "12:20");
  assert.equal(nextBookableTime(at("12:19")), "12:20");
  assert.equal(nextBookableTime(at("12:20")), "12:20");
});
