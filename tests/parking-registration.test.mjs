import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sanitizeParkingSettings } from "../app/parking-config.ts";

test("parking auto-registration defaults off and sanitizes an explicit toggle", () => {
  const base = {
    enabled: true,
    registrationUrl: "https://parking.example.com/discount/registration",
    sessionMaxSeconds: 30,
  };
  assert.equal(sanitizeParkingSettings(base)?.autoRegistrationEnabled, false);
  assert.equal(sanitizeParkingSettings({ ...base, autoRegistrationEnabled: true })?.autoRegistrationEnabled, true);
});

test("parking mode separates automatic enqueue from manual registration", async () => {
  const [route, policy, queue, settings, database] = await Promise.all([
    readFile(new URL("../app/api/parking-discount/register/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/parking-policy/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/parking-registration.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/parking-settings.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/parking-discounts.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /triggerMode: "manual"/);
  assert.doesNotMatch(route, /if \(!settings\.autoRegistrationEnabled\)/);
  assert.match(queue, /input\.triggerMode === "auto" && !settings\.autoRegistrationEnabled/);
  assert.match(policy, /enabled: true/);
  assert.match(settings, /parking_setting_audit/);
  assert.match(settings, /parkingAutoRegistrationEnabled/);
  assert.match(database, /parking_registration_status = 'PENDING'/);
  assert.match(database, /parking_registration_status = \?/);
  assert.match(database, /parking_discount_requests_idempotency_idx/);
  assert.match(database, /parking_discount_requests_command_idx/);
});

test("admin parking controls preserve the vehicle and expose terminal results", async () => {
  const source = await readFile(new URL("../app/admin/ReservationsAdmin.tsx", import.meta.url), "utf8");
  assert.match(source, /fetch\("\/api\/parking-discount\/register"/);
  assert.match(source, /parkingRegistrationComplete\(reservation/);
  assert.match(source, /\? "주차등록완료"/);
  assert.match(source, /\? "수동등록필요"/);
  assert.match(source, /parkingRegistrationComplete\(reservation, vehicleLast4\)[\s\S]*setParkingExplicitRequest\(true\)/);
  assert.match(source, /parkingAutoEnabled\s*\? "자동등록"/);
  assert.match(source, /DRY RUN · 실제 할인은 등록하지 않았습니다/);
  assert.doesNotMatch(source, /fetch\("https:\/\/parking\.example\.com/);
});

test("automatic parking requests are stable while explicit requests can add another hour", async () => {
  const source = await readFile(new URL("../db/parking-registration.ts", import.meta.url), "utf8");
  assert.match(source, /const explicitIdempotencyKey = input\.idempotencyKey\?\.trim\(\) \?\? ""/);
  assert.match(source, /!explicitIdempotencyKey &&\s*input\.reservation\.parkingRegistrationStatus === "SUCCESS"/);
  assert.match(source, /`parking:\$\{input\.triggerMode\}:\$\{input\.reservation\.id\}:\$\{carLast4\}`/);
});

test("kiosk checkout queues parking once for the primary reservation", async () => {
  const source = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ queueAutomaticParkingRegistration \} from "\.\/parking-registration"/);
  const start = source.indexOf("export async function startKioskCheckout");
  const end = source.indexOf("export async function", start + 1);
  const checkout = source.slice(start, end > start ? end : undefined);
  assert.equal((checkout.match(/queueAutomaticParkingRegistration\(/g) ?? []).length, 1);
  assert.match(checkout, /let reservation = createdReservationGroup\.primary;[\s\S]*if \(visit\.flow_type !== "ADD_ON_ONLY" && reservation\.vehicleLast4\)[\s\S]*queueAutomaticParkingRegistration\(reservation, `kiosk:\$\{visit\.kiosk_id \|\| "main"\}`\)/);
  const reservationStart = source.indexOf("async function createReservationsForVisit");
  const reservationEnd = source.indexOf("async function cardReady", reservationStart);
  const reservationCreation = source.slice(reservationStart, reservationEnd);
  assert.doesNotMatch(reservationCreation, /queueAutomaticParkingRegistration\(/);
});

test("parking result normalization preserves the 270 minute policy", async () => {
  const source = await readFile(new URL("../db/parking-discounts.ts", import.meta.url), "utf8");
  assert.match(source, /export const PARKING_MAX_DISCOUNT_MINUTES = 270/);
  assert.doesNotMatch(source, /Math\.min\(240, Math\.trunc\(Number\(source\.(?:beforeMinutes|addedMinutes|afterMinutes)/);
});

test("parking work uses a dedicated bridge lane", async () => {
  const [source, generalSync, parkingRoute, database] = await Promise.all([
    readFile(new URL("../bridge/jumping_bridge.py", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/parking-commands/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/parking-discounts.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /name="parking-lane"/);
  assert.match(source, /def _parking_loop\(self\):/);
  assert.match(source, /parking_remote\.parking_commands/);
  const start = source.indexOf("def _process_parking_commands");
  const end = source.indexOf("def _parking_loop", start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /_manager_io_lock/);
  assert.match(generalSync, /action <> 'parking_register'/);
  assert.match(parkingRoute, /await maintainParkingDiscountRequests\(\)/);
  assert.match(database, /status = 'NEEDS_REVIEW'/);
  assert.match(database, /COMMAND_TIMEOUT/);
  assert.match(database, /COMMAND_FAILED/);
});
