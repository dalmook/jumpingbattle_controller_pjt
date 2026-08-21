import { getD1 } from "./control";

export const PAYMENT_TRACE_ID_PATTERN = /^PAY-\d{8}-\d{6}-[A-Z0-9]{6}$/;

export type PaymentLatencyEvent = {
  traceId: string;
  component: "frontend" | "backend" | "bridge" | "mpos";
  stage: string;
  isoTimestamp: string;
  elapsedMs: number;
  durationMs?: number | null;
  reservationId?: string;
  paymentId?: string;
  attemptId?: string;
  details?: Record<string, unknown>;
};

type PaymentLatencyRow = {
  trace_id: string;
  component: string;
  stage: string;
  iso_timestamp: string;
  elapsed_ms: number;
  duration_ms: number | null;
  reservation_id: string;
  payment_id: string;
  attempt_id: string;
  details_json: string;
  created_at: string;
};

function safeText(value: unknown, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

function safeMilliseconds(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(3_600_000, Math.round(parsed * 1000) / 1000));
}

export function normalizePaymentTraceId(value: unknown) {
  const traceId = safeText(value, 32).toUpperCase();
  return PAYMENT_TRACE_ID_PATTERN.test(traceId) ? traceId : "";
}

export function generatePaymentTraceId(now = new Date()) {
  const inSeoul = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const stamp = inSeoul.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `PAY-${stamp.slice(0, 8)}-${stamp.slice(8)}-${suffix}`;
}

export async function ensurePaymentLatencySchema() {
  const db = getD1();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS payment_latency_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        component TEXT NOT NULL,
        stage TEXT NOT NULL,
        iso_timestamp TEXT NOT NULL,
        elapsed_ms REAL NOT NULL DEFAULT 0,
        duration_ms REAL,
        reservation_id TEXT NOT NULL DEFAULT '',
        payment_id TEXT NOT NULL DEFAULT '',
        attempt_id TEXT NOT NULL DEFAULT '',
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS payment_latency_trace_stage_idx
      ON payment_latency_events(trace_id, id)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS payment_latency_created_idx
      ON payment_latency_events(created_at)
    `),
  ]);
}

export async function recordPaymentLatencyEvents(events: PaymentLatencyEvent[]) {
  const accepted = events
    .map((event) => ({ ...event, traceId: normalizePaymentTraceId(event.traceId) }))
    .filter((event) => event.traceId)
    .slice(0, 100);
  if (!accepted.length) return;

  await ensurePaymentLatencySchema();
  const db = getD1();
  await db.batch(accepted.map((event) => db.prepare(`
      INSERT INTO payment_latency_events (
        trace_id, component, stage, iso_timestamp, elapsed_ms, duration_ms,
        reservation_id, payment_id, attempt_id, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      event.traceId,
      ["frontend", "backend", "bridge", "mpos"].includes(event.component)
        ? event.component
        : "backend",
      safeText(event.stage, 80),
      safeText(event.isoTimestamp, 80) || new Date().toISOString(),
      safeMilliseconds(event.elapsedMs),
      event.durationMs == null ? null : safeMilliseconds(event.durationMs),
      safeText(event.reservationId, 100),
      safeText(event.paymentId, 100),
      safeText(event.attemptId, 100),
      JSON.stringify(event.details ?? {}).slice(0, 2_000),
    )));
}

export async function listPaymentLatencyEvents(traceId: string) {
  const normalized = normalizePaymentTraceId(traceId);
  if (!normalized) return [];
  await ensurePaymentLatencySchema();
  const result = await getD1().prepare(`
      SELECT trace_id, component, stage, iso_timestamp, elapsed_ms, duration_ms,
        reservation_id, payment_id, attempt_id, details_json, created_at
      FROM payment_latency_events WHERE trace_id = ? ORDER BY id
    `).bind(normalized).all<PaymentLatencyRow>();
  return result.results.map((row) => ({
    traceId: row.trace_id,
    component: row.component,
    stage: row.stage,
    isoTimestamp: row.iso_timestamp,
    elapsedMs: Number(row.elapsed_ms) || 0,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms) || 0,
    reservationId: row.reservation_id,
    paymentId: row.payment_id,
    attemptId: row.attempt_id,
    details: (() => {
      try {
        return JSON.parse(row.details_json) as Record<string, unknown>;
      } catch {
        return {};
      }
    })(),
    createdAt: row.created_at,
  }));
}

