import { getOperator } from "@/app/operator";
import {
  waitForFullCancellationProgress,
  waitForPaymentAttemptResult,
} from "@/db/payments";
import { ServerPaymentTrace } from "../payment-trace";

function validUuid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

export async function GET(request: Request) {
  const trace = new ServerPaymentTrace(request);
  const operator = await getOperator();
  trace.mark("AUTH_DONE", { authenticated: Boolean(operator) });
  if (!operator) return trace.response({ error: "AUTH_REQUIRED" }, { status: 401 });

  const search = new URL(request.url).searchParams;
  const scope = search.get("scope") ?? "attempt";
  const reservationId = search.get("reservationId") ?? "";
  const attemptId = search.get("attemptId") ?? "";
  const minimal = search.get("view") === "minimal";
  trace.bind({
    action: scope === "full-cancel" ? "full_cancel_wait" : "result_wait",
    reservationId,
    attemptId,
  });
  if (
    !validUuid(reservationId) ||
    (scope === "attempt" && !validUuid(attemptId)) ||
    (scope === "full-cancel" && attemptId && !validUuid(attemptId)) ||
    !["attempt", "full-cancel"].includes(scope)
  ) {
    return trace.response({ error: "INVALID_PAYMENT_WAIT_REQUEST" }, { status: 400 });
  }

  try {
    const result = await trace.measure(
      "RESULT_WAIT_START",
      "RESULT_WAIT_DONE",
      () => (scope === "full-cancel"
        ? waitForFullCancellationProgress({
            reservationId,
            afterAttemptId: attemptId,
            timeoutMs: 15_000,
            dbTrace: (query, durationMs, details) => trace.mark(
              "PAYMENT_D1_QUERY",
              { query, ...details },
              durationMs,
            ),
          })
        : waitForPaymentAttemptResult({
            reservationId,
            attemptId,
            timeoutMs: 15_000,
            minimal,
            dbTrace: (query, durationMs, details) => trace.mark(
              "PAYMENT_D1_QUERY",
              { query, ...details },
              durationMs,
            ),
          })),
    );
    return trace.response(result as unknown as Record<string, unknown>, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return trace.response(
      { error: error instanceof Error ? error.message : "PAYMENT_RESULT_WAIT_FAILED" },
      { status: 400 },
    );
  }
}
