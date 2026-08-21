import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canCustomerStart,
  calculateParticipantTopUp,
  holdSecondsRemaining,
  isPaymentOrGameCritical,
  kioskSlotStartsAfterRunningGame,
  KIOSK_HOLD_MS,
  normalizeKioskPaymentItems,
  parkingSessionPhase,
  paidGameParticipantCount,
  splitKioskEqualAmount,
  stampAwardQuantity,
} from "../app/kiosk/domain.ts";
import {
  DEFAULT_PARKING_REGISTRATION_URL,
  isAllowedParkingRegistrationUrl,
  sanitizeParkingSettings,
} from "../app/parking-config.ts";
import {
  createPartyPersistenceCoordinator,
  runPartyTransitionFirst,
} from "../app/kiosk/party-persistence.ts";

test("room hold is three minutes and expires deterministically", () => {
  assert.equal(KIOSK_HOLD_MS, 180_000);
  assert.equal(holdSecondsRemaining("2026-08-13T10:03:00.000Z", Date.parse("2026-08-13T10:00:00.000Z")), 180);
  assert.equal(holdSecondsRemaining("2026-08-13T10:03:00.000Z", Date.parse("2026-08-13T10:04:00.000Z")), 0);
});

test("participant top-up charges only the newly added people at the normal price", () => {
  assert.deepEqual(calculateParticipantTopUp({
    currentAdultCount: 1,
    currentYouthCount: 2,
    additionalAdultCount: 1,
    additionalYouthCount: 1,
    adultPrice: 7_000,
    youthPrice: 5_000,
  }), {
    currentAdultCount: 1,
    currentYouthCount: 2,
    additionalAdultCount: 1,
    additionalYouthCount: 1,
    additionalCount: 2,
    targetAdultCount: 2,
    targetYouthCount: 3,
    targetPartyCount: 5,
    amount: 12_000,
  });
});

test("participant top-up rejects empty additions and parties over ten", () => {
  assert.throws(() => calculateParticipantTopUp({
    currentAdultCount: 1,
    currentYouthCount: 1,
    additionalAdultCount: 0,
    additionalYouthCount: 0,
    adultPrice: 7_000,
    youthPrice: 5_000,
  }), /KIOSK_PARTICIPANT_TOP_UP_EMPTY/);
  assert.throws(() => calculateParticipantTopUp({
    currentAdultCount: 5,
    currentYouthCount: 5,
    additionalAdultCount: 1,
    additionalYouthCount: 0,
    adultPrice: 7_000,
    youthPrice: 5_000,
  }), /KIOSK_PARTY_INVALID/);
});

test("kiosk participant top-up is isolated from the normal checkout path", async () => {
  const [app, route, service, payments] = await Promise.all([
    readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/payments.ts", import.meta.url), "utf8"),
  ]);
  assert.match(app, /게임 인원 추가 결제/);
  assert.match(app, /begin\("PARTY_TOP_UP"\)/);
  assert.match(route, /action === "participant_top_up_quote"/);
  assert.match(service, /startKioskParticipantTopUpCheckout/);
  assert.match(service, /prepareParticipantTopUpPlan/);
  assert.match(payments, /KIOSK_PARTICIPANT_TOP_UP:/);
  const topUpPaymentSection = payments.slice(
    payments.indexOf("export async function prepareParticipantTopUpPlan"),
    payments.indexOf("async function executePaymentAttempt"),
  );
  assert.doesNotMatch(topUpPaymentSection, /DELETE FROM payment_attempts/);
});

