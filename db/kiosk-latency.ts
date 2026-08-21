export type KioskLatencyEvent = {
  name: string;
  elapsedMs: number;
  atMs: number;
  rowsRead: number | null;
  rowsWritten: number | null;
  parallelGroup: string;
  ok: boolean;
};

export type KioskLatencyTrace = {
  traceId: string;
  action: string;
  startedAt: number;
  events: KioskLatencyEvent[];
};

function cleanTraceId(value: string) {
  return value.trim().replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 96);
}

export function createKioskLatencyTrace(traceId: string, action: string): KioskLatencyTrace {
  return {
    traceId: cleanTraceId(traceId) || `KIOSK-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    action: cleanTraceId(String(action || "unknown")).slice(0, 48) || "unknown",
    startedAt: performance.now(),
    events: [],
  };
}

function resultMeta(value: unknown) {
  if (!value || typeof value !== "object") return { rowsRead: null, rowsWritten: null };
  const meta = "meta" in value && value.meta && typeof value.meta === "object"
    ? value.meta as Record<string, unknown>
    : null;
  return {
    rowsRead: meta && Number.isFinite(Number(meta.rows_read)) ? Number(meta.rows_read) : null,
    rowsWritten: meta && Number.isFinite(Number(meta.rows_written)) ? Number(meta.rows_written) : null,
  };
}

export async function measureKioskStage<T>(
  trace: KioskLatencyTrace | undefined,
  name: string,
  operation: () => Promise<T>,
  parallelGroup = "",
): Promise<T> {
  if (!trace) return operation();
  const startedAt = performance.now();
  try {
    const result = await operation();
    const meta = resultMeta(result);
    const completedAt = performance.now();
    trace.events.push({
      name,
      elapsedMs: Math.round((completedAt - startedAt) * 10) / 10,
      atMs: Math.round((completedAt - trace.startedAt) * 10) / 10,
      rowsRead: meta.rowsRead,
      rowsWritten: meta.rowsWritten,
      parallelGroup,
      ok: true,
    });
    return result;
  } catch (error) {
    const completedAt = performance.now();
    trace.events.push({
      name,
      elapsedMs: Math.round((completedAt - startedAt) * 10) / 10,
      atMs: Math.round((completedAt - trace.startedAt) * 10) / 10,
      rowsRead: null,
      rowsWritten: null,
      parallelGroup,
      ok: false,
    });
    throw error;
  }
}

export function markKioskStage(trace: KioskLatencyTrace | undefined, name: string) {
  if (!trace) return;
  trace.events.push({
    name,
    elapsedMs: 0,
    atMs: Math.round((performance.now() - trace.startedAt) * 10) / 10,
    rowsRead: null,
    rowsWritten: null,
    parallelGroup: "checkpoint",
    ok: true,
  });
}

export function finishKioskLatencyTrace(trace: KioskLatencyTrace, status: number) {
  const totalMs = Math.round((performance.now() - trace.startedAt) * 10) / 10;
  console.info("[KIOSK_PERF]", JSON.stringify({
    traceId: trace.traceId,
    action: trace.action,
    status,
    totalMs,
    events: trace.events,
  }));
  return {
    traceId: trace.traceId,
    totalMs,
    serverTiming: [
      `kiosk;dur=${totalMs};desc="${trace.action}"`,
      ...trace.events.slice(0, 20).map((event, index) => `k${index};dur=${event.elapsedMs};desc="${event.name}"`),
    ].join(", "),
  };
}
