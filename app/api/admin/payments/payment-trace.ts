import { getRequestExecutionContext } from "vinext/shims/request-context";
import {
  generatePaymentTraceId,
  normalizePaymentTraceId,
  recordPaymentLatencyEvents,
  type PaymentLatencyEvent,
} from "@/db/payment-latency";

let workerInstanceId = "";
let workerStartedAt = 0;
let workerRequestSequence = 0;

export class ServerPaymentTrace {
  readonly traceId: string;
  readonly startedAt: number;
  private readonly events: PaymentLatencyEvent[] = [];
  private reservationId = "";
  private paymentId = "";
  private attemptId = "";
  private action = "";
  private readonly requestId = crypto.randomUUID().slice(0, 8);
  private d1QueryCount = 0;
  private d1QueryDurationMs = 0;

  constructor(request: Request, explicitTraceId?: string) {
    if (!workerInstanceId) {
      workerInstanceId = crypto.randomUUID().slice(0, 8);
      workerStartedAt = performance.now();
    }
    this.traceId = normalizePaymentTraceId(explicitTraceId)
      || normalizePaymentTraceId(request.headers.get("x-payment-trace-id"))
      || generatePaymentTraceId();
    this.startedAt = performance.now();
    workerRequestSequence += 1;
    this.mark("API_RECEIVED", { method: request.method });
    this.mark("WORKER_REQUEST_CONTEXT", {
      workerInstanceId,
      workerRequestSequence,
      workerAgeMs: Math.round((performance.now() - workerStartedAt) * 1_000) / 1_000,
      coldCandidate: workerRequestSequence === 1,
    });
  }

  bind(values: { reservationId?: string; paymentId?: string; attemptId?: string; action?: string }) {
    if (values.reservationId) this.reservationId = values.reservationId;
    if (values.paymentId) this.paymentId = values.paymentId;
    if (values.attemptId) this.attemptId = values.attemptId;
    if (values.action) this.action = values.action;
  }

  mark(stage: string, details: Record<string, unknown> = {}, durationMs?: number) {
    if (stage === "PAYMENT_D1_QUERY") {
      this.d1QueryCount += 1;
      this.d1QueryDurationMs += Math.max(0, Number(durationMs) || 0);
    }
    const event: PaymentLatencyEvent = {
      traceId: this.traceId,
      component: "backend",
      stage,
      isoTimestamp: new Date().toISOString(),
      elapsedMs: Math.round((performance.now() - this.startedAt) * 1000) / 1000,
      durationMs: durationMs == null ? null : Math.round(durationMs * 1000) / 1000,
      reservationId: this.reservationId,
      paymentId: this.paymentId,
      attemptId: this.attemptId,
      details: {
        requestId: this.requestId,
        ...(this.action ? { action: this.action } : {}),
        ...details,
      },
    };
    this.events.push(event);
    console.info("[PAY TRACE]", JSON.stringify(event));
  }

  async measure<T>(startStage: string, doneStage: string, operation: () => Promise<T>, details: Record<string, unknown> = {}) {
    this.mark(startStage, details);
    const started = performance.now();
    try {
      const value = await operation();
      this.mark(doneStage, details, performance.now() - started);
      return value;
    } catch (error) {
      this.mark(`${doneStage}_ERROR`, {
        ...details,
        error: error instanceof Error ? error.message : String(error),
      }, performance.now() - started);
      throw error;
    }
  }

  response(payload: Record<string, unknown>, init?: ResponseInit) {
    this.mark("API_D1_SUMMARY", {
      queryCount: this.d1QueryCount,
      totalMs: Math.round(this.d1QueryDurationMs * 1_000) / 1_000,
    });
    const responsePayload = { ...payload, traceId: this.traceId };
    const responseBytes = new TextEncoder().encode(JSON.stringify(responsePayload)).byteLength;
    this.mark("API_RESPONSE_START", { status: init?.status ?? 200, responseBytes });
    const headers = new Headers(init?.headers);
    headers.set("x-payment-trace-id", this.traceId);
    const response = Response.json(responsePayload, { ...init, headers });
    this.mark("API_RESPONSE_DONE", { status: response.status, responseBytes });
    const write = recordPaymentLatencyEvents(this.events).catch((error) => {
      console.error("[PAY TRACE] latency persistence failed", error);
    });
    const context = getRequestExecutionContext();
    if (context) context.waitUntil(write);
    else void write;
    return response;
  }
}