test("participant top-up finds today's paid game by team name while normal reservations keep phone search", async () => {
  const [app, route, service] = await Promise.all([
    readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /기존 게임에서 사용한 팀명을 입력해주세요/);
  assert.match(app, /teamName: reservationTeamQuery\.trim\(\)/);
  assert.match(app, /participantTopUp \|\| repeatGame \? \{ teamName:[\s\S]+: \{ phone: loginPhone \}/);
  assert.match(route, /phone: String\(body\.phone[\s\S]+teamName: String\(body\.teamName/);
  assert.match(service, /visit\.flow_type === "PARTY_TOP_UP"/);
  assert.match(service, /lower\(replace\(trim\(team_name\), ' ', ''\)\) = lower\(\?\)/);
  assert.match(service, /AND payment_status = 'paid'/);
  assert.match(service, /replace\(replace\(replace\(customer_phone/);
});

test("parking session warns at 15 seconds and expires at the configured boundary", () => {
  const startedAt = Date.parse("2026-08-14T12:00:00+09:00");
  const endsAt = startedAt + 30_000;
  assert.deepEqual(parkingSessionPhase(startedAt, endsAt), { remainingSeconds: 30, warning: false, expired: false });
  assert.deepEqual(parkingSessionPhase(endsAt - 15_000, endsAt), { remainingSeconds: 15, warning: true, expired: false });
  assert.deepEqual(parkingSessionPhase(endsAt, endsAt), { remainingSeconds: 0, warning: false, expired: true });
});

test("parking integration uses a dedicated popup and never embeds ParkingWeb", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  assert.match(app, /window\.open\("about:blank", "jumping-parking-registration"/);
  assert.match(app, /parking\.example\.com/);
  assert.match(app, /finishParking\("timeout"\)/);
  assert.match(app, /주차등록 창 닫기 · 점핑배틀로 돌아가기/);
  assert.doesNotMatch(app, /<iframe[^>]+parkingweb/i);
});

test("parking popup keeps a hard deadline while the opener is backgrounded or detached", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  assert.match(app, /const parkingTimeoutRef = useRef<number \| null>\(null\)/);
  assert.match(app, /parkingTimeoutRef\.current = window\.setTimeout\(expire/);
  assert.match(app, /document\.addEventListener\("visibilitychange", checkOnVisibility\)/);
  assert.match(app, /window\.addEventListener\("focus", checkSession\)/);
  assert.match(app, /catch \{[\s\S]*WindowProxy[\s\S]*\} finally \{[\s\S]*parkingPopupRef\.current = null/);
  assert.match(app, /popupClosed && !document\.hidden/);
  assert.match(app, /등록 완료 여부는 자동으로 확인하지 않습니다/);
});

test("parking settings only allow the dedicated HTTPS registration endpoint", () => {
  assert.equal(sanitizeParkingSettings({
    enabled: false,
    registrationUrl: DEFAULT_PARKING_REGISTRATION_URL,
    sessionMaxSeconds: 30,
  })?.sessionMaxSeconds, 30);
  assert.equal(isAllowedParkingRegistrationUrl(DEFAULT_PARKING_REGISTRATION_URL), true);
  assert.equal(isAllowedParkingRegistrationUrl("http://parking.example.com/discount/registration"), false);
  assert.equal(isAllowedParkingRegistrationUrl("https://parking.example.com/admin"), false);
  assert.equal(isAllowedParkingRegistrationUrl("https://example.com/discount/registration"), false);
  assert.deepEqual(sanitizeParkingSettings({
    enabled: true,
    registrationUrl: DEFAULT_PARKING_REGISTRATION_URL,
    sessionMaxSeconds: 90,
  }), {
    enabled: true,
    autoRegistrationEnabled: false,
    registrationUrl: DEFAULT_PARKING_REGISTRATION_URL,
    sessionMaxSeconds: 90,
  });
  assert.equal(sanitizeParkingSettings({
    enabled: true,
    registrationUrl: DEFAULT_PARKING_REGISTRATION_URL,
    sessionMaxSeconds: 10,
  }), null);
});

test("a running room blocks the current slot until its projected game end", () => {
  const nowAt = Date.parse("2026-08-14T12:40:30+09:00");
  const base = { roomStatus: "running", nowAt, remainingSeconds: 930, endsAt: "2026-08-14T12:56:00+09:00" };
  assert.equal(kioskSlotStartsAfterRunningGame({ ...base, slotStartAt: Date.parse("2026-08-14T12:40:00+09:00") }), false);
  assert.equal(kioskSlotStartsAfterRunningGame({ ...base, slotStartAt: Date.parse("2026-08-14T13:00:00+09:00") }), true);
  assert.equal(kioskSlotStartsAfterRunningGame({ roomStatus: "running", nowAt, remainingSeconds: 0, slotStartAt: nowAt }), false);
  assert.equal(kioskSlotStartsAfterRunningGame({ roomStatus: "waiting", nowAt, slotStartAt: nowAt }), true);
});

test("customer start requires staff-ready state, healthy room and one-time token", () => {
  const base = { state: "READY_TO_PLAY", roomStatus: "waiting", hasDifficulty: true, tokenMatches: true, tokenExpiresAt: 200, now: 100 };
  assert.equal(canCustomerStart(base), true);
  assert.equal(canCustomerStart({ ...base, state: "PREPARING" }), false);
  assert.equal(canCustomerStart({ ...base, roomStatus: "running" }), false);
  assert.equal(canCustomerStart({ ...base, tokenMatches: false }), false);
  assert.equal(canCustomerStart({ ...base, tokenExpiresAt: 100 }), false);
});

test("idle reset never releases payment or active game flows", () => {
  for (const state of ["PAYMENT_PENDING", "WAITING_STAFF_CONFIRMATION", "PREPARING", "READY_TO_PLAY", "PLAYING"]) assert.equal(isPaymentOrGameCritical(state), true);
  for (const state of ["DRAFT", "HOLD", "COMPLETED", "CANCELLED"]) assert.equal(isPaymentOrGameCritical(state), false);
});

test("stamp eligibility counts paid game participants rather than transactions", () => {
  assert.equal(paidGameParticipantCount({ partyCount: 4 }), 4);
  assert.equal(paidGameParticipantCount({ partyCount: 4, benefitType: "pass", benefitUses: 1 }), 3);
  assert.equal(paidGameParticipantCount({ partyCount: 4, benefitType: "coupon", benefitUses: 1 }), 3);
  assert.equal(paidGameParticipantCount({ partyCount: 4, passUses: 1, couponUses: 1 }), 2);
  assert.equal(paidGameParticipantCount({ partyCount: 4, addOnOnly: true }), 0);
  assert.equal(stampAwardQuantity({ partyCount: 4, passUses: 1, couponUses: 1, stampsPerParticipant: 1 }), 2);
  assert.equal(stampAwardQuantity({ partyCount: 4, passUses: 1, couponUses: 1, stampsPerParticipant: 2 }), 4);
});

test("admin and kiosk completion share participant-based stamp rules and one reservation key", async () => {
  const [benefits, customerFlow] = await Promise.all([
    readFile(new URL("../db/member-benefits.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8"),
  ]);
  assert.match(benefits, /stampAwardQuantity/);
  assert.match(benefits, /SUM\(ABS\(u\.uses\)\)/);
  assert.match(benefits, /used_reservation_id = \? AND status = 'USED'/);
  assert.match(customerFlow, /stampAwardQuantity/);
  assert.match(customerFlow, /stamp-earn:reservation:/);
});

test("kiosk payment split accepts card cash and account only when totals match", () => {
  assert.deepEqual(normalizeKioskPaymentItems(14_000, undefined), [{ amount: 14_000, paymentMethod: "card" }]);
  assert.deepEqual(normalizeKioskPaymentItems(14_000, [
    { amount: 4_000, paymentMethod: "cash" },
    { amount: 10_000, paymentMethod: "card" },
  ]), [
    { amount: 4_000, paymentMethod: "cash" },
    { amount: 10_000, paymentMethod: "card" },
  ]);
  assert.deepEqual(normalizeKioskPaymentItems(14_000, [
    { amount: 4_667, paymentMethod: "card" },
    { amount: 4_667, paymentMethod: "card" },
    { amount: 4_666, paymentMethod: "account" },
  ]), [
    { amount: 4_667, paymentMethod: "card" },
    { amount: 4_667, paymentMethod: "card" },
    { amount: 4_666, paymentMethod: "account" },
  ]);
  assert.deepEqual(splitKioskEqualAmount(14_000, 3), [4_667, 4_667, 4_666]);
  assert.throws(() => normalizeKioskPaymentItems(14_000, [{ amount: 13_000, paymentMethod: "cash" }]), /KIOSK_PAYMENT_TOTAL_MISMATCH/);
});

test("kiosk exposes all payment modes and lets each split choose a method before processing", async () => {
  const [app, route, service, payments] = await Promise.all([
    readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/payments.ts", import.meta.url), "utf8"),
  ]);
  assert.match(app, /한번에 결제/);
  assert.match(app, /N분의1/);
  assert.match(app, /직접 나누기/);
  assert.match(app, /각 회차 결제 직전에 결제수단을 선택해요/);
  assert.match(app, /mode === "single" \? <PaymentMethodButtons/);
  assert.match(app, /splitPaymentActive/);
  assert.match(app, /activePayment\.status === "PROCESSING" \? activePayment\.paymentMethod : null/);
  assert.match(app, /이번 회차에서 사용할 결제수단을 선택해주세요/);
  assert.match(app, /disabled=\{!activeMethod\}/);
  assert.match(app, /payment-progress-summary/);
  assert.match(app, /const methodText = completed/);
  assert.match(app, /processCurrentPayment\(activePayment, activePaymentMethod\)/);
  assert.match(app, /action: "process_payment"/);
  assert.match(route, /action === "process_payment"/);
  assert.match(service, /processKioskPayment/);
  assert.match(service, /changePendingPaymentTransactionMethod/);
  assert.match(payments, /preparePaymentTransactionRetry/);
});

test("kiosk only shows the expected stamp preview to a signed-in member", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  assert.match(app, /currentFlowType !== "ADD_ON_ONLY" && member \? <div className="stamp-preview">/);
});

test("kiosk shares immediate press, ripple and selected feedback across touch controls", async () => {
  const [app, page, feedback, styles] = await Promise.all([
    readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/kiosk/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/useTouchFeedback.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/touch-feedback.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /touch-feedback\.css/);
  assert.match(app, /useTouchFeedbackRoot/);
  assert.match(app, /touch-feedback-scope/);
  assert.match(app, /aria-pressed=\{mode === option\.code\}/);
  assert.match(app, /aria-pressed=\{value === method\.code\}/);
  assert.match(feedback, /pointerdown/);
  assert.match(feedback, /event\.clientX - rect\.left/);
  assert.match(styles, /\.is-touching/);
  assert.match(styles, /touch-ripple-expand/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /prefers-reduced-motion/);
});

test("manual kiosk payments wait for staff and only card enters terminal readiness", async () => {
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  assert.match(service, /WAITING_STAFF_CONFIRMATION/);
  assert.match(service, /\["cash", "account"\]\.includes\(next\.paymentMethod\)/);
  assert.match(service, /if \(next\.paymentMethod === "card"\) await cardReady\(\)/);
  assert.match(service, /confirmKioskManualPayment/);
});

test("kiosk guidance and product management are durable and soft-delete products", async () => {
  const migration = await readFile(new URL("../drizzle/0034_kiosk_operating_ux.sql", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  assert.match(migration, /kiosk_guidance_items/);
  assert.match(migration, /customer_product_overrides/);
  assert.match(migration, /'other', '양말'/);
  assert.match(service, /saveKioskGuidance/);
  assert.match(service, /removeKioskProduct/);
  assert.match(service, /active: false/);
});

test("kiosk guidance editor preserves in-progress input and failed additions", async () => {
  const operations = await readFile(new URL("../app/admin/kiosk/KioskOperations.tsx", import.meta.url), "utf8");
  const kiosk = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/admin/kiosk/kiosk-admin.css", import.meta.url), "utf8");
  assert.match(operations, /if \(!dirty\) setDraft\(item\)/);
  assert.match(operations, /activeMutationCountRef\.current > 0/);
  assert.match(operations, /mutationEpoch !== mutationEpochRef\.current/);
  assert.match(operations, /if \(!result\) \{ setGuidanceMessage\("추가하지 못했습니다\. 입력 내용은 그대로 유지됩니다\."\); return; \}/);
  assert.match(operations, /if \(!result\) \{ setFeedback\("저장하지 못했습니다\. 입력 내용은 그대로 유지됩니다\."\); return; \}/);
  assert.match(operations, /maxLength=\{1000\}/);
  assert.match(kiosk, /if \(screen !== "guide"\) return;[\s\S]*?loadBootstrap\(\)/);
  assert.match(kiosk, /guidanceAgreementText/);
  assert.match(kiosk, /setGuidanceChecks\(\{\}\);[\s\S]*?setGuidanceRefreshState\("loading"\)/);
  assert.match(kiosk, /guidanceRefreshState !== "ready" \|\| !guidanceAccepted/);
  assert.match(styles, /\.guidance-item\.detailed/);
  assert.match(styles, /\.guidance-form-grid/);
  assert.match(styles, /\.guidance-required input\{width:18px!important;height:18px!important/);
});

test("kiosk shows every required guidance detail inline without a separate sheet", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/kiosk/kiosk-home.css", import.meta.url), "utf8");
  const guide = sourceSection(app, '{screen === "guide" ?', '{screen === "fastest" ?');
  assert.match(app, /placement === "REQUIRED_AGREEMENT" && item\.active/);
  assert.match(app, /requiredConsentItems = requiredGuidance\.filter\(\(item\) => item\.required\)/);
  assert.match(guide, /requiredGuidance\.map\(\(item, index\)/);
  assert.match(guide, /item\.title/);
  assert.match(guide, /item\.summary/);
  assert.match(guide, /item\.content/);
  assert.match(guide, /guidance-inline-content/);
  assert.match(guide, /guidanceAgreementText/);
  assert.match(guide, /checked=\{guidanceAccepted\}/);
  assert.match(guide, /disabled=\{guidanceRefreshState !== "ready"\}/);
  assert.doesNotMatch(guide, /requiredGuidance\[0\]|guidanceDetailsOpen|guidance-detail-sheet|안내 자세히 보기|role="dialog"/);
  assert.match(styles, /\.guidance-inline-step/);
  assert.match(styles, /\.required-guidance-list\.guidance-inline-list/);
  assert.match(styles, /white-space: pre-line/);
});

test("schema and implementation preserve all required operational states", async () => {
  const migration = await readFile(new URL("../drizzle/0033_kiosk_customer_flow.sql", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  for (const state of ["ACTIVE", "PAYMENT_PENDING", "CONVERTED", "EXPIRED", "CANCELLED"]) assert.match(`${migration}\n${service}`, new RegExp(`['\"]${state}['\"]`));
  for (const state of ["COMPLETED", "ABORTED", "ERROR", "START_FAILED", "STAFF_REVIEW"]) assert.match(service, new RegExp(`['\"]${state}['\"]`));
});

test("kiosk card checkout reuses existing payment engine and never implements MPOS protocol", async () => {
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  assert.match(service, /preparePaymentPlan/);
  assert.match(service, /processPreparedPaymentTransaction/);
  assert.doesNotMatch(service, /FDK_Execute|FDK_Module|Win4POS|socket\.connect/);
});

test("kiosk card checkout safely recreates a cancelled attempt before retrying", async () => {
  const [service, route] = await Promise.all([
    readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8"),
  ]);
  const checkout = service.slice(
    service.indexOf("export async function startKioskCheckout"),
    service.indexOf("export async function waitKioskPayment"),
  );
  assert.match(service, /KIOSK_AUTOMATIC_RETRYABLE_PAYMENT_STATES = new Set\(\["DECLINED", "USER_CANCELLED", "ERROR", "UNLINKED"\]\)/);
  assert.match(checkout, /KIOSK_AUTOMATIC_RETRYABLE_PAYMENT_STATES\.has\(next\.status\)/);
  assert.match(checkout, /preparePaymentTransactionRetry\(/);
  assert.match(checkout, /kiosk-pay:\$\{visit\.id\}:\$\{next\.splitIndex\}:\$\{next\.id\}/);
  assert.match(route, /\[KIOSK_API_ERROR\]/);
  assert.match(route, /PAYMENT_TRANSACTION_NOT_PENDING/);
});

test("OK-K1 portrait kiosk selects room and time from one customer timetable", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/kiosk/kiosk-home.css", import.meta.url), "utf8");
  assert.match(app, /RoomTimeTable/);
  assert.match(app, /방과 시간을 한 번에 골라주세요/);
  assert.match(app, /\["C2", "B1", "C1", "A1"\]/);
  assert.match(styles, /orientation:\s*portrait/);
  assert.match(styles, /grid-template-columns:\s*118px repeat\(4/);
});

test("kiosk touch inputs use the in-page keyboard while keeping team names optional", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const keyboard = await readFile(new URL("../app/kiosk/KioskKeyboard.tsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/kiosk/page.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  assert.match(app, /KioskInput/);
  assert.match(app, /formatter=\{formatKoreanPhone\}/);
  assert.doesNotMatch(app, /revealForTouchKeyboard/);
  assert.match(keyboard, /inputMode="none"/);
  assert.match(keyboard, /readOnly/);
  assert.match(keyboard, /getBoundingClientRect\(\)/);
  assert.match(keyboard, /window\.visualViewport/);
  assert.match(page, /KioskKeyboardProvider/);
  assert.match(app, /저장된 팀명/);
  assert.match(app, /팀명 \(선택\)/);
  assert.match(app, /입력하지 않아도 괜찮아요/);
  assert.match(app, /차량번호 뒤 4자리 \(선택\)/);
  assert.match(app, /vehicleLast4\.length === 0 \|\| vehicleLast4\.length === 4/);
  assert.match(app, /차량번호는 뒤 4자리를 모두 입력하거나 비워주세요/);
  assert.match(service, /team_name = CASE WHEN \? = 1 THEN \? ELSE team_name END/);
  assert.match(app, /nextDraftSnapshot\(\{ teamName: normalizedTeam, vehicleLast4 \}\)/);
  assert.match(app, /queueDraftSnapshot\(snapshot\)/);
  assert.doesNotMatch(app, /action: "party", adultCount: visit\?\.adultCount/);
  assert.match(route, /action === "team"/);
  assert.match(service, /export async function updateKioskTeamName/);
});

test("expired or cancelled kiosk sessions release Naver reservations for a safe retry", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  assert.match(service, /status = 'EXPIRED', reservation_id = NULL/);
  assert.match(service, /reservation_id = CASE WHEN status IN \('DRAFT', 'HOLD'\) THEN NULL ELSE reservation_id END/);
  assert.match(service, /status IN \('CANCELLED', 'EXPIRED'\)/);
  assert.match(service, /KIOSK_RESERVATION_IN_USE/);
  assert.match(route, /KIOSK_RESERVATION_IN_USE/);
  assert.match(service, /await db\.batch\(\[/);
  assert.match(app, /setActiveFlowType\("RESERVATION"\)/);
  assert.match(app, /go\("party"\)/);
  assert.match(app, /currentFlowType === "RESERVATION" \? "reservation-confirm" : "difficulty"/);
  assert.match(app, /"인원 확인 필요"/);
  assert.match(app, /"현장 확인"/);
});

test("kiosk home polls only a lightweight room snapshot and counts down locally", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  assert.match(route, /scope === "room_status"/);
  assert.match(service, /getKioskRoomStatusSnapshot/);
  assert.match(service, /ROW_NUMBER\(\) OVER \(PARTITION BY room_code/);
  assert.match(app, /scope=room_status/);
  assert.match(app, /window\.setTimeout\(\(\) => void refresh\(\), 2_000\)/);
  assert.match(app, /document\.hidden/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /roomStatusRequestRef\.current/);
  assert.match(app, /Date\.parse\(live\.endsAt\) - now/);
  assert.match(app, /\["home", "room", "ready-select"\]\.includes\(screen\)/);
  assert.match(app, /RoomTimeTable rooms=\{liveRooms\}/);
  assert.match(app, /room\.status === "running" \? "게임 중"/);
  assert.doesNotMatch(app, /scope=state[^\n]+2500/);
});

test("paired store kiosk starts a ready room without a customer PIN", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8");
  const adminRoute = await readFile(new URL("../app/api/admin/kiosk/route.ts", import.meta.url), "utf8");
  const auth = await readFile(new URL("../app/pin-auth.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  assert.match(app, /className="home-game-start-cta"/);
  assert.match(app, /게임 시작 전 확인/);
  assert.match(app, /className="game-start" disabled=\{busy \|\| !allStartChecksDone\}/);
  assert.match(app, /setStartCountdown\(3\)/);
  assert.doesNotMatch(app, /게임 시작 확인번호/);
  assert.doesNotMatch(app, /해당 팀만 시작 가능/);
  assert.match(route, /hasKioskDeviceSession\(request\)/);
  assert.match(route, /action === "open_ready_room" \|\| action === "start_ready_game"/);
  assert.match(adminRoute, /action === "pair_device"/);
  assert.match(adminRoute, /action === "start_game"/);
  assert.match(auth, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(service, /startKioskGameFromDevice/);
  assert.match(service, /canCustomerStart/);
  assert.match(service, /queueVisitCommand\(visit, "start"/);
});

test("kiosk phase 2 removes duplicate visit work without weakening financial reloads", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  const reservations = await readFile(new URL("../db/reservations.ts", import.meta.url), "utf8");
  const benefits = await readFile(new URL("../db/member-benefits.ts", import.meta.url), "utf8");

  assert.match(service, /async function hydrateKioskVisit/);
  assert.match(service, /async function reloadKioskVisit/);
  assert.match(service, /getKioskAvailability\(visit\.party_count, \{ trace, skipExpiry: true \}\)/);
  assert.match(service, /hydrateKioskVisit\(visit, trace, hold\)/);
  assert.match(service, /quoteKioskCheckout[\s\S]+reloadKioskVisit\(visit\.id, trace\)/);
  assert.match(reservations, /let reservationSchemaReady: Promise<void> \| null/);
  assert.match(benefits, /let memberBenefitSchemaReady: Promise<void> \| null/);
  assert.match(route, /x-kiosk-trace-id/);
  assert.match(route, /server-timing/);
  assert.match(app, /KIOSK_PERF_FE/);
  assert.match(app, /stateRequestInFlightRef\.current/);
});

test("kiosk phase 3 renders approved combined steps first and keeps authoritative barriers", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");

  assert.match(app, /people-room-layout/);
  assert.match(app, /action: "party"/);
  assert.match(app, /currentFlowType === "RESERVATION" \? "reservation-confirm" : "difficulty"/);
  assert.match(app, /goInstant\("team", "guest_transition"\)/);
  assert.match(app, /action: "accept_guidance"[\s\S]+await quote\("review"\)/);
  assert.match(app, /screen === "fastest"/);
  assert.match(app, /가장 빠른 시간을 찾았어요/);
  assert.match(app, /최종 결제금액 확인 중/);
  assert.match(app, /queuedDraftRef/);
  assert.match(app, /flowGenerationRef/);
  assert.match(app, /AbortController/);
  assert.match(route, /action === "sync_draft"/);
  assert.match(route, /action === "hold"[\s\S]+draft: body\.draft/);
  assert.match(route, /action === "quote"[\s\S]+draft: body\.draft/);
  assert.match(service, /WHERE id = \? AND client_revision <= \?/);
  assert.match(service, /export async function syncKioskDraft/);
  assert.match(service, /holdKioskSlot[\s\S]+applyKioskDraftSnapshot/);
  assert.match(service, /quoteKioskCheckout[\s\S]+applyKioskDraftSnapshot/);
  assert.match(service, /reloadKioskVisit\(visit\.id, trace\)/);
});

test("kiosk back navigation resets the active session when it reaches home", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");

  assert.match(app, /const back = \(\) => \{[\s\S]+if \(next === "home"\) \{[\s\S]+void resetHome\(\);[\s\S]+return;/);
  assert.match(app, /if \(sessionPromiseRef\.current \|\| tokenRef\.current\) return;/);
});

test("operating kiosk follows the approved portrait prototype hierarchy", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/kiosk/kiosk-home.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /home-primary-grid/);
  assert.match(app, /home-secondary-grid/);
  assert.match(app, /room-size-visual/);
  assert.match(app, /difficultyDisplayMeta/);
  assert.match(app, /people-room-layout/);
  assert.match(app, /가장 빠른 시간을 찾았어요/);
  assert.match(app, /goInstant\("team", "guest_transition"\)/);
  assert.match(app, /const splitPayment = overview\.plan\.length > 1/);
  assert.match(styles, /\.home-primary-grid/);
  assert.match(styles, /\.people-room-layout/);
  assert.match(styles, /\.payment-review-step \.step-body/);
  assert.match(styles, /\.centered-flow/);
});

test("kiosk operating flow requires versioned guidance before quote without blocking auto assignment", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");

  assert.match(app, /screen === "guide"/);
  assert.match(app, /action: "accept_guidance"/);
  assert.match(app, /action: "auto_assign"/);
  assert.match(route, /action === "accept_guidance"/);
  assert.match(route, /action === "auto_assign"/);
  const autoAssign = sourceSection(service, "export async function autoAssignKioskSlot", "export async function quoteKioskParticipantTopUp");
  const quote = sourceSection(service, "export async function quoteKioskCheckout", "export async function startKioskCheckout");
  assert.doesNotMatch(autoAssign, /assertRequiredGuidanceAccepted/);
  assert.match(quote, /assertRequiredGuidanceAccepted/);
  assert.match(service, /kiosk_guidance_agreements/);
  assert.match(service, /autoAssignKioskSlot/);
  assert.match(service, /b1-medium-/);
});

test("kiosk room recommendations remain administrator managed", async () => {
  const operations = await readFile(new URL("../app/admin/kiosk/KioskOperations.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/admin/kiosk/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");

  assert.match(operations, /방 추천 규칙/);
  assert.match(operations, /recommendation_save/);
  assert.match(route, /action === "recommendation_save"/);
  assert.match(route, /action === "recommendation_remove"/);
  assert.match(service, /kiosk_room_recommendation_rules/);
});

test("normal kiosk checkout no longer appends multiple games while legacy grouped payment data stays supported", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");

  const chooseDifficulty = sourceSection(app, "async function chooseDifficulty", "function returnToPartyFromAssignment");
  assert.match(chooseDifficulty, /appendGame: false/);
  assert.match(chooseDifficulty, /afterTime: ""/);
  assert.doesNotMatch(app, /selectedGames\.length >= 10/);
  assert.match(app, /label === "부가상품" && value === "0원"/);
  assert.match(route, /appendGame: body\.appendGame === true/);
  assert.match(service, /customer_visit_games/);
  assert.match(service, /repeat_group_id = \?, repeat_sequence = \?/);
  assert.match(service, /const repeatGroupId = games\.results\.length > 1 \? crypto\.randomUUID\(\) : ""/);
  assert.match(service, /repeatGroupId, game\.sequence, reservation\.id/);
  assert.doesNotMatch(service, /repeatGroupId \|\| null/);
  assert.match(service, /const reservationIds = createdReservationGroup\.reservations\.map/);
  assert.match(service, /reservationIds,/);
  assert.match(service, /const totalParticipantSlots = visit\.party_count \* Math\.max\(1, Number\(visit\.game_count\) \|\| 1\)/);
  assert.match(service, /Math\.min\([\s\S]+totalParticipantSlots,[\s\S]+pass\.remainingUses/);
});

test("kiosk quick repeat reuses the completed team but recalculates benefits and payment", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");

  assert.match(app, /begin\("REPEAT_GAME"\)/);
  assert.match(app, /currentFlowType === "REPEAT_GAME" \? "benefits"/);
  assert.match(service, /flow_type === "REPEAT_GAME"/);
  assert.match(service, /status = 'completed' AND updated_at >= datetime\('now', '-15 minutes'\)/);
  assert.match(service, /settlement_json = '\{\}', stamp_allocations_json = '\[\]'/);
  assert.match(service, /LEFT JOIN customer_visit_games game ON game\.visit_id = visit\.id/);
  assert.match(service, /visit\.reservation_id = \? OR game\.reservation_id = \?/);
});

test("kiosk home copy is loaded from administrator display settings", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8");
  const admin = await readFile(new URL("../app/admin/kiosk/KioskOperations.tsx", import.meta.url), "utf8");

  assert.match(route, /displaySettings: await getKioskDisplaySettings\(\)/);
  assert.match(app, /bootstrap\?\.displaySettings\.homeTitle/);
  assert.match(admin, /display_settings_save/);
});

test("kiosk production UI preserves the approved prototype parity structure", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/kiosk/kiosk-home.css", import.meta.url), "utf8");

  for (const label of ["예약하고 왔어요", "현장에서 이용해요", "한 게임 더 이용", "게임 인원 추가 결제", "부가상품 구매", "주차등록"]) {
    assert.match(app, new RegExp(label));
  }
  for (const label of ["쉬워요", "보통이에요", "어려워요", "가장 쉬워요", "처음 방문 추천", "최고 난이도"]) {
    assert.match(app, new RegExp(label));
  }
  assert.match(app, /difficultyGroups\.map/);
  assert.match(app, /KioskLineIcon name="card"|method\.icon/);
  assert.doesNotMatch(app, /bootstrap\?\.parking\.enabled \? <button className="home-card parking"/);
  assert.match(styles, /\.home-screen\.home-operating,[\s\S]*display: block/);
  assert.match(styles, /\.home-primary-grid > \.home-card,[\s\S]*grid-area: auto/);
  assert.match(styles, /\.home-operating \.home-primary-grid > \.home-card\.reservation,[\s\S]*\.home-operating \.home-secondary-grid > \.home-card\.parking \{[\s\S]*grid-area: auto/);
  assert.match(styles, /\.identity-split \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(styles, /\.payment-review-step \.step-body \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(styles, /\.payment-review-step \.payment-method-buttons\.compact button > span > b \{[\s\S]*word-break: keep-all/);
  assert.match(styles, /\.difficulty-choice-grid \{[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/);
});

test("kiosk home uses four square room tiles and readable secondary actions", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/kiosk/kiosk-home.css", import.meta.url), "utf8");

  assert.match(app, /const order = \["C2", "B1", "C1", "A1"\]/);
  assert.match(app, /running \? "이용 중"/);
  assert.match(app, /preparing customer-ready/);
  for (const copy of ["방금 게임을 빠르게 다시 이용해요", "추가된 인원만 결제해요", "음료·양말 등을 구매해요", "차량 주차할인을 등록해요"]) {
    assert.match(app, new RegExp(copy));
  }
  assert.match(styles, /\.room-overview \.room-strip \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.room-overview \.room-strip article \{[\s\S]*aspect-ratio: 1 \/ 1/);
  assert.match(styles, /article\.available[\s\S]*#2bbd72/);
  assert.match(styles, /article\.running[\s\S]*#ef5965/);
  assert.match(styles, /article\.customer-ready[\s\S]*#4f86ef/);
  assert.match(styles, /\.home-operating \.home-secondary-grid \.home-card > div \{[\s\S]*flex-direction: column/);
  assert.match(styles, /home-secondary-grid \.home-card div > b[\s\S]*word-break: keep-all/);
});

test("latest approved kiosk layout remains intact under the 27-inch game-start layer", async () => {
  const [app, homeStyles, kiosk27Styles] = await Promise.all([
    readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/kiosk/kiosk-home.css", import.meta.url), "utf8"),
    readFile(new URL("../app/kiosk/kiosk-27.css", import.meta.url), "utf8"),
  ]);

  assert.match(homeStyles, /\.home-operating \.home-primary-grid \.home-card \{[\s\S]*aspect-ratio:\s*3 \/ 4/);
  assert.match(homeStyles, /\.home-operating \.home-secondary-grid \.home-card > div \{[\s\S]*flex-direction:\s*column/);
  assert.match(homeStyles, /\.payment-mode-tabs button \{[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;[\s\S]*text-align:\s*center/);
  assert.match(homeStyles, /\.current-payment-choice \.payment-method-buttons\.compact button,[\s\S]*\.payment-review-step \.payment-method-buttons\.compact button \{[\s\S]*text-align:\s*center/);
  assert.match(app, /className="prepare-home-notice">안내를 확인하면 홈 화면으로 돌아갑니다\./);
  assert.match(homeStyles, /\.prepare-home-notice \{[\s\S]*width:\s*100%;[\s\S]*text-align:\s*center/);
  assert.match(kiosk27Styles, /\.kiosk-shell \.status-screen,[\s\S]*width:\s*100%;[\s\S]*max-width:\s*1180px/);
  assert.match(kiosk27Styles, /\.kiosk-shell \.preparation-guide \{[\s\S]*width:\s*100%;[\s\S]*max-width:\s*none/);
  assert.match(app, /className="home-game-start-cta"/);
  assert.match(app, /screen === "ready-select"/);
  assert.match(kiosk27Styles, /\.kiosk-shell \.game-start \{[\s\S]*width:\s*100%;/);
  assert.doesNotMatch(app, /const navigationBackDisabled = busy/);
  assert.match(app, /const navigationHomeDisabled = \(screen === "ready" && busy\)/);
});

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function occurrenceCount(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function assertSourceOrder(source, markers) {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker, previous + 1);
    assert.ok(current > previous, `expected ${marker} after the previous marker`);
    previous = current;
  }
}

test("kiosk latency phase 1 renders the next party screen before durable persistence", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const saveParty = sourceSection(app, "function saveParty()", "async function acceptGuidance()");
  const enqueue = sourceSection(app, "const enqueuePartyPersistence", "const waitForPartyBarrier");

  assert.match(app, /partyBarrierRef/);
  assert.match(app, /createPartyPersistenceCoordinator/);
  assert.match(app, /runPartyTransitionFirst/);
  assert.match(app, /enqueuePartyPersistence/);
  assert.match(app, /waitForPartyBarrier/);
  for (const stage of [
    "PARTY_CLICK",
    "PARTY_LOCAL_APPLIED",
    "PARTY_NEXT_SCREEN_SET",
    "DIFFICULTY_RENDER",
    "PARTY_BACKGROUND_START",
    "PARTY_API_DONE",
    "PARTY_BARRIER_DONE",
  ]) assert.match(app, new RegExp(stage));

  const localAppliedIndex = saveParty.indexOf("PARTY_LOCAL_APPLIED");
  const transitionMatch = /\bgo(?:Instant)?\(nextScreen/.exec(saveParty.slice(localAppliedIndex));
  const transition = transitionMatch ? { index: localAppliedIndex + transitionMatch.index } : null;
  assert.ok(transition, "party must set the next screen synchronously");
  assert.ok(saveParty.indexOf("PARTY_CLICK") < saveParty.indexOf("PARTY_LOCAL_APPLIED"));
  assert.ok(localAppliedIndex < transition.index);
  assert.ok(transition.index < saveParty.indexOf("enqueuePartyPersistence("));
  assert.ok(transition.index < saveParty.indexOf("PARTY_NEXT_SCREEN_SET", transition.index));
  const transitionPrefix = saveParty.slice(0, transition.index);
  assert.doesNotMatch(transitionPrefix, /await\s+(?:request|requireSessionToken|waitForPartyBarrier)/);
  assert.match(enqueue, /coordinator\.enqueue/);
  assertSourceOrder(enqueue, ["coordinator.enqueue", "PARTY_BACKGROUND_START", "requireSessionToken", 'action: "party"']);
});

test("party durable barrier blocks authoritative work and protects duplicate or stale generations", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const coordinator = await readFile(new URL("../app/kiosk/party-persistence.ts", import.meta.url), "utf8");
  const enqueue = sourceSection(app, "const enqueuePartyPersistence", "const waitForPartyBarrier");
  const wait = sourceSection(app, "const waitForPartyBarrier", "const cancelDraftWork");

  assert.match(enqueue, /partyBarrierRef\.current/);
  assert.match(enqueue, /signature|snapshot/);
  assert.match(coordinator, /current[\s\S]*inputKey[\s\S]*return current/);
  assert.match(coordinator, /activeGeneration/);
  assert.match(coordinator, /isGenerationActive/);
  assert.match(coordinator, /pending|promise/i);
  assert.match(wait, /await/);
  assert.match(coordinator, /status === "failed"[\s\S]*throw/);
  assert.match(app, /partyBarrierRef\.current\?\.reset\(flowGenerationRef\.current\)/);

  for (const name of ["chooseSlot", "chooseDifficulty", "login", "register", "addMember", "quote", "checkout"]) {
    const start = app.indexOf(`function ${name}`);
    assert.notEqual(start, -1, `missing ${name}`);
    const nextFunction = app.indexOf("\n  function ", start + 12);
    const nextAsyncFunction = app.indexOf("\n  async function ", start + 12);
    const ends = [nextFunction, nextAsyncFunction].filter((value) => value > start);
    const end = ends.length ? Math.min(...ends) : app.length;
    assert.match(app.slice(start, end), /waitForPartyBarrier/);
  }
});

test("party transition trigger completes before two seconds of durable persistence", async () => {
  const coordinator = createPartyPersistenceCoordinator(1);
  const events = [];
  const startedAt = performance.now();
  const ticket = runPartyTransitionFirst({
    applyLocal: () => events.push("local"),
    transition: () => events.push("next-screen"),
    enqueue: () => coordinator.enqueue({
      generation: 1,
      inputKey: "2:2:guide-v1",
      revision: 1,
      execute: async () => {
        events.push("party-start");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        events.push("party-done");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        events.push("guidance-done");
      },
    }),
  });

  assert.deepEqual(events, ["local", "next-screen"]);
  assert.ok(performance.now() - startedAt < 100, "screen transition must not wait for persistence");
  assert.equal(ticket.status, "pending");
  await ticket.promise;
  await coordinator.wait();
  assert.deepEqual(events, ["local", "next-screen", "party-start", "party-done", "guidance-done"]);
  assert.ok(performance.now() - startedAt >= 1_900, "artificial durable persistence must remain asynchronous");
});

test("party persistence failure is raised at the authoritative barrier", async () => {
  const coordinator = createPartyPersistenceCoordinator(3);
  const ticket = coordinator.enqueue({
    generation: 3,
    inputKey: "failed-party",
    revision: 4,
    execute: async () => { throw new Error("PARTY_SAVE_FAILED"); },
  });

  await ticket.promise;
  assert.equal(ticket.status, "failed");
  await assert.rejects(coordinator.wait(), /PARTY_SAVE_FAILED/);
});

test("party persistence coalesces an identical input into one mutation", async () => {
  const coordinator = createPartyPersistenceCoordinator(5);
  let mutationCount = 0;
  const task = {
    generation: 5,
    inputKey: "same-party-and-guidance-version",
    revision: 7,
    execute: async () => { mutationCount += 1; },
  };

  const first = coordinator.enqueue(task);
  const duplicate = coordinator.enqueue(task);
  assert.equal(duplicate, first);
  await coordinator.wait();
  assert.equal(mutationCount, 1);
});

test("party persistence ignores a stale completion after generation reset", async () => {
  const coordinator = createPartyPersistenceCoordinator(8);
  let release;
  let started;
  let staleApplied = false;
  const startSignal = new Promise((resolve) => { started = resolve; });
  const completionGate = new Promise((resolve) => { release = resolve; });
  const ticket = coordinator.enqueue({
    generation: 8,
    inputKey: "old-session",
    revision: 9,
    execute: async ({ isLatest }) => {
      started();
      await completionGate;
      if (isLatest()) staleApplied = true;
    },
  });

  await startSignal;
  coordinator.reset(9);
  release();
  await ticket.promise;
  assert.equal(ticket.status, "cancelled");
  assert.equal(staleApplied, false);
  await coordinator.wait();
});

test("difficulty transitions immediately to a neutral assigning screen and only success can show fastest", async () => {
  const app = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  const chooseDifficulty = sourceSection(app, "async function chooseDifficulty", "const addOns = useMemo");

  assert.match(app, /type Screen = [^;]*"assigning"/);
  for (const stage of [
    "DIFFICULTY_CLICK",
    "ASSIGNING_SCREEN_SET",
    "ASSIGNING_RENDER",
    "PARTY_BARRIER_WAIT_START",
    "PARTY_BARRIER_WAIT_DONE",
    "AUTO_ASSIGN_START",
    "AUTO_ASSIGN_DONE",
    "FASTEST_SCREEN_SET",
    "FASTEST_RENDER",
  ]) assert.match(app, new RegExp(stage));

  const assigningTransition = /\bgo(?:Instant)?\("assigning"/.exec(chooseDifficulty);
  const fastestTransition = /\b(?:go|goInstant|setScreen)\("fastest"/.exec(chooseDifficulty);
  assert.ok(assigningTransition, "difficulty must synchronously enter assigning");
  assert.ok(fastestTransition, "successful assignment must enter fastest");
  assert.ok(chooseDifficulty.indexOf("DIFFICULTY_CLICK") < assigningTransition.index);
  assert.ok(assigningTransition.index < chooseDifficulty.indexOf("ASSIGNING_SCREEN_SET"));
  const assignmentBarrierIndex = chooseDifficulty.indexOf("waitForPartyBarrier", assigningTransition.index);
  assert.ok(assigningTransition.index < assignmentBarrierIndex);
  assert.ok(assignmentBarrierIndex < chooseDifficulty.indexOf('action: "auto_assign"'));
  assert.ok(chooseDifficulty.indexOf("AUTO_ASSIGN_DONE") < fastestTransition.index);
  assert.ok(fastestTransition.index < chooseDifficulty.indexOf("FASTEST_SCREEN_SET"));

  const assigning = sourceSection(app, '{screen === "assigning"', '{screen === "benefits"');
  assert.match(assigning, /가장 빠른 방과 시간을 찾고 있어요/);
  assert.match(assigning, /다시 시도|다시 찾기/);
  assert.match(assigning, /난이도 다시 선택|난이도 선택으로 돌아가기|이전/);
  assert.doesNotMatch(assigning, /selectedRoom\}|selectedTime\}|assigned\.|latestSelectedGame|visit\?\.roomCode|visit\?\.scheduledTime/);

  const catchIndex = chooseDifficulty.indexOf("} catch (reason)", fastestTransition.index);
  const finallyIndex = chooseDifficulty.indexOf("finally", catchIndex);
  assert.ok(catchIndex > fastestTransition.index && finallyIndex > catchIndex);
  const catchBlock = chooseDifficulty.slice(catchIndex, finallyIndex);
  assert.doesNotMatch(catchBlock, /goInstant\("fastest"|go\("fastest"/);
});

test("auto assignment reuses one request context while retaining the exact-slot hold recheck", async () => {
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  const autoAssign = sourceSection(service, "export async function autoAssignKioskSlot", "export async function quoteKioskParticipantTopUp");

  assert.equal(occurrenceCount(autoAssign, /\bvisitForToken\(/g), 1);
  assert.equal(occurrenceCount(autoAssign, /\bapplyKioskDraftSnapshot\(/g), 1);
  assert.equal(occurrenceCount(autoAssign, /\bgetKioskAvailability\(/g), 1);
  assert.equal(occurrenceCount(autoAssign, /\brecheckKioskAutoAssignSlot\(/g), 1);
  assert.equal(occurrenceCount(autoAssign, /\breloadKioskVisit\(/g), 1);
  assert.doesNotMatch(autoAssign, /\bholdKioskSlot\(/);
  assert.doesNotMatch(autoAssign, /\bupdateKioskDifficulty\(/);
  assert.doesNotMatch(autoAssign, /\bgetKioskVisit\(/);

  assertSourceOrder(autoAssign, [
    "AUTO_ASSIGN_START",
    "AUTO_ASSIGN_CONTEXT_DONE",
    "AUTO_ASSIGN_PRECHECK_DONE",
    "AUTO_ASSIGN_HOLD_RECHECK_DONE",
    "AUTO_ASSIGN_HOLD_WRITE_DONE",
    "AUTO_ASSIGN_DIFFICULTY_DONE",
    "AUTO_ASSIGN_FINAL_HYDRATE_DONE",
    "AUTO_ASSIGN_DONE",
  ]);
  assert.match(autoAssign, /measureKioskStage\(trace, "AUTO_ASSIGN_HOLD_RECHECK_DONE", \(\) => recheckKioskAutoAssignSlot\(/);
});

test("auto assignment rejects stale draft revisions before availability or hold work", async () => {
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  const applyDraft = sourceSection(service, "async function applyKioskDraftSnapshot", "export async function syncKioskDraft");
  const autoAssign = sourceSection(service, "export async function autoAssignKioskSlot", "export async function quoteKioskParticipantTopUp");

  assert.match(applyDraft, /clientRevision < currentRevision[\s\S]+stale: true/);
  assert.match(applyDraft, /stale: clientRevision < latestRevision/);
  assert.match(applyDraft, /applied: false, stale: false/);
  assert.match(applyDraft, /applied: true, stale: false/);

  const staleGuard = /if \(input\.draft\)[\s\S]+requestedDraftVersion = clamp\(input\.draft\.clientRevision[\s\S]+context\.stale \|\| requestedDraftVersion < context\.draftVersion[\s\S]+KIOSK_DRAFT_STALE/.exec(autoAssign);
  assert.ok(staleGuard, "stale auto-assignment drafts must fail closed");
  assert.ok(autoAssign.indexOf("KIOSK_DRAFT_STALE") < autoAssign.indexOf("AUTO_ASSIGN_PRECHECK_DONE"));
  assert.ok(autoAssign.indexOf("KIOSK_DRAFT_STALE") < autoAssign.indexOf("getKioskAvailability"));
  assert.match(autoAssign, /if \(input\.draft\)/, "calls without an input draft must remain compatible");
});

test("auto assignment optimization preserves hold races, append games and difficulty mapping", async () => {
  const service = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  const autoAssign = sourceSection(service, "export async function autoAssignKioskSlot", "export async function quoteKioskParticipantTopUp");
  const recheck = sourceSection(service, "async function recheckKioskAutoAssignSlot", "export async function autoAssignKioskSlot");

  assert.match(recheck, /KIOSK_SLOT_OCCUPIED/);
  assert.match(recheck, /scheduled_time|scheduledTime/);
  assert.match(recheck, /room_code|roomCode/);
  assert.match(autoAssign, /appendGame/);
  assert.match(autoAssign, /existingGames\.results\.length >= 10/);
  assert.match(autoAssign, /active_slot_key/);
  assert.match(autoAssign, /status = 'CANCELLED'/);
  assert.match(autoAssign, /catch[\s\S]+KIOSK_SLOT_OCCUPIED/);
  assert.match(service, /roomCode === "B1" && roomSize === "MEDIUM"/);
  assert.match(service, /`b1-medium-\$\{normalizedBase\}`/);
  assert.match(service, /WHERE id = \? AND client_revision <= \?/);
  assert.match(service, /expireKioskRows/);
});

test("phase 1 keeps draft write-behind, quote transition-first and existing kiosk flows", async () => {
  const [app, route, service, payments] = await Promise.all([
    readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/payments.ts", import.meta.url), "utf8"),
  ]);

  const guest = sourceSection(app, "function asGuest()", "async function login()");
  const team = sourceSection(app, "function saveTeam", "async function chooseSlot");
  const quote = sourceSection(app, "async function quote(", "async function quoteParticipantTopUp");
  assertSourceOrder(guest, ["goInstant(", "queueDraftSnapshot("]);
  assertSourceOrder(team, ["goInstant(", "queueDraftSnapshot("]);
  assertSourceOrder(quote, ['goInstant(next, "quote_transition")', "waitForPartyBarrier", 'action: "quote"']);
  assert.match(app, /quotePending/);
  assert.match(app, /begin\("RESERVATION"\)/);
  assert.match(app, /begin\("REPEAT_GAME"\)/);
  assert.match(app, /begin\("PARTY_TOP_UP"\)/);
  assert.match(app, /appendGame: false/);
  assert.match(route, /action === "auto_assign"/);
  assert.match(route, /appendGame: body\.appendGame === true/);
  assert.match(service, /flow_type === "REPEAT_GAME"/);
  assert.match(service, /flow_type !== "PARTY_TOP_UP"/);
  assert.match(service, /customer_visit_games/);
  assert.match(payments, /CLOUD_FAST_LANE/);
  assert.match(payments, /UNKNOWN/);
});
