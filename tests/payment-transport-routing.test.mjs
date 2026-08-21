import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decidePaymentTransport } from "../app/payment-transport.ts";

const root = new URL("../", import.meta.url);

test("twenty consecutive healthy decisions stay on Local Direct", () => {
  for (let index = 0; index < 20; index += 1) {
    assert.equal(decidePaymentTransport({
      localDirectEnabled: true,
      browserLocalRequestPossible: true,
      localHealthHealthy: true,
      consecutiveHealthFailures: 0,
      localRequestSent: false,
      responseKnown: false,
    }), "LOCAL_DIRECT");
  }
});

test("twenty confirmed pre-send offline decisions stay on Cloud Fast Lane", () => {
  for (let index = 0; index < 20; index += 1) {
    assert.equal(decidePaymentTransport({
      localDirectEnabled: true,
      browserLocalRequestPossible: true,
      localHealthHealthy: false,
      consecutiveHealthFailures: 3,
      localRequestSent: false,
      responseKnown: false,
    }), "CLOUD_FAST_LANE");
  }
});

test("an ambiguous result after local send is UNKNOWN and never Cloud fallback", () => {
  assert.equal(decidePaymentTransport({
    localDirectEnabled: true,
    browserLocalRequestPossible: true,
    localHealthHealthy: true,
    consecutiveHealthFailures: 0,
    localRequestSent: true,
    responseKnown: false,
  }), "UNKNOWN");
  assert.equal(decidePaymentTransport({
    localDirectEnabled: true,
    browserLocalRequestPossible: true,
    localHealthHealthy: true,
    consecutiveHealthFailures: 0,
    localRequestSent: true,
    responseKnown: true,
  }), "LOCAL_DIRECT");
});

test("the production UI preserves one-click start while routing the final card click locally", async () => {
  const [adminSource, routeSource, intentSource] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/api/admin/payments/route.ts", root), "utf8"),
    readFile(new URL("db/payment-intents.ts", root), "utf8"),
  ]);
  const prepareStart = adminSource.indexOf("async function preparePlan()");
  const processStart = adminSource.indexOf("async function processTransaction", prepareStart);
  const cancelStart = adminSource.indexOf("async function cancelTransaction", processStart);
  const prepareSegment = adminSource.slice(prepareStart, processStart);
  const processSegment = adminSource.slice(processStart, cancelStart);

  assert.match(prepareSegment, /useLocalDirect/);
  assert.match(prepareSegment, /\? "local_prepare"/);
  assert.match(prepareSegment, /executeLocalDirectPayment\(intent, bridgeUrl\)/);
  assert.match(prepareSegment, /startAction === "start"/);
  assert.match(processSegment, /local_prepare_transaction/);
  assert.match(processSegment, /local_retry_prepare/);
  assert.match(adminSource, /action: "local_unknown"/);
  assert.doesNotMatch(adminSource, /LD_CLOUD_FALLBACK/);
  assert.match(routeSource, /TRANSPORT_DECISION/);
  assert.doesNotMatch(intentSource, /paymentExplicitExecutionV2Enabled\(\)/);
  assert.match(intentSource, /transport === "LOCAL_DIRECT"/);
});

test("Local Direct sync commits the financial ledger before retryable derived work", async () => {
  const [intentSource, paymentSource, resultRouteSource, bridgeSource] = await Promise.all([
    readFile(new URL("db/payment-intents.ts", root), "utf8"),
    readFile(new URL("db/payments.ts", root), "utf8"),
    readFile(new URL("app/api/agent/local-payment-result/route.ts", root), "utf8"),
    readFile(new URL("bridge/local_payment_server.py", root), "utf8"),
  ]);

  assert.match(intentSource, /completePaymentCommand\(row\.id, commandStatus, rawResult, undefined, \{ deferDerived: true \}\)/);
  assert.match(intentSource, /synced: false,[\s\S]*coreCommitted: true/);
  assert.match(intentSource, /completePaymentCommandDerived\(row\.id\)/);
  assert.match(paymentSource, /if \(options\?\.deferDerived\) return;/);
  assert.match(paymentSource, /export async function completePaymentCommandDerived/);
  assert.doesNotMatch(resultRouteSource, /getPaymentOverview|overview/);
  assert.match(bridgeSource, /LOCAL_PAYMENT_INTENT_INACTIVE/);
  assert.match(bridgeSource, /status = 'QUARANTINED'/);
  assert.match(bridgeSource, /response\.get\("synced"\) is False/);
});
