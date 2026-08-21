import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("payment trace id crosses frontend, API, command payload and bridge ACK", async () => {
  const [frontend, api, payments, bridge, ack] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/api/admin/payments/route.ts", root), "utf8"),
    readFile(new URL("db/payments.ts", root), "utf8"),
    readFile(new URL("bridge/jumping_bridge.py", root), "utf8"),
    readFile(new URL("app/api/agent/ack/route.ts", root), "utf8"),
  ]);
  assert.match(frontend, /x-payment-trace-id/);
  assert.match(frontend, /FE_RENDER_DONE/);
  assert.match(api, /new ServerPaymentTrace/);
  assert.match(payments, /traceId,/);
  assert.match(bridge, /latencyEvents/);
  assert.match(ack, /recordPaymentLatencyEvents/);
});

test("instrumentation preserves duplicate and uncertain-result protections", async () => {
  const client = await readFile(new URL("bridge/mpos_lan/client.py", root), "utf8");
  const payments = await readFile(new URL("db/payments.ts", root), "utf8");
  assert.match(client, /Never resend here/);
  assert.match(client, /TransactionStatus\.UNKNOWN/);
  assert.match(payments, /PAYMENT_TERMINAL_BUSY/);
  assert.match(payments, /active_key = 'MPOS:ACTIVE'/);
  assert.match(payments, /ack_financial_durable_batch/);
  assert.match(payments, /durableStatements/);
});

test("latency report aggregates D1 query time and call counts", async () => {
  const report = await readFile(new URL("db/payment-latency.ts", root), "utf8");
  assert.match(report, /PAYMENT_D1_QUERY/);
  assert.match(report, /d1QueryTotalMs/);
  assert.match(report, /D1 QUERY BREAKDOWN/);
  assert.match(report, /maximumMs/);
  assert.match(report, /clickToRequestSentMs/);
  assert.match(report, /finalResponseToRenderMs/);
  assert.match(report, /workerRequests/);
});

test("payment plan optimization reuses loaded context and skips unrelated special-sale sync", async () => {
  const [payments, pricing] = await Promise.all([
    readFile(new URL("db/payments.ts", root), "utf8"),
    readFile(new URL("db/pricing-settings.ts", root), "utf8"),
  ]);
  assert.match(payments, /WITH allocated AS/);
  assert.match(payments, /payment_lookup/);
  assert.match(payments, /loadedContext\?: Awaited<ReturnType<typeof paymentContext>>/);
  assert.match(payments, /context\.reservation\.source === "member_pass_purchase"/);
  assert.match(payments, /context\.reservation\.source === "add_on_sale_purchase"/);
  assert.match(payments, /source === "member_pass_purchase" && \["PAID", "CANCELLED"\]\.includes\(wholeStatus\)/);
  assert.match(payments, /source === "add_on_sale_purchase" && \["PAID", "CANCELLED"\]\.includes\(wholeStatus\)/);
  assert.match(pricing, /let pricingSettingsSchemaReady: Promise<void> \| null = null/);
  assert.match(pricing, /pricingSettingsSchemaReady = initializePricingSettingsSchema\(\)\.catch/);
});

test("phase 2 publishes minimal next-split state before full overview reconciliation", async () => {
  const [frontend, waitRoute, payments, intents, localBridge, bridge] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/api/admin/payments/wait/route.ts", root), "utf8"),
    readFile(new URL("db/payments.ts", root), "utf8"),
    readFile(new URL("db/payment-intents.ts", root), "utf8"),
    readFile(new URL("bridge/local_payment_server.py", root), "utf8"),
    readFile(new URL("bridge/jumping_bridge.py", root), "utf8"),
  ]);
  assert.match(frontend, /view=minimal/);
  assert.match(frontend, /mergeMinimalPaymentProgress/);
  assert.match(frontend, /FULL_OVERVIEW_STALE_IGNORED/);
  assert.match(frontend, /UI_NEXT_SPLIT_READY/);
  assert.match(waitRoute, /minimal: true|minimal,/);
  assert.match(payments, /minimal_next_split_batch/);
  assert.match(payments, /ack_core_guard_batch/);
  assert.match(payments, /finalizationRequired && !progress\.finalizationReady/);
  assert.match(intents, /CORE_WRITE_DONE/);
  assert.match(intents, /NEXT_SPLIT_RESULT_READY/);
  assert.match(localBridge, /self\._sync_wakeup\.set\(\)/);
  assert.match(bridge, /wait_for_sync\(0\.5\)/);
  assert.doesNotMatch(frontend, /UI_NEXT_SPLIT_READY[\s\S]{0,300}action: "process"/);
});

