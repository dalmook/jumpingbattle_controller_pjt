import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = Promise.all([
  readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8"),
  readFile(new URL("../db/payments.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/kiosk/kiosk-home.css", import.meta.url), "utf8"),
]);

test("kiosk exposes checkout cancellation only before a transaction starts", async () => {
  const [app, route] = await files;
  assert.match(app, /paymentCanCancelBeforeExecution/);
  assert.match(app, /paymentPlan\.every\(\(item\) => item\.status === "PENDING"\)/);
  assert.match(app, /paymentHasUnknown/);
  assert.match(app, /paymentHasCompleted/);
  assert.match(app, /paymentIsProcessing/);
  assert.match(app, /action: "cancel_checkout"/);
  assert.match(app, /이미 완료된 결제가 있어요/);
  assert.match(app, /결제 결과를 확인하고 있어요/);
  assert.match(route, /action === "cancel_checkout"/);
  assert.match(route, /cancelKioskCheckout\(sessionToken\)/);
});

test("checkout cancellation is fail-closed for reservations, benefits and staff confirmation", async () => {
  const [, , service] = await files;
  const section = service.slice(
    service.indexOf("export async function cancelKioskCheckout"),
    service.indexOf("export type KioskDraftSnapshot"),
  );
  assert.match(section, /\["WALK_IN", "REPEAT_GAME", "ADD_ON_ONLY"\]/);
  assert.match(section, /KIOSK_CHECKOUT_CANCEL_UNSUPPORTED/);
  assert.match(section, /KIOSK_CHECKOUT_CANCEL_BENEFIT_APPLIED/);
  assert.match(section, /status !== "PAYMENT_PENDING"/);
  assert.match(section, /kiosk_bank_transfer_sessions|cancelUnstartedKioskPaymentPlan/);
  assert.match(section, /UPDATE kiosk_runtime SET current_visit_id = '', current_status = 'HOME'/);
  assert.match(section, /kiosk_checkout_cancelled/);
  assert.match(section, /CUSTOMER_CHECKOUT_CANCEL/);
  assert.doesNotMatch(section, /payment_cancel/);
});

test("payment execution and customer cancellation use competing guarded state changes", async () => {
  const [, , , payments] = await files;
  const execute = payments.slice(
    payments.indexOf("async function executePaymentAttempt"),
    payments.indexOf("export async function processPaymentTransaction"),
  );
  const cancel = payments.slice(
    payments.indexOf("export async function cancelUnstartedKioskPaymentPlan"),
    payments.indexOf("export async function changePendingPaymentTransactionMethod"),
  );

  assert.match(execute, /parent\.status IN \('PENDING', 'PARTIALLY_PAID'\)/);
  assert.match(execute, /INSERT INTO commands[\s\S]+SELECT[\s\S]+WHERE EXISTS/);
  assert.match(execute, /PAYMENT_COMMAND_QUEUE_CONFLICT/);

  assert.match(cancel, /UPDATE payments SET status = 'CANCELLED'/);
  assert.match(cancel, /pending\.status = 'PENDING'/);
  assert.match(cancel, /pending\.command_id IS NULL/);
  assert.match(cancel, /pending\.active_key IS NULL/);
  assert.match(cancel, /pending\.mpos_transaction_id IS NULL/);
  assert.match(cancel, /transfer\.status = 'ACTIVE'/);
  assert.match(cancel, /DELETE FROM payments WHERE id = \? AND status = 'CANCELLED'/);
  assert.doesNotMatch(cancel, /INSERT INTO commands|payment_cancel/);
});

test("portrait kiosk keeps the approved full-width layout and large navigation targets", async () => {
  const [, , , , css] = await files;
  assert.match(css, /\.home-operating \.home-primary-grid \{[\s\S]+grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.home-operating \.home-primary-grid \.home-card \{[\s\S]+aspect-ratio: 3 \/ 4/);
  assert.match(css, /\.game-confirm-card \{\s+max-width: none;/);
  assert.match(css, /\.payment-review-step \.review-card,[\s\S]+grid-column: 1 \/ -1;[\s\S]+grid-row: auto;/);
  assert.match(css, /\.identity-split \{[\s\S]+grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.team-vehicle-form,[\s\S]+grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.kiosk-bottom-nav > button \{[\s\S]+min-height: 108px;[\s\S]+font-size: 25px;/);
});
