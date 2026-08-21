import { isAgentAuthorized } from "@/db/control";
import {
  completeLocalDirectPaymentResult,
  type SignedPaymentIntent,
} from "@/db/payment-intents";
import { ServerPaymentTrace } from "@/app/api/admin/payments/payment-trace";

type LocalResultBody = {
  intent?: SignedPaymentIntent;
  result?: unknown;
  localDurableAt?: string;
};

export async function POST(request: Request) {
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "인증이 필요합니다." }, { status: 401 });
  }
  try {
    const body = await request.json() as LocalResultBody;
    if (!body.intent || !body.result) {
      return Response.json({ error: "로컬 결제 결과가 올바르지 않습니다." }, { status: 400 });
    }
    const trace = new ServerPaymentTrace(request, body.intent.trace_id);
    trace.bind({
      action: "local_payment_result",
      reservationId: body.intent.reservation_id,
      paymentId: body.intent.payment_id,
      attemptId: body.intent.attempt_id,
    });
    trace.mark("CLOUD_RESULT_RECEIVED");
    const receipt = await completeLocalDirectPaymentResult({
      intent: body.intent,
      result: body.result,
      localDurableAt: body.localDurableAt,
      dbTrace: (query, durationMs, details) => trace.mark("PAYMENT_D1_QUERY", { query, ...details }, durationMs),
      stageTrace: (stage, details, durationMs) => trace.mark(stage, details, durationMs),
    });
    return trace.response(receipt as unknown as Record<string, unknown>);
  } catch (error) {
    const code = error instanceof Error ? error.message : "LOCAL_PAYMENT_SYNC_FAILED";
    const status = code.includes("NOT_FOUND") ? 404 : 409;
    return Response.json({ error: code }, { status });
  }
}