test("payment results use an authenticated long-poll push lane with slow polling only as fallback", async () => {
  const [frontend, waitRoute, payments] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/api/admin/payments/wait/route.ts", root), "utf8"),
    readFile(new URL("db/payments.ts", root), "utf8"),
  ]);
  assert.match(frontend, /FE_RESULT_PUSH_START/);
  assert.match(frontend, /FE_RESULT_PUSH_DONE/);
  assert.match(frontend, /payments\/wait\?reservationId=/);
  assert.doesNotMatch(frontend, /hasProcessing \|\| overview\?\.payment\?\.fullCancelRequested \? 900/);
  assert.match(frontend, /if \(!paymentResultWait\.current\)/);
  assert.match(waitRoute, /getOperator\(\)/);
  assert.match(waitRoute, /waitForPaymentAttemptResult/);
  assert.match(payments, /PAYMENT_RESULT_WAIT_INTERVAL_MS = 200/);
  assert.match(payments, /\["PENDING", "PROCESSING"\]\.includes\(row\.status\)/);
});

test("round 3 starts payment in one idempotent endpoint and pushes sequential cancellation progress", async () => {
  const [frontend, api, waitRoute, payments] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/api/admin/payments/route.ts", root), "utf8"),
    readFile(new URL("app/api/admin/payments/wait/route.ts", root), "utf8"),
    readFile(new URL("db/payments.ts", root), "utf8"),
  ]);
  assert.match(frontend, /action: explicitExecution \? "prepare" : "start"/);
  assert.match(frontend, /transactionRequestKey: crypto\.randomUUID\(\)/);
  assert.match(api, /action === "prepare" \|\| action === "start"/);
  assert.match(api, /processPreparedPaymentTransaction/);
  assert.match(payments, /PAYMENT_REQUEST_KEY_CONFLICT/);
  assert.match(payments, /waitForFullCancellationProgress/);
  assert.match(waitRoute, /scope === "full-cancel"/);
  assert.match(frontend, /FE_FULL_CANCEL_PUSH_DONE/);
});

test("phase 1 local direct execution skips UI overview hydration for a subsequent split", async () => {
  const [api, intents, payments] = await Promise.all([
    readFile(new URL("app/api/admin/payments/route.ts", root), "utf8"),
    readFile(new URL("db/payment-intents.ts", root), "utf8"),
    readFile(new URL("db/payments.ts", root), "utf8"),
  ]);
  const subsequentStart = api.indexOf('if (action === "local_prepare_transaction")');
  const subsequentEnd = api.indexOf('if (action === "local_retry_prepare")', subsequentStart);
  const subsequentSegment = api.slice(subsequentStart, subsequentEnd);
  const intentStart = intents.indexOf("export async function prepareLocalDirectPaymentIntent");
  const intentEnd = intents.indexOf("export async function releaseLocalDirectPaymentIntent", intentStart);
  const intentSegment = intents.slice(intentStart, intentEnd);

  assert.ok(subsequentStart >= 0 && subsequentEnd > subsequentStart);
  assert.doesNotMatch(subsequentSegment, /getPaymentOverview/);
  assert.doesNotMatch(subsequentSegment, /\boverview\b/);
  assert.match(subsequentSegment, /splitPhase: "SUBSEQUENT"/);
  assert.match(intents, /loadPaymentIntentExecutionGuard/);
  assert.doesNotMatch(intentSegment, /getPaymentOverview/);
  assert.match(intents, /WHERE request_key = \? OR \(/);
  assert.match(payments, /export async function getPaymentExecutionContext/);
  assert.match(payments, /evaluatePaymentExecutionGuard/);
  assert.match(intents, /evaluatePaymentExecutionGuard/);
});

test("phase 1 preserves local direct guards and only caches successful short-lived health checks", async () => {
  const [frontend, intents] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("db/payment-intents.ts", root), "utf8"),
  ]);

  assert.match(frontend, /LOCAL_PAYMENT_HEALTH_CACHE_TTL_MS = 3_000/);
  assert.match(frontend, /localPaymentHealthCache\.current = \{/);
  assert.match(frontend, /LOCAL_HEALTH_START/);
  assert.match(frontend, /LOCAL_HEALTH_END/);
  assert.match(frontend, /cacheHit: true/);
  assert.match(frontend, /if \(result\.request_sent !== false\)/);
  assert.match(frontend, /action: "local_unknown"/);
  assert.match(intents, /PAYMENT_TRANSACTION_OUT_OF_ORDER/);
  assert.match(intents, /PAYMENT_TERMINAL_BUSY/);
  assert.match(intents, /PAYMENT_TRANSACTION_NOT_PENDING/);
  assert.match(intents, /intent_prepare_write_batch/);
});

