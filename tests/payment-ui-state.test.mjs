import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("saving reservation details keeps pending add-on and discount drafts", async () => {
  const adminSource = await readFile(
    new URL("app/admin/ReservationsAdmin.tsx", root),
    "utf8",
  );
  const quickModalStart = adminSource.indexOf("function QuickBookingModal");
  const saveStart = adminSource.indexOf("async function save()", quickModalStart);
  const saveEnd = adminSource.indexOf("async function mutate", saveStart);
  const saveSegment = adminSource.slice(saveStart, saveEnd);

  assert.ok(quickModalStart >= 0 && saveStart >= 0 && saveEnd > saveStart);
  assert.doesNotMatch(saveSegment, /setAddOnAmount\(saved\.addOnAmount\)/);
  assert.doesNotMatch(saveSegment, /setDiscountAmount\(saved\.discountAmount\)/);
});

test("payment execution switch preserves the current start path and adds an explicit confirm path", async () => {
  const adminSource = await readFile(
    new URL("app/admin/ReservationsAdmin.tsx", root),
    "utf8",
  );
  const prepareStart = adminSource.indexOf("async function preparePlan()");
  const processStart = adminSource.indexOf("async function processTransaction", prepareStart);
  const cancelStart = adminSource.indexOf("async function cancelTransaction", processStart);
  const prepareSegment = adminSource.slice(prepareStart, processStart);
  const processSegment = adminSource.slice(processStart, cancelStart);

  assert.doesNotMatch(prepareSegment, /window\.confirm/);
  assert.match(prepareSegment, /explicitExecution \? "prepare" : "start"/);
  assert.match(prepareSegment, /transactionRequestKey: crypto\.randomUUID\(\)/);
  assert.doesNotMatch(prepareSegment, /action: "process"/);
  assert.match(prepareSegment, /const preparedOverview = data\.overview \?\? data/);
  assert.match(prepareSegment, /if \(explicitExecution\) \{[\s\S]*setOverview\(preparedOverview\)[\s\S]*결제 방식이 확정되었습니다/);
  assert.match(prepareSegment, /const startedOverview = data\.attempt/);
  assert.match(prepareSegment, /setOverview\(startedOverview\)/);
  assert.match(prepareSegment, /if \(first\.paymentMethod !== "card"\) \{[\s\S]*await refresh\(\)/);
  assert.doesNotMatch(processSegment, /window\.confirm/);
  assert.match(adminSource, /primaryLabel/);
  assert.match(adminSource, /payment-primary-action/);
  assert.match(adminSource, /결제수단 선택/);
  assert.match(adminSource, /남은 결제금액/);
  assert.match(adminSource, /카드 결제 중/);
  assert.match(adminSource, /결제 완료/);
  assert.match(adminSource, /explicitExecution[\s\S]*결제 방식 확정/);
});

test("explicit payment execution is disabled unless the environment flag is enabled", async () => {
  const [controlSource, paymentSource] = await Promise.all([
    readFile(new URL("db/control.ts", root), "utf8"),
    readFile(new URL("db/payments.ts", root), "utf8"),
  ]);

  assert.match(controlSource, /PAYMENT_EXPLICIT_EXECUTION_V2\?: string/);
  assert.equal(controlSource.includes('/^(1|true|on|yes)$/i.test'), true);
  assert.match(paymentSource, /explicitExecutionV2Enabled: paymentExplicitExecutionV2Enabled\(\)/);
});

test("unchanged reservation details are not saved again before payment", async () => {
  const adminSource = await readFile(
    new URL("app/admin/ReservationsAdmin.tsx", root),
    "utf8",
  );

  assert.match(adminSource, /const hasUnsavedReservationChanges = Boolean/);
  assert.match(adminSource, /if \(hasUnsavedReservationChanges\) await persistDetails\(\)/);
});

test("Naver prepaid deposit is reflected before the payment overview finishes loading", async () => {
  const adminSource = await readFile(
    new URL("app/admin/ReservationsAdmin.tsx", root),
    "utf8",
  );

  assert.match(adminSource, /prepaidDepositAmount = 0/);
  assert.match(adminSource, /amount: Math\.max\(0, amount - initialDepositAmount\)/);
  assert.match(adminSource, /planLocked[\s\S]*summary\?\.depositAmount \?\? initialDepositAmount[\s\S]*Math\.min\(initialDepositAmount/);
  assert.match(adminSource, /prepaidDepositAmount=\{depositAmount\}/);
  assert.match(adminSource, /const unlockedPlanMismatch = Boolean/);
  assert.match(adminSource, /const visiblePlan = unlockedPlanMismatch \? \[\] : plan/);
  assert.match(adminSource, /reservation\.baseAmount !== amount/);
});

test("repeat games default to one shared payment while keeping each game visible", async () => {
  const adminSource = await readFile(
    new URL("app/admin/ReservationsAdmin.tsx", root),
    "utf8",
  );
  const apiSource = await readFile(
    new URL("app/api/admin/payments/route.ts", root),
    "utf8",
  );

  assert.match(adminSource, /data\.group\?\.eligible && data\.group\.items\.length > 1/);
  assert.match(adminSource, /reservationIds: groupSelectionActive/);
  assert.match(adminSource, /한판더 함께 결제/);
  assert.match(adminSource, /성인 \{item\.adultCount\}명 · 청소년 \{item\.youthCount\}명/);
  assert.match(apiSource, /reservationIds,/);
});

test("completed add-on checkout automatically returns to the product entry screen", async () => {
  const adminSource = await readFile(
    new URL("app/admin/ReservationsAdmin.tsx", root),
    "utf8",
  );
  const posSource = await readFile(
    new URL("app/admin/v2/PosV2.tsx", root),
    "utf8",
  );

  assert.match(adminSource, /settledSignature = useRef<string \| null>\(null\)/);
  assert.match(adminSource, /autoResetOnCompleted && completedNow/);
  assert.match(adminSource, /if \(!autoResetOnCompleted \|\| completedNow\) void onSettled\(\);/);
  assert.match(posSource, /autoResetOnCompleted onSettled=/);
  assert.match(posSource, /setAddOnReservation\(null\)/);
});

test("reservation checkout sends selected add-on products in the same payment plan", async () => {
  const adminSource = await readFile(
    new URL("app/admin/ReservationsAdmin.tsx", root),
    "utf8",
  );
  const paymentApi = await readFile(
    new URL("app/api/admin/payments/route.ts", root),
    "utf8",
  );
  const paymentsDb = await readFile(
    new URL("db/payments.ts", root),
    "utf8",
  );

  assert.match(adminSource, /부가상품 함께 결제/);
  assert.match(adminSource, /addOnSale=\{addOnSaleSelection\}/);
  assert.match(adminSource, /게임비와 합쳐 단말기에 한 번만 결제합니다/);
  assert.match(adminSource, /depositEligibleAmount = Math\.max\(0, grossPaymentAmount - catalogAddOnAmount\)/);
  assert.match(paymentApi, /addOnSale,/);
  assert.match(paymentsDb, /INSERT INTO add_on_sale_orders/);
  assert.match(paymentsDb, /ADD_ON_SALE_COUPON_EXCEEDS_GAME_FEE/);
});

test("terminal-direct approval import uses a reviewed manual flow and never requests a new card approval", async () => {
  const adminSource = await readFile(
    new URL("app/admin/ReservationsAdmin.tsx", root),
    "utf8",
  );
  const apiSource = await readFile(
    new URL("app/api/admin/payments/route.ts", root),
    "utf8",
  );

  assert.match(adminSource, /단말에서 이미 결제했어요/);
  assert.match(adminSource, /자동 조회 대신 승인전표를 확인해주세요/);
  assert.match(adminSource, /setExternalReviewed\(true\)/);
  assert.match(adminSource, /action: "record_external_approved"/);
  assert.match(adminSource, /단말 직접결제 · 운영자 수동 확인/);
  assert.match(adminSource, /action: "unlink_external_approved"/);
  assert.match(adminSource, /카드 승인은 취소되지 않았습니다/);
  assert.match(apiSource, /recordExternalApprovedPayment/);
  assert.match(apiSource, /unlinkExternalApprovedPayment/);
});

test("pass redemption refreshes the open reservation checkout and recalculates its remaining amount", async () => {
  const posSource = await readFile(
    new URL("app/admin/v2/PosV2.tsx", root),
    "utf8",
  );

  assert.match(posSource, /setRemoteSelection\(\(current\) => \{[\s\S]*reservationId = current\?\.reservation\?\.id[\s\S]*reservation: refreshed/);
  assert.match(posSource, /remoteSelection\.reservation\?\.discountAmount \?\? 0/);
  assert.match(posSource, /remoteSelection\.reservation\?\.paymentAmount \?\? 0/);
  assert.match(posSource, /if \(reservationId\) await load\(true\)/);
});

test("the terminal-direct approval button is shown only for a card payment", async () => {
  const adminSource = await readFile(
    new URL("app/admin/ReservationsAdmin.tsx", root),
    "utf8",
  );

  assert.match(adminSource, /const externalCardPaymentAvailable = currentPayment\?\.paymentMethod === "card"/);
  assert.match(adminSource, /!currentPayment && !planLocked && firstDraft\?\.paymentMethod === "card"/);
  assert.match(adminSource, /const completedPlanTopUpAvailable = Boolean/);
  assert.match(adminSource, /overview\?\.payment\?\.status === "PAID"/);
  assert.match(adminSource, /visiblePlan\.every\(\(payment\) => \["APPROVED", "COMPLETED"\]\.includes\(payment\.status\)\)/);
  assert.match(adminSource, /if \(!activeOverview\?\.payment\)/);
  assert.match(adminSource, /remainingAmount > 0 && !summary\?\.hasUnknown && externalCardPaymentAvailable/);
});

test("a failed split payment can change only the current retry method", async () => {
  const [adminSource, apiSource, paymentsDb] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/api/admin/payments/route.ts", root), "utf8"),
    readFile(new URL("db/payments.ts", root), "utf8"),
  ]);

  assert.match(adminSource, /결제수단 변경/);
  assert.match(adminSource, /앞서 승인된 회차는 그대로 유지됩니다/);
  assert.match(adminSource, /paymentMethod: effectivePaymentMethod/);
  assert.match(apiSource, /paymentMethod: requestedRetryPaymentMethod/);
  assert.match(paymentsDb, /PAYMENT_RETRY_METHOD_INVALID/);
  assert.match(paymentsDb, /requestedPaymentMethod/);
});

test("the current pending split can change method before any payment is executed", async () => {
  const [adminSource, apiSource, paymentsDb] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/api/admin/payments/route.ts", root), "utf8"),
    readFile(new URL("db/payments.ts", root), "utf8"),
  ]);

  assert.match(adminSource, /결제 전 수단 변경/);
  assert.match(adminSource, /수단만 변경하며 아직 결제 처리되지 않습니다/);
  assert.match(adminSource, /action: "change_method"/);
  assert.match(apiSource, /changePendingPaymentTransactionMethod/);
  assert.match(paymentsDb, /row\.status !== "PENDING" \|\| row\.command_id \|\| row\.active_key/);
  assert.match(paymentsDb, /PAYMENT_METHOD_CHANGE_NOT_ALLOWED/);
});

test("admin participant top-up appends new payment rounds without auto charging", async () => {
  const [adminSource, apiSource, paymentsDb] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/api/admin/payments/route.ts", root), "utf8"),
    readFile(new URL("db/payments.ts", root), "utf8"),
  ]);
  const componentStart = adminSource.indexOf("function ParticipantTopUpControls");
  const componentEnd = adminSource.indexOf("function nextOperatingSlot", componentStart);
  const component = adminSource.slice(componentStart, componentEnd);

  assert.ok(componentStart >= 0 && componentEnd > componentStart);
  assert.match(component, /게임 인원 추가 결제/);
  assert.match(component, /action: "prepare_participant_top_up"/);
  assert.match(component, /expectedAdultCount: reservation\.adultCount/);
  assert.match(component, /expectedYouthCount: reservation\.youthCount/);
  assert.match(component, /추가 결제 회차 만들기/);
  assert.doesNotMatch(component, /processPaymentTransaction|processTransaction\(/);
  assert.match(adminSource, /reservation\.paymentStatus === "paid" && !isClosed/);
  assert.match(adminSource, /hasUnsavedReservationChanges[\s\S]*!terminalAmountLocked/);
  assert.match(apiSource, /action === "prepare_participant_top_up"/);
  assert.match(apiSource, /prepareParticipantTopUpPlan/);
  assert.match(apiSource, /getReservationById\(reservationId\)/);
  assert.match(paymentsDb, /export async function prepareParticipantTopUpPlan/);
  assert.match(paymentsDb, /firstSplitIndex = context\.payment\.split_count \+ 1/);
});
