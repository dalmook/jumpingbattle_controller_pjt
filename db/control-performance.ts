type ControlPerfEvent = {
  stage: string;
  durationMs: number;
};

function safeStage(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "stage";
}

export function controlTraceId(commandId?: string) {
  const value = String(commandId ?? "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    ? `CTRL-${value}`
    : `STATE-${crypto.randomUUID()}`;
}

export class ControlPerformanceTrace {
  readonly traceId: string;
  readonly route: string;
  readonly startedAt = performance.now();
  readonly events: ControlPerfEvent[] = [];

  constructor(route: string, commandId?: string) {
    this.route = route;
    this.traceId = controlTraceId(commandId);
  }

  start() {
    return performance.now();
  }

  end(stage: string, startedAt: number) {
    this.events.push({
      stage: safeStage(stage),
      durationMs: Math.max(0, performance.now() - startedAt),
    });
  }

  headers() {
    const totalMs = Math.max(0, performance.now() - this.startedAt);
    return new Headers({
      "x-control-trace-id": this.traceId,
      "server-timing": [
        ...this.events.map(
          (event) => `${event.stage};dur=${event.durationMs.toFixed(3)}`,
        ),
        `total;dur=${totalMs.toFixed(3)}`,
      ].join(", "),
    });
  }

  log(details: Record<string, unknown> = {}) {
    console.info("[CONTROL PERF]", JSON.stringify({
      trace_id: this.traceId,
      route: this.route,
      iso_timestamp: new Date().toISOString(),
      total_ms: Number((performance.now() - this.startedAt).toFixed(3)),
      stages: Object.fromEntries(
        this.events.map((event) => [
          event.stage,
          Number(event.durationMs.toFixed(3)),
        ]),
      ),
      ...details,
    }));
  }
}

