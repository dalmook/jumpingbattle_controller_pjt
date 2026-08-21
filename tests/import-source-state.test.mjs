import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyImportedSourceState,
  resolveImportedOperationalState,
} from "../app/api/import/reservations/source-state.ts";

test("Naver completed status is kept as completed", () => {
  assert.equal(classifyImportedSourceState("이용완료"), "completed");
  assert.equal(classifyImportedSourceState("COMPLETED"), "completed");
});

test("cancellation and active statuses remain distinct", () => {
  assert.equal(classifyImportedSourceState("취소"), "cancelled");
  assert.equal(classifyImportedSourceState("예약취소"), "cancelled");
  assert.equal(classifyImportedSourceState("환불완료"), "cancelled");
  assert.equal(classifyImportedSourceState("확정"), "booked");
});

test("mixed Naver action labels do not cancel a completed reservation", () => {
  assert.equal(classifyImportedSourceState("이용완료 취소"), "completed");
  assert.equal(classifyImportedSourceState("사용완료 / 취소"), "completed");
});

test("Naver completion does not finish store operations", () => {
  assert.equal(
    resolveImportedOperationalState("completed", null, false),
    "booked",
  );
  assert.equal(
    resolveImportedOperationalState("completed", "booked", false),
    "booked",
  );
  assert.equal(
    resolveImportedOperationalState("completed", "arrived", false),
    "arrived",
  );
  assert.equal(
    resolveImportedOperationalState("completed", "completed", true),
    "completed",
  );
});

test("Naver cancellation always cancels store operations", () => {
  for (const current of ["booked", "arrived", "completed", "cancelled"]) {
    for (const locallyCompleted of [false, true]) {
      assert.equal(
        resolveImportedOperationalState("cancelled", current, locallyCompleted),
        "cancelled",
      );
    }
  }
});