type ListedPaymentLatencyEvent = Awaited<ReturnType<typeof listPaymentLatencyEvents>>[number];

function latestElapsed(events: ListedPaymentLatencyEvent[], component: string, stage: string) {
  return events
    .filter((event) => event.component === component && event.stage === stage)
    .reduce((maximum, event) => Math.max(maximum, event.elapsedMs), 0);
}

function maximumDuration(events: ListedPaymentLatencyEvent[], stage: string) {
  return events
    .filter((event) => event.stage === stage)
    .reduce((maximum, event) => Math.max(maximum, event.durationMs ?? 0), 0);
}

function firstStageEvent(events: ListedPaymentLatencyEvent[], stage: string) {
  return events.find((event) => event.stage === stage) ?? null;
}

function firstQueryEvent(events: ListedPaymentLatencyEvent[], query: string) {
  return events.find(
    (event) => event.stage === "PAYMENT_D1_QUERY" && event.details?.query === query,
  ) ?? null;
}

function observedWallClockDelta(
  start: ListedPaymentLatencyEvent | null,
  end: ListedPaymentLatencyEvent | null,
) {
  if (!start || !end) return 0;
  const startMs = Date.parse(start.isoTimestamp);
  const endMs = Date.parse(end.isoTimestamp);
  const durationMs = endMs - startMs;
  return Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= 300_000
    ? Math.round(durationMs * 1_000) / 1_000
    : 0;
}

