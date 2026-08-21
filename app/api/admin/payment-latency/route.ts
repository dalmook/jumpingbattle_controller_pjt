import { getOperator } from "@/app/operator";
import {
  listPaymentLatencyEvents,
  normalizePaymentTraceId,
  recordPaymentLatencyEvents,
  summarizePaymentLatencyEvents,
  type PaymentLatencyEvent,
} from "@/db/payment-latency";

function safeEvent(value: unknown, traceId: string): PaymentLatencyEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const component = String(input.component ?? "frontend");
  if (!(["frontend", "backend", "bridge", "mpos"] as string[]).includes(component)) return null;
  const stage = String(input.stage ?? "").trim().slice(0, 80);
  if (!stage) return null;
  const details = input.details && typeof input.details === "object" && !Array.isArray(input.details)
    ? input.details as Record<string, unknown>
    : {};
  return {
    traceId,
    component: component as PaymentLatencyEvent["component"],
    stage,
    isoTimestamp: String(input.isoTimestamp ?? new Date().toISOString()).slice(0, 80),
    elapsedMs: Number(input.elapsedMs) || 0,
    durationMs: input.durationMs == null ? null : Number(input.durationMs) || 0,
    reservationId: String(input.reservationId ?? "").slice(0, 100),
    paymentId: String(input.paymentId ?? "").slice(0, 100),
    attemptId: String(input.attemptId ?? "").slice(0, 100),
    details,
  };
}

export async function GET(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const traceId = normalizePaymentTraceId(new URL(request.url).searchParams.get("traceId"));
  if (!traceId) return Response.json({ error: "올바른 결제 추적 ID가 필요합니다." }, { status: 400 });
  const events = await listPaymentLatencyEvents(traceId);
  return Response.json({
    traceId,
    events,
    report: summarizePaymentLatencyEvents(events),
  });
}

export async function POST(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const body = await request.json() as Record<string, unknown>;
  const traceId = normalizePaymentTraceId(body.traceId);
  if (!traceId) return Response.json({ error: "올바른 결제 추적 ID가 필요합니다." }, { status: 400 });
  const events = (Array.isArray(body.events) ? body.events : [body.event])
    .map((event) => safeEvent(event, traceId))
    .filter((event): event is PaymentLatencyEvent => Boolean(event));
  await recordPaymentLatencyEvents(events);
  const stored = await listPaymentLatencyEvents(traceId);
  return Response.json({
    ok: true,
    accepted: events.length,
    report: summarizePaymentLatencyEvents(stored),
  });
}
