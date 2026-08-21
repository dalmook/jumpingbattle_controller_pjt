import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateControlReadiness,
  evaluateRoomCommandReadiness,
  normalizeControlTimestamp,
  resolveRoomControlEventTimestamp,
} from "../db/control-readiness.ts";

const healthy = {
  bridgeOnline: true,
  armed: true,
  controlState: "IDLE",
  controlLoopAlive: true,
  managerProbeFresh: true,
  managerState: "AVAILABLE",
  managerModalActive: false,
  stateStale: false,
};

test("global readiness distinguishes bridge, control and manager failures", () => {
  assert.equal(evaluateControlReadiness(healthy).ready, true);
  assert.equal(evaluateControlReadiness({ ...healthy, bridgeOnline: false }).reasonCode, "BRIDGE_OFFLINE");
  assert.equal(evaluateControlReadiness({ ...healthy, controlState: "ERROR" }).reasonCode, "CONTROL_ERROR");
  assert.equal(evaluateControlReadiness({ ...healthy, managerState: "STALE" }).reasonCode, "MANAGER_STALE");
  assert.equal(evaluateControlReadiness({ ...healthy, managerProbeFresh: false }).reasonCode, "MANAGER_STALE");
  assert.equal(evaluateControlReadiness({ ...healthy, managerModalActive: true }).reasonCode, "MANAGER_MODAL_ACTIVE");
});

test("a room failure degrades globally without blocking other rooms", () => {
  const degraded = evaluateControlReadiness({ ...healthy, controlState: "DEGRADED" });
  assert.equal(degraded.ready, true);
  assert.equal(evaluateRoomCommandReadiness(degraded, {
    roomControlState: "READY",
    requestedAction: "start",
  }).ready, true);
});

test("set_info failure allows an explicit retry but blocks start and stop", () => {
  const readiness = evaluateControlReadiness({ ...healthy, controlState: "DEGRADED" });
  assert.equal(evaluateRoomCommandReadiness(readiness, {
    roomControlState: "SET_INFO_FAILED",
    lastAction: "set_info",
    requestedAction: "set_info",
  }).ready, true);
  assert.equal(evaluateRoomCommandReadiness(readiness, {
    roomControlState: "SET_INFO_FAILED",
    lastAction: "set_info",
    requestedAction: "start",
  }).reasonCode, "ROOM_SET_INFO_REQUIRED");
  assert.equal(evaluateRoomCommandReadiness(readiness, {
    roomControlState: "CONTROL_PENDING",
    currentCommandId: "command-1",
    requestedAction: "set_info",
  }).reasonCode, "ROOM_CONTROL_PENDING");
});

test("a generic room failure allows only the failed action to be retried", () => {
  const readiness = evaluateControlReadiness({ ...healthy, controlState: "DEGRADED" });
  assert.equal(evaluateRoomCommandReadiness(readiness, {
    roomControlState: "CONTROL_FAILED",
    lastAction: "stop",
    requestedAction: "stop",
  }).ready, true);
  assert.equal(evaluateRoomCommandReadiness(readiness, {
    roomControlState: "CONTROL_FAILED",
    lastAction: "stop",
    requestedAction: "start",
  }).reasonCode, "ROOM_CONTROL_RETRY_REQUIRED");
  assert.equal(evaluateRoomCommandReadiness(readiness, {
    roomControlState: "CONTROL_FAILED",
    requestedAction: "stop",
  }).ready, false);
});

test("global ERROR remains blocked even when a room itself is ready", () => {
  const error = evaluateControlReadiness({ ...healthy, controlState: "ERROR" });
  const room = evaluateRoomCommandReadiness(error, {
    roomControlState: "READY",
    requestedAction: "set_info",
  });
  assert.equal(room.ready, false);
  assert.equal(room.reasonCode, "CONTROL_ERROR");
});

test("control timestamps are normalized to lexicographically ordered ISO UTC", () => {
  const older = normalizeControlTimestamp("2026-08-19T18:10:00+09:00");
  const newer = normalizeControlTimestamp("2026-08-19T18:10:00.250+09:00");
  assert.equal(older, "2026-08-19T09:10:00.000Z");
  assert.equal(newer, "2026-08-19T09:10:00.250Z");
  assert.ok(older < newer);
  assert.equal(normalizeControlTimestamp("not-a-date"), null);
});

test("a READY heartbeat without updatedAt cannot erase a pending or failed state", () => {
  assert.equal(resolveRoomControlEventTimestamp({
    state: "READY",
    occurredAt: "2026-08-19T18:10:01+09:00",
    nowIso: "2026-08-19T09:10:02.000Z",
  }), null);
  assert.equal(resolveRoomControlEventTimestamp({
    state: "READY",
    updatedAt: "2026-08-19T18:10:01+09:00",
    nowIso: "2026-08-19T09:10:02.000Z",
  }), "2026-08-19T09:10:01.000Z");
  assert.equal(resolveRoomControlEventTimestamp({
    state: "SET_INFO_FAILED",
    occurredAt: "2026-08-19T18:10:01+09:00",
    nowIso: "2026-08-19T09:10:02.000Z",
  }), "2026-08-19T09:10:01.000Z");
});