export function summarizePaymentLatencyEvents(events: ListedPaymentLatencyEvent[]) {
  const traceId = events[0]?.traceId ?? "";
  const totalMs = latestElapsed(events, "frontend", "FE_RENDER_DONE");
  const clickToRequestSentMs = observedWallClockDelta(
    firstStageEvent(events, "FE_CLICK"),
    firstStageEvent(events, "PAY_REQUEST_SENT"),
  );
  const finalResponseToRenderMs = observedWallClockDelta(
    firstStageEvent(events, "PAY_FINAL_RESPONSE"),
    firstStageEvent(events, "FE_RENDER_DONE"),
  );
  const commandQueueToClaimMs = observedWallClockDelta(
    firstStageEvent(events, "BRIDGE_COMMAND_QUEUED"),
    firstStageEvent(events, "PAYMENT_FAST_LANE_CLAIMED"),
  );
  const bridgeReceiptToSentMs = observedWallClockDelta(
    firstStageEvent(events, "BRIDGE_REQUEST_RECEIVED"),
    firstStageEvent(events, "PAY_REQUEST_SENT"),
  );
  const finalResponseToDurableMs = observedWallClockDelta(
    firstStageEvent(events, "PAY_FINAL_RESPONSE"),
    firstQueryEvent(events, "ack_financial_durable_batch"),
  );
  const durableToRenderMs = observedWallClockDelta(
    firstQueryEvent(events, "ack_financial_durable_batch"),
    firstStageEvent(events, "FE_RENDER_DONE"),
  );
  const transactionMs = maximumDuration(events, "FIRST_DEVICE_RESPONSE");
  const bridgeMs = latestElapsed(events, "bridge", "BRIDGE_RESPONSE_START");
  const syncRttMs = maximumDuration(events, "BRIDGE_SYNC_HTTP_ROUND_TRIP");
  const fdkCreateMs = maximumDuration(events, "FDK_CREATE_DONE");
  const fdkInputMs = maximumDuration(events, "FDK_INPUT_TOTAL");
  const fdkOutputMs = maximumDuration(events, "FDK_OUTPUT_TOTAL");
  const fdkDestroyMs = maximumDuration(events, "FDK_DESTROY");
  const backendDbMs = maximumDuration(events, "PAYMENT_DB_SAVE_DONE");
  const d1QueryEvents = events.filter(
    (event) => event.component === "backend" && event.stage === "PAYMENT_D1_QUERY",
  );
  const d1QuerySummary = Array.from(d1QueryEvents.reduce((summary, event) => {
    const query = safeText(event.details?.query, 120) || "unknown";
    const current = summary.get(query) ?? {
      query,
      calls: 0,
      durationMs: 0,
      maximumMs: 0,
      rowsRead: 0,
      rowsWritten: 0,
      unmeasuredRows: 0,
    };
    const durationMs = event.durationMs ?? 0;
    current.calls += 1;
    current.durationMs += durationMs;
    current.maximumMs = Math.max(current.maximumMs, durationMs);
    const hasRowsRead = event.details?.rowsRead != null;
    const hasRowsWritten = event.details?.rowsWritten != null;
    const rowsRead = Number(event.details?.rowsRead);
    const rowsWritten = Number(event.details?.rowsWritten);
    if (hasRowsRead && Number.isFinite(rowsRead)) current.rowsRead += Math.max(0, rowsRead);
    else current.unmeasuredRows += 1;
    if (hasRowsWritten && Number.isFinite(rowsWritten)) current.rowsWritten += Math.max(0, rowsWritten);
    summary.set(query, current);
    return summary;
  }, new Map<string, {
    query: string;
    calls: number;
    durationMs: number;
    maximumMs: number;
    rowsRead: number;
    rowsWritten: number;
    unmeasuredRows: number;
  }>()).values())
    .map((item) => ({
      ...item,
      durationMs: Math.round(item.durationMs * 1_000) / 1_000,
      maximumMs: Math.round(item.maximumMs * 1_000) / 1_000,
      totalMs: Math.round(item.durationMs * 1_000) / 1_000,
      averageMs: Math.round((item.durationMs / Math.max(1, item.calls)) * 1_000) / 1_000,
      maxMs: Math.round(item.maximumMs * 1_000) / 1_000,
    }))
    .sort((a, b) => b.durationMs - a.durationMs);
  const d1QueryTotalMs = Math.round(
    d1QueryEvents.reduce((sum, event) => sum + (event.durationMs ?? 0), 0) * 1_000,
  ) / 1_000;
  const frontendApiMs = events
    .filter((event) => event.component === "frontend" && event.stage === "FE_API_RESPONSE_BODY")
    .reduce((sum, event) => sum + (event.durationMs ?? 0), 0);
  const frontendApiCalls = events
    .filter((event) => event.component === "frontend" && event.stage === "FE_API_RESPONSE_BODY")
    .map((event) => ({
      sequence: Number(event.details?.apiCallSequence) || 0,
      action: safeText(event.details?.action, 80) || "unknown",
      url: safeText(event.details?.url, 200) || "/api/admin/payments",
      method: safeText(event.details?.method, 12) || "POST",
      elapsedMs: Math.round((event.durationMs ?? 0) * 1_000) / 1_000,
      requestBytes: Math.max(0, Number(event.details?.requestBytes) || 0),
      responseBytes: Math.max(0, Number(event.details?.responseBytes) || 0),
    }))
    .sort((left, right) => left.sequence - right.sequence);
  const workerRequests = events
    .filter((event) => event.component === "backend" && event.stage === "WORKER_REQUEST_CONTEXT")
    .map((event) => {
      const requestId = safeText(event.details?.requestId, 40);
      const response = events.find((candidate) =>
        candidate.component === "backend" &&
        candidate.stage === "API_RESPONSE_DONE" &&
        safeText(candidate.details?.requestId, 40) === requestId);
      const actionEvent = events.find((candidate) =>
        candidate.component === "backend" &&
        safeText(candidate.details?.requestId, 40) === requestId &&
        safeText(candidate.details?.action, 80));
      return {
        requestId,
        action: safeText(actionEvent?.details?.action, 80) || "unknown",
        workerInstanceId: safeText(event.details?.workerInstanceId, 40),
        workerRequestSequence: Math.max(0, Number(event.details?.workerRequestSequence) || 0),
        workerAgeMs: Math.max(0, Number(event.details?.workerAgeMs) || 0),
        coldCandidate: Boolean(event.details?.coldCandidate),
        backendElapsedMs: Math.max(0, response?.elapsedMs ?? 0),
      };
    });
  const browserApiBridgeMs = totalMs > 0 && transactionMs > 0
    ? Math.max(0, totalMs - transactionMs)
    : 0;
  const candidates = [
    ["Device/VAN (FDK Execute)", transactionMs],
    ["Frontend API round trips", frontendApiMs],
    ["Payment command queue to Fast Lane claim", commandQueueToClaimMs],
    ["FDK Create", fdkCreateMs],
    ["FDK Input", fdkInputMs],
    ["FDK Output", fdkOutputMs],
    ["FDK Destroy", fdkDestroyMs],
    ["Backend payment DB save", backendDbMs],
  ] as Array<[string, number]>;
  const topBottlenecks = candidates
    .filter(([, durationMs]) => durationMs > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([stage, durationMs]) => ({
      stage,
      durationMs: Math.round(durationMs * 1_000) / 1_000,
      percent: totalMs > 0 ? Math.round((durationMs / totalMs) * 10_000) / 100 : null,
    }));
  const seconds = (milliseconds: number) => (milliseconds / 1_000).toFixed(3);
  const text = [
    "============================================",
    "MPOS PAYMENT LATENCY REPORT",
    "============================================",
    `TRACE: ${traceId || "-"}`,
    `TOTAL: ${totalMs ? `${seconds(totalMs)} sec` : "pending frontend completion"}`,
    `Click to PAY_REQUEST_SENT: ${clickToRequestSentMs ? `${seconds(clickToRequestSentMs)} sec` : "pending"}`,
    `PAY_FINAL_RESPONSE to FE_RENDER_DONE: ${finalResponseToRenderMs ? `${seconds(finalResponseToRenderMs)} sec` : "pending"}`,
    `Command queued to Fast Lane claim: ${commandQueueToClaimMs ? `${seconds(commandQueueToClaimMs)} sec` : "pending"}`,
    `Bridge receipt to PAY_REQUEST_SENT: ${bridgeReceiptToSentMs ? `${seconds(bridgeReceiptToSentMs)} sec` : "pending"}`,
    `PAY_FINAL_RESPONSE to durable financial commit: ${finalResponseToDurableMs ? `${seconds(finalResponseToDurableMs)} sec` : "pending"}`,
    `Durable financial commit to FE_RENDER_DONE: ${durableToRenderMs ? `${seconds(durableToRenderMs)} sec` : "pending"}`,
    `Browser/API/Bridge combined: ${browserApiBridgeMs ? `${seconds(browserApiBridgeMs)} sec` : "pending"}`,
    `KPN/MPOS/VAN (FDK Execute): ${transactionMs ? `${seconds(transactionMs)} sec` : "pending"}`,
    `Bridge local total: ${bridgeMs ? `${seconds(bridgeMs)} sec` : "pending"}`,
    `Payment D1 query total: ${d1QueryTotalMs ? `${seconds(d1QueryTotalMs)} sec` : "pending"}`,
    "D1 QUERY BREAKDOWN:",
    ...d1QuerySummary.slice(0, 10).map((item, index) =>
      `${index + 1}. ${item.query} ${seconds(item.totalMs)} sec (${item.calls} call${item.calls === 1 ? "" : "s"}, avg ${item.averageMs.toFixed(3)} ms, max ${seconds(item.maxMs)} sec, read ${item.rowsRead}, wrote ${item.rowsWritten})`,
    ),
    "TOP BOTTLENECKS:",
    ...topBottlenecks.map((item, index) =>
      `${index + 1}. ${item.stage} ${seconds(item.durationMs)} sec${item.percent == null ? "" : ` (${item.percent}%)`}`,
    ),
    "============================================",
  ].join("\n");
  return {
    traceId,
    totalMs,
    clickToRequestSentMs,
    finalResponseToRenderMs,
    commandQueueToClaimMs,
    bridgeReceiptToSentMs,
    finalResponseToDurableMs,
    durableToRenderMs,
    transactionMs,
    browserApiBridgeMs,
    bridgeMs,
    frontendApiMs,
    frontendApiCalls,
    workerRequests,
    syncRttMs,
    fdkCreateMs,
    fdkInputMs,
    fdkOutputMs,
    fdkDestroyMs,
    backendDbMs,
    d1QueryTotalMs,
    d1QuerySummary,
    topBottlenecks,
    text,
    note: "프로세스 내부 수치는 monotonic duration입니다. Click→단말 및 단말→렌더 구간만 동일 매장 PC의 브라우저/브릿지 ISO 시각을 관측값으로 함께 표시합니다. Bridge sync HTTP는 명령을 기다리는 long-poll 전체 RTT라 다른 구간과 겹치므로 병목 순위에 합산하지 않습니다.",
  };
}
