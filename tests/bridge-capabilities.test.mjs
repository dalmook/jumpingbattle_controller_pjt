import assert from "node:assert/strict";
import test from "node:test";
import {
  supportsControlFastLane,
  supportsPaymentCommands,
  supportsPaymentFastLane,
  supportsParkingCommands,
} from "../db/bridge-capabilities.ts";

test("only payment-capable bridges can receive MPOS commands", () => {
  assert.equal(supportsPaymentCommands("0.5.4"), false);
  assert.equal(supportsPaymentCommands("0.6.0"), true);
  assert.equal(supportsPaymentCommands("0.6.1"), true);
  assert.equal(supportsPaymentCommands("1.0.0"), true);
  assert.equal(supportsPaymentCommands("unknown"), false);
});

test("only v0.6.2 and newer bridges use the isolated payment fast lane", () => {
  assert.equal(supportsPaymentFastLane("0.6.1"), false);
  assert.equal(supportsPaymentFastLane("0.6.2"), true);
  assert.equal(supportsPaymentFastLane("0.7.0"), true);
  assert.equal(supportsPaymentFastLane("unknown"), false);
});

test("only v0.6.3 and newer bridges use the isolated control fast lane", () => {
  assert.equal(supportsControlFastLane("0.6.2"), false);
  assert.equal(supportsControlFastLane("0.6.3"), true);
  assert.equal(supportsControlFastLane("0.7.0"), true);
  assert.equal(supportsControlFastLane("unknown"), false);
});

test("only v0.6.4 and newer bridges receive parking registration commands", () => {
  assert.equal(supportsParkingCommands("0.6.3"), false);
  assert.equal(supportsParkingCommands("0.6.4"), true);
  assert.equal(supportsParkingCommands("0.7.0"), true);
  assert.equal(supportsParkingCommands("unknown"), false);
});

test("parking commands use a dedicated authenticated lane", async () => {
  const [commands, policy, ack] = await Promise.all([
    import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../app/api/agent/parking-commands/route.ts", import.meta.url), "utf8"),
    ),
    import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../app/api/agent/parking-policy/route.ts", import.meta.url), "utf8"),
    ),
    import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../app/api/agent/parking-ack/route.ts", import.meta.url), "utf8"),
    ),
  ]);
  assert.match(commands, /action = 'parking_register'/);
  assert.match(commands, /supportsParkingCommands\(version\)/);
  assert.match(policy, /autoRegistrationEnabled/);
  assert.match(ack, /completeParkingDiscountRequest/);
});

test("agent sync excludes payment commands only after fast-lane capability", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../app/api/agent/sync/route.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /supportsPaymentFastLane\(version\)/);
  assert.match(source, /target_agent_id = \?/);
  assert.match(source, /action NOT IN \('payment_status', 'payment_pay', 'payment_cancel'\)/);
});

test("agent sync excludes normal control commands only after control fast-lane capability", async () => {
  const [syncSource, fastLaneSource] = await Promise.all([
    import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../app/api/agent/sync/route.ts", import.meta.url), "utf8"),
    ),
    import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../app/api/agent/control-commands/route.ts", import.meta.url), "utf8"),
    ),
  ]);
  assert.match(syncSource, /supportsControlFastLane\(version\)/);
  assert.match(syncSource, /action NOT IN \('set_info', 'start', 'stop', 'all_stop'\)/);
  assert.match(fastLaneSource, /action IN \('set_info', 'start', 'stop', 'all_stop'\)/);
  assert.match(fastLaneSource, /status = 'claimed'/);
});

test("ordinary control ACK skips payment and kiosk-only finalizers", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../app/api/agent/ack/route.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /finalizeCommandAck\(\{/);
  assert.match(source, /commandSaveResult\?\.newlyFinalized === true/);
  assert.match(source, /const paymentCommand = commandNewlyFinalized && \(commandAction\.startsWith\("payment_"\) \|\| Boolean\(traceId\)\)/);
  assert.match(source, /if \(paymentCommand\) \{/);
  assert.match(source, /\["set_info", "start", "stop"\]\.includes\(commandAction\)/);
  assert.match(source, /customerVisitId/);
  assert.match(source, /if \(kioskCommand && commandNewlyFinalized\) \{/);
});

test("V2 exposes manual approval matching only for UNKNOWN card attempts", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../app/admin/ReservationsAdmin.tsx", import.meta.url), "utf8"),
  );
  assert.match(source, /attempt\.paymentMethod === "card"/);
  assert.match(source, /attempt\.status === "UNKNOWN"/);
  assert.match(source, /action: "reconcile_approved"/);
  assert.match(source, /승인번호로 결제완료/);
  const v2 = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../app/admin/v2/PosV2.tsx", import.meta.url), "utf8"),
  );
  assert.match(v2, /item\.status === "UNKNOWN"/);
  assert.match(v2, /승인번호 입력/);
});