test("phase 1.5 consolidates plan read-back while preserving authoritative intent validation", async () => {
  const [api, intents, payments] = await Promise.all([
    readFile(new URL("app/api/admin/payments/route.ts", root), "utf8"),
    readFile(new URL("db/payment-intents.ts", root), "utf8"),
    readFile(new URL("db/payments.ts", root), "utf8"),
  ]);
  const prepareStart = payments.indexOf("export async function preparePaymentPlan");
  const prepareEnd = payments.indexOf("async function executePaymentAttempt", prepareStart);
  const prepareSegment = payments.slice(prepareStart, prepareEnd);
  const intentStart = intents.indexOf("export async function prepareLocalDirectPaymentIntent");
  const intentEnd = intents.indexOf("export async function releaseLocalDirectPaymentIntent", intentStart);
  const intentSegment = intents.slice(intentStart, intentEnd);

  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
  assert.match(prepareSegment, /PLAN_IDEMPOTENCY_START/);
  assert.match(prepareSegment, /PAYMENT_CONTEXT_START/);
  assert.ok(
    prepareSegment.indexOf("PLAN_IDEMPOTENCY_START") < prepareSegment.indexOf("PAYMENT_CONTEXT_START"),
    "plan idempotency must remain before mutable payment context work",
  );
  assert.match(prepareSegment, /PLAN_WRITE_START/);
  assert.match(prepareSegment, /PLAN_READBACK_START/);
  assert.match(prepareSegment, /preparedPaymentContext/);
  assert.doesNotMatch(prepareSegment.slice(prepareSegment.indexOf("PLAN_WRITE_START")), /paymentContext\(/);
  assert.match(prepareSegment, /if \(!planMatches\) throw new Error\("PAYMENT_PLAN_STALE"\)/);
  assert.match(payments, /prepare_plan_readback_batch/);
  assert.match(intents, /PAYMENT_INTENT_SCHEMA_CHECK_SQL/);
  assert.match(intentSegment, /loadPaymentIntentExecutionGuard/);
  assert.match(intentSegment, /INTENT_SCHEMA_READY/);
  assert.match(intentSegment, /INTENT_CONTEXT_START/);
  assert.match(intentSegment, /INTENT_CONTEXT_DONE/);
  assert.match(intentSegment, /INTENT_BINDING_DONE/);
  assert.match(api, /stageTrace: \(stage, details, durationMs\) => trace\.mark/);
  assert.match(api, /API_RESPONSE_READY/);
});

test("phase 1.6 consolidates only the authoritative intent reads and keeps plan barriers", async () => {
  const [api, intents, payments, guards, migration] = await Promise.all([
    readFile(new URL("app/api/admin/payments/route.ts", root), "utf8"),
    readFile(new URL("db/payment-intents.ts", root), "utf8"),
    readFile(new URL("db/payments.ts", root), "utf8"),
    readFile(new URL("db/payment-wave-guards.ts", root), "utf8"),
    readFile(new URL("drizzle/0042_local_direct_payment_intents.sql", root), "utf8"),
  ]);
  const prepareStart = payments.indexOf("export async function preparePaymentPlan");
  const prepareEnd = payments.indexOf("async function executePaymentAttempt", prepareStart);
  const prepareSegment = payments.slice(prepareStart, prepareEnd);
  const intentStart = intents.indexOf("export async function prepareLocalDirectPaymentIntent");
  const intentEnd = intents.indexOf("export async function releaseLocalDirectPaymentIntent", intentStart);
  const intentSegment = intents.slice(intentStart, intentEnd);

  assert.match(prepareSegment, /READ_WAVE_START/);
  assert.match(prepareSegment, /PLAN_IDEMPOTENCY_START/);
  assert.match(prepareSegment, /if \(repeated\) \{/);
  assert.ok(
    prepareSegment.indexOf("if (repeated) {") < prepareSegment.indexOf("PAYMENT_CONTEXT_START"),
    "idempotency must be decided before mutable plan validation continues",
  );
  assert.match(prepareSegment, /nextAttemptNumber/);
  assert.match(prepareSegment, /PLAN_WRITE_START/);
  assert.match(prepareSegment, /PLAN_READBACK_START/);
  assert.match(payments, /preparedContext\.terminal/);
  assert.match(intents, /intent_execution_guard_batch/);
  assert.match(intentSegment, /intent_schema_guard/);
  assert.match(intentSegment, /INTENT_GUARD_START/);
  assert.match(intentSegment, /INTENT_GUARD_DONE/);
  assert.match(intentSegment, /evaluatePaymentExecutionGuard/);
  assert.match(intentSegment, /\["PENDING", "PARTIALLY_PAID"\]/);
  assert.match(intentSegment, /Number\.isSafeInteger\(attempt\.amount\)/);
  assert.doesNotMatch(intentSegment, /intent_ensure_schema/);
  assert.doesNotMatch(intents.slice(intents.indexOf("export async function ensurePaymentIntentSchema"), intents.indexOf("function rowToIntent")), /CREATE TABLE|CREATE INDEX/);
  assert.match(guards, /PAYMENT_INTENT_SCHEMA_CHECK_SQL/);
  assert.match(guards, /paymentIntentSchemaIsReady/);
  assert.match(migration, /payment_intents_status_expiry_idx/);
  assert.match(api, /LOCAL_PAYMENT_SCHEMA_INVALID/);
});
