import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile remote reuses authoritative kiosk and command services", async () => {
  const route = await readFile(new URL("../app/api/admin/remote/route.ts", import.meta.url), "utf8");
  assert.match(route, /getOperator/);
  assert.match(route, /confirmKioskManualPayment/);
  assert.match(route, /reinputKioskVisitInfo/);
  assert.match(route, /startKioskGameFromDevice/);
  assert.match(route, /stopKioskGameFromAdmin/);
  assert.doesNotMatch(route, /localhost|127\.0\.0\.1/);
});

test("mobile remote waits for actual room state instead of treating enqueue as success", async () => {
  const component = await readFile(new URL("../app/admin/remote/RemoteOperationsConsole.tsx", import.meta.url), "utf8");
  assert.match(component, /room\?\.status === "running"/);
  assert.match(component, /room\.status !== "running"/);
  assert.match(component, /명령을 전송했습니다\. 실제 상태를 확인하고 있습니다/);
  assert.match(component, /stateStale/);
});

test("mobile remote separates bridge, control, manager and room readiness", async () => {
  const [service, component, remoteRoute, commandRoute, customerFlow, heartbeat, ack] = await Promise.all([
    readFile(new URL("../db/remote-operations.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/remote/RemoteOperationsConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/remote/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/commands/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/heartbeat/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/ack/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(service, /control:\s*\{/);
  assert.match(service, /manager:\s*\{/);
  assert.match(service, /room_control_runtime/);
  assert.match(service, /canSetInfo/);
  assert.match(service, /canStart/);
  assert.match(component, /관리자 프로그램/);
  assert.match(component, /room\.canSetInfo/);
  assert.match(component, /room\.canStart/);
  assert.match(remoteRoute, /assertVisitControlReady\(visitId, "set_info"\)/);
  assert.match(remoteRoute, /assertVisitControlReady\(visitId, "start"\)/);
  assert.match(remoteRoute, /assertVisitControlReady\(visitId, "stop"\)/);
  assert.match(commandRoute, /getControlCommandReadiness\(payload\.roomId, payload\.action\)/);
  assert.match(customerFlow, /assertControlCommandReady\(room\.roomId, action\)/);
  assert.doesNotMatch(customerFlow, /markRoomControlPending\(/);
  assert.doesNotMatch(remoteRoute, /persistPendingRoom/);
  assert.match(heartbeat, /roomControlStates/);
  assert.match(heartbeat, /managerProbeSuccessCount/);
  assert.match(heartbeat, /controlLoopLastSeen/);
  assert.match(ack, /finalizeCommandAck/);
  assert.match(ack, /errorCode/);
  assert.match(ack, /roomControlState/);
});

test("room runtime ignores an older pending write after a newer final result", async () => {
  const control = await readFile(new URL("../db/control.ts", import.meta.url), "utf8");
  assert.match(control, /excluded\.state_seen_at > COALESCE\(room_control_runtime\.state_seen_at, ''\)/);
  assert.match(control, /excluded\.control_state <> 'CONTROL_PENDING'/);
  assert.match(control, /room_control_runtime\.control_state = 'CONTROL_PENDING'/);
  assert.match(control, /datetime\(observed_at\)/);
  assert.match(control, /excluded\.control_state = 'READY'/);
  assert.match(control, /'SET_INFO_FAILED', 'CONTROL_FAILED'/);
  assert.doesNotMatch(control, /INSERT INTO room_control_runtime \(room_id, state_seen_at, updated_at\)/);
  assert.match(control, /WHERE room_id = \?\s+AND current_command_id = \?/);
});

test("control claim is serialized and command finalization is atomic with room finalization", async () => {
  const [claim, ack, control, sync, commands] = await Promise.all([
    readFile(new URL("../app/api/agent/control-commands/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/ack/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/control.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/commands/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(claim, /active_control\.status = 'claimed'/);
  assert.match(claim, /ORDER BY created_at ASC LIMIT 1/);
  assert.match(control, /finalizeCommandAck/);
  assert.match(control, /const results = await db\.batch\(\[/);
  assert.match(control, /finalized\.completed_at = \?/);
  assert.match(control, /current_command_id = \?/);
  assert.match(sync, /state_seen_at = \?/);
  assert.match(sync, /completed_at = \?/);
  assert.doesNotMatch(commands, /duplicate_command_lookup/);
  assert.match(commands, /isControlCommandBusyError/);
  assert.match(ack, /commandNewlyFinalized/);
  assert.match(ack, /ACK_STATE_CONFLICT/);
  assert.match(sync, /CONTROL_ACK_TIMEOUT_AMBIGUOUS/);
  assert.match(sync, /action NOT IN \('parking_register', 'set_info', 'start', 'stop', 'all_stop'\)/);
});

test("heartbeat preserves missing probe timestamps and readiness enforces manager probe TTL", async () => {
  const [heartbeat, control, service] = await Promise.all([
    readFile(new URL("../app/api/agent/heartbeat/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/control.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/remote-operations.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(heartbeat, /cleanTimestamp\(body\.managerProbeAt\) \?\? nowIso/);
  assert.doesNotMatch(heartbeat, /cleanTimestamp\(body\.controlLoopLastSeen\) \?\? nowIso/);
  assert.match(heartbeat, /COALESCE\(excluded\.manager_probe_at, agent_runtime\.manager_probe_at\)/);
  assert.match(heartbeat, /COALESCE\(excluded\.control_loop_last_seen, agent_runtime\.control_loop_last_seen\)/);
  assert.match(control, /datetime\(agent_runtime\.manager_probe_at\)/);
  assert.match(control, /managerProbeFresh/);
  assert.match(service, /datetime\(agent_runtime\.manager_probe_at\)/);
  assert.match(service, /managerProbeFresh/);
});

test("operational push reuses the registered admin PWA without exposing customer fields", async () => {
  const push = await readFile(new URL("../db/push-notifications.ts", import.meta.url), "utf8");
  const flow = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(push, /dispatchOperationalPush/);
  assert.match(push, /push_operational_deliveries/);
  assert.match(push, /targetUrl \|\| "\/admin\/remote"/);
  assert.match(flow, /KIOSK_PAYMENT_CONFIRM_REQUIRED/);
  assert.match(flow, /KIOSK_READY_TO_PLAY/);
  assert.match(flow, /KIOSK_STAFF_HELP/);
  assert.doesNotMatch(push, /customer_phone|card_number|vehicle_number/);
  assert.match(worker, /targetUrl = briefing\.url \|\| targetUrl/);
  assert.match(worker, /notificationKind = briefing\.kind \|\| notificationKind/);
  assert.match(worker, /isOperationalNotification \? "\/admin\/remote"/);
  assert.match(worker, /clientUrl\.pathname\.startsWith\("\/admin"\)/);
});
