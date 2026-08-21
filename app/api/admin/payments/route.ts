import { getOperator } from "@/app/operator";
import { dateInSeoul } from "@/app/reservation-config";
import { getD1 } from "@/db/control";
import {
  changePendingPaymentTransactionMethod,
  deleteCancelledPaymentRecord,
  getPaymentOverview,
  getPaymentTerminalState,
  listPaymentHistory,
  prepareParticipantTopUpPlan,
  preparePaymentPlan,
  preparePaymentTransactionRetry,
  processPreparedPaymentTransaction,
  processPaymentTransaction,
  recordExternalApprovedPayment,
  reconcileUnknownPayment,
  requestFullPaymentCancellation,
  requestPaymentCancellation,
  requestTerminalStatus,
  retryPaymentTransaction,
  unlinkExternalApprovedPayment,
} from "@/db/payments";
import {
  paymentPlanMatchesLedger,
  type PaymentPlanMode,
} from "@/db/payment-ledger";
import { supportsPaymentCommands } from "@/db/bridge-capabilities";
import { ServerPaymentTrace } from "./payment-trace";
import {
  markLocalDirectPaymentUnknown,
  paymentTransportConfiguration,
  prepareLocalDirectPaymentIntent,
  releaseLocalDirectPaymentIntent,
} from "@/db/payment-intents";
import { getReservationById } from "@/db/reservations";

function validReservationId(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function safeAmount(value: unknown) {
  const amount = Math.trunc(Number(value));
  return Number.isFinite(amount)
    ? Math.max(0, Math.min(10_000_000, amount))
    : 0;
}

async function agentOnline() {
  const rows = await getD1()
    .prepare(`
      SELECT version FROM agents
      WHERE last_seen > datetime('now', '-25 seconds')
      ORDER BY last_seen DESC
    `)
    .all<{ version: string }>();
  return rows.results.some((row) => supportsPaymentCommands(row.version));
}

async function ensureCardReady() {
  const [online, terminal] = await Promise.all([
    agentOnline(),
    getPaymentTerminalState(),
  ]);
  if (!online) throw new Error("PAYMENT_AGENT_OFFLINE");
  if (!terminal.connected || !terminal.paymentReady) {
    throw new Error("PAYMENT_TERMINAL_NOT_READY");
  }
  return terminal;
}

export async function GET(request: Request) {
  const operator = await getOperator();
  if (!operator) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const search = new URL(request.url).searchParams;
  if (search.get("scope") === "history") {
    const date = search.get("date") ?? dateInSeoul();
    try {
      return Response.json({
        payments: await listPaymentHistory({ date, query: search.get("query") ?? "" }),
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "결제 내역을 불러오지 못했습니다." },
        { status: 400 },
      );
    }
  }
  const reservationId = search.get("reservationId") ?? "";
  if (reservationId && !validReservationId(reservationId)) {
    return Response.json({ error: "예약 번호가 올바르지 않습니다." }, { status: 400 });
  }
  try {
    const overview = await getPaymentOverview(reservationId);
    const transport = paymentTransportConfiguration();
    return Response.json({
      ...overview,
      paymentTransport: transport.transport,
      localDirectEnabled: transport.localDirectEnabled,
      localBridgeUrl: transport.bridgeUrl,
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error
          ? error.message
          : "결제 상태를 불러오지 못했습니다.",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const operator = await getOperator();
  if (!operator) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const reservationId = String(body.reservationId ?? "");
    if (!validReservationId(reservationId)) {
      return Response.json({ error: "예약 번호가 올바르지 않습니다." }, { status: 400 });
    }
    return Response.json(await deleteCancelledPaymentRecord({
      reservationId,
      requestedBy: operator.email,
    }));
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const messages: Record<string, string> = {
      PAYMENT_PLAN_NOT_FOUND: "삭제할 결제 내역을 찾지 못했습니다.",
      PAYMENT_DELETE_BLOCKED: "처리 중이거나 확인이 필요한 거래는 삭제할 수 없습니다.",
      PAYMENT_DELETE_REQUIRES_CANCELLATION: "결제를 먼저 취소한 뒤 내역을 삭제해주세요.",
      PASS_PURCHASE_PARTIALLY_USED: "이미 사용한 다회권 구매 내역은 삭제할 수 없습니다.",
    };
    return Response.json(
      { error: messages[code] ?? (code || "결제 내역을 삭제하지 못했습니다.") },
      { status: 409 },
    );
  }
}

export async function POST(request: Request) {
  const trace = new ServerPaymentTrace(request);
  const operator = await getOperator();
  trace.mark("AUTH_DONE", { authenticated: Boolean(operator) });
  if (!operator) {
    return trace.response({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const body = await trace.measure(
      "REQUEST_VALIDATION_START",
      "REQUEST_VALIDATION_DONE",
      async () => await request.json() as Record<string, unknown>,
    );
    const action = String(body.action ?? "");
    trace.bind({ action });
    trace.mark("ACTION_RESOLVED", { action });
    if (action === "status") {
      const online = await trace.measure(
        "PAYMENT_DB_LOOKUP_START",
        "PAYMENT_DB_LOOKUP_DONE",
        agentOnline,
        { lookup: "agent_online" },
      );
      if (!online) throw new Error("PAYMENT_AGENT_OFFLINE");
      const status = await trace.measure(
        "BRIDGE_REQUEST_START",
        "BRIDGE_COMMAND_QUEUED",
        () => requestTerminalStatus(operator.email, trace.traceId),
        { action },
      );
      return trace.response(status as unknown as Record<string, unknown>, { status: 202 });
    }

    const reservationId = String(body.reservationId ?? "");
    trace.bind({ reservationId });
    if (!validReservationId(reservationId)) {
      return trace.response({ error: "예약 번호가 올바르지 않습니다." }, { status: 400 });
    }
    const requestKey = String(body.requestKey ?? "");

    if (action === "prepare_participant_top_up") {
      const mode = ["single", "equal", "custom"].includes(String(body.mode))
        ? (String(body.mode) as PaymentPlanMode)
        : "single";
      const items = Array.isArray(body.items)
        ? body.items.map((item) => {
            const candidate = item && typeof item === "object"
              ? (item as Record<string, unknown>)
              : {};
            return {
              amount: safeAmount(candidate.amount),
              paymentMethod: String(candidate.paymentMethod ?? "card"),
            };
          })
        : undefined;
      const overview = await trace.measure(
        "PAYMENT_DB_SAVE_START",
        "PAYMENT_DB_SAVE_DONE",
        () => prepareParticipantTopUpPlan({
          reservationId,
          expectedAdultCount: safeAmount(body.expectedAdultCount),
          expectedYouthCount: safeAmount(body.expectedYouthCount),
          additionalAdultCount: safeAmount(body.additionalAdultCount),
          additionalYouthCount: safeAmount(body.additionalYouthCount),
          mode,
          count: Math.max(1, Math.min(20, Math.trunc(Number(body.count) || 1))),
          paymentMethod: String(body.paymentMethod ?? "card"),
          items,
          requestKey,
          requestedBy: operator.email,
          traceId: trace.traceId,
        }),
        { action },
      );
      const updatedReservation = await getReservationById(reservationId);
      if (!updatedReservation) throw new Error("RESERVATION_NOT_FOUND");
      trace.bind({ paymentId: overview.payment?.id });
      return trace.response({
        overview,
        reservation: updatedReservation,
      }, { status: 201 });
    }

    if (action === "local_prepare_transaction") {
      const transport = paymentTransportConfiguration();
      if (!transport.localDirectEnabled) throw new Error("LOCAL_PAYMENT_DISABLED");
      const transactionId = String(body.transactionId ?? "");
      await trace.measure(
        "CARD_READY_DB_CHECK_START",
        "CARD_READY_DB_CHECK_DONE",
        () => ensureCardReady(),
      );
      const intent = await trace.measure(
        "LOCAL_INTENT_PREPARE_START",
        "LOCAL_INTENT_READY",
        () => prepareLocalDirectPaymentIntent({
          reservationId,
          attemptId: transactionId,
          requestKey,
          requestedBy: operator.email,
          traceId: trace.traceId,
          splitPhase: "SUBSEQUENT",
          stageTrace: (stage, details, durationMs) => trace.mark(stage, details, durationMs),
          dbTrace: (query, durationMs, details) => trace.mark(
            "PAYMENT_D1_QUERY",
            { query, ...details },
            durationMs,
          ),
        }),
        { splitPhase: "SUBSEQUENT" },
      );
      trace.bind({ paymentId: intent.payment_id, attemptId: intent.attempt_id });
      trace.mark("TRANSPORT_DECISION", {
        transactionUuid: intent.transaction_uuid,
        selectedTransport: "LOCAL_DIRECT",
        localHealth: String(body.localHealth ?? "HEALTHY"),
        localLatencyMs: safeAmount(body.localLatencyMs),
        failureCount: safeAmount(body.localFailureCount),
        featureFlag: transport.transport,
        browserLocalRequestPossible: true,
      });
      return trace.response({
        paymentTransport: transport.transport,
        localDirectEnabled: true,
        localBridgeUrl: transport.bridgeUrl,
        intent,
      }, { status: 201 });
    }

    if (action === "local_retry_prepare") {
      const transport = paymentTransportConfiguration();
      if (!transport.localDirectEnabled) throw new Error("LOCAL_PAYMENT_DISABLED");
      const paymentMethod = String(body.paymentMethod ?? "card").trim().toLowerCase();
      if (paymentMethod !== "card") throw new Error("LOCAL_PAYMENT_CARD_ONLY");
      await ensureCardReady();
      const attempt = await preparePaymentTransactionRetry({
        reservationId,
        transactionId: String(body.transactionId ?? ""),
        requestKey,
        requestedBy: operator.email,
        traceId: trace.traceId,
        paymentMethod,
      });
      const intent = await prepareLocalDirectPaymentIntent({
        reservationId,
        attemptId: attempt.id,
        requestKey,
        requestedBy: operator.email,
        traceId: trace.traceId,
        splitPhase: "RETRY",
        stageTrace: (stage, details, durationMs) => trace.mark(stage, details, durationMs),
        dbTrace: (query, durationMs, details) => trace.mark(
          "PAYMENT_D1_QUERY",
          { query, ...details },
          durationMs,
        ),
      });
      const overview = await getPaymentOverview(reservationId);
      trace.bind({ paymentId: attempt.paymentId ?? undefined, attemptId: attempt.id });
      trace.mark("TRANSPORT_DECISION", {
        transactionUuid: attempt.transactionUuid || attempt.id,
        selectedTransport: "LOCAL_DIRECT",
        localHealth: String(body.localHealth ?? "HEALTHY"),
        localLatencyMs: safeAmount(body.localLatencyMs),
        failureCount: safeAmount(body.localFailureCount),
        featureFlag: transport.transport,
        browserLocalRequestPossible: true,
        fallbackReason: "",
      });
      return trace.response({
        overview,
        paymentTransport: transport.transport,
        localDirectEnabled: true,
        localBridgeUrl: transport.bridgeUrl,
        intent,
      }, { status: 201 });
    }

    if (action === "prepare" || action === "start" || action === "local_prepare") {
      const reservationIds = Array.isArray(body.reservationIds)
        ? Array.from(new Set(body.reservationIds.map((value) => String(value ?? ""))))
            .filter(validReservationId)
            .slice(0, 10)
        : undefined;
      const mode = ["single", "equal", "custom"].includes(String(body.mode))
        ? (String(body.mode) as PaymentPlanMode)
        : "single";
      const items = Array.isArray(body.items)
        ? body.items.map((item) => {
            const candidate = item && typeof item === "object"
              ? (item as Record<string, unknown>)
              : {};
            return {
              amount: safeAmount(candidate.amount),
              paymentMethod: String(candidate.paymentMethod ?? "card"),
              memberCouponId: String(candidate.memberCouponId ?? ""),
            };
          })
        : undefined;
      const addOnSaleSource = body.addOnSale && typeof body.addOnSale === "object"
        ? body.addOnSale as Record<string, unknown>
        : null;
      const addOnSale = addOnSaleSource
        ? {
            slush: addOnSaleSource.slush,
            beverage: addOnSaleSource.beverage,
            other: addOnSaleSource.other,
            items: Array.isArray(addOnSaleSource.items)
              ? addOnSaleSource.items.map((item) => {
                  const candidate = item && typeof item === "object"
                    ? item as Record<string, unknown>
                    : {};
                  return {
                    code: String(candidate.code ?? ""),
                    quantity: candidate.quantity,
                  };
                })
              : [],
          }
        : undefined;
      const overview = await trace.measure(
        "PAYMENT_DB_SAVE_START",
        "PAYMENT_DB_SAVE_DONE",
        () => preparePaymentPlan({
          reservationId,
          reservationIds,
          addOnAmount: safeAmount(body.addOnAmount),
          discountAmount: safeAmount(body.discountAmount),
          mode,
          count: Math.max(1, Math.min(20, Math.trunc(Number(body.count) || 1))),
          paymentMethod: String(body.paymentMethod ?? "card"),
          items,
          addOnSale,
          requestKey,
          requestedBy: operator.email,
          traceId: trace.traceId,
          stageTrace: (stage, details, durationMs) => trace.mark(stage, details, durationMs),
          dbTrace: (query, durationMs, details) => trace.mark(
            "PAYMENT_D1_QUERY",
            { query, ...details },
            durationMs,
          ),
        }),
        { action },
      );
      trace.bind({ paymentId: overview.payment?.id });
      if (action === "local_prepare") {
        const transport = paymentTransportConfiguration();
        if (!transport.localDirectEnabled) throw new Error("LOCAL_PAYMENT_DISABLED");
        if (
          !overview.payment ||
          !paymentPlanMatchesLedger({
            authoritativeFinalAmount: overview.summary?.finalAmount ?? 0,
            authoritativeDepositAmount: overview.summary?.depositAmount ?? 0,
            storedFinalAmount: overview.payment.finalAmount,
            storedDepositAmount: overview.payment.depositAmount,
            storedPayableAmount: overview.payment.payableAmount,
            planAmounts: overview.plan.map((item) => item.amount),
          })
        ) throw new Error("PAYMENT_PLAN_STALE");
        if (overview.summary?.hasUnknown) throw new Error("PAYMENT_UNKNOWN");
        const first = overview.plan.find((item) =>
          !["APPROVED", "COMPLETED"].includes(item.status));
        if (!first) {
          return trace.response({
            overview,
            paymentTransport: transport.transport,
            localDirectEnabled: true,
            localBridgeUrl: transport.bridgeUrl,
            intent: null,
          }, { status: 201 });
        }
        if (first.paymentMethod !== "card") throw new Error("LOCAL_PAYMENT_CARD_ONLY");
        await trace.measure(
          "CARD_READY_DB_CHECK_START",
          "CARD_READY_DB_CHECK_DONE",
          () => ensureCardReady(),
        );
        const intent = await trace.measure(
          "LOCAL_INTENT_PREPARE_START",
          "LOCAL_INTENT_READY",
          () => prepareLocalDirectPaymentIntent({
            reservationId,
            attemptId: first.id,
            requestKey,
            requestedBy: operator.email,
            traceId: trace.traceId,
            splitPhase: "INITIAL",
            stageTrace: (stage, details, durationMs) => trace.mark(stage, details, durationMs),
            dbTrace: (query, durationMs, details) => trace.mark(
              "PAYMENT_D1_QUERY",
              { query, ...details },
              durationMs,
            ),
          }),
          { splitPhase: "INITIAL" },
        );
        trace.bind({ attemptId: first.id });
        trace.mark("API_RESPONSE_READY", { action, splitPhase: "INITIAL" });
        return trace.response({
          overview,
          paymentTransport: transport.transport,
          localDirectEnabled: true,
          localBridgeUrl: transport.bridgeUrl,
          intent,
        }, { status: 201 });
      }
      if (action === "start") {
        if (
          !overview.payment ||
          !paymentPlanMatchesLedger({
            authoritativeFinalAmount: overview.summary?.finalAmount ?? 0,
            authoritativeDepositAmount: overview.summary?.depositAmount ?? 0,
            storedFinalAmount: overview.payment.finalAmount,
            storedDepositAmount: overview.payment.depositAmount,
            storedPayableAmount: overview.payment.payableAmount,
            planAmounts: overview.plan.map((item) => item.amount),
          })
        ) throw new Error("PAYMENT_PLAN_STALE");
        if (overview.summary?.hasUnknown) throw new Error("PAYMENT_UNKNOWN");

        const first = overview.plan.find((item) =>
          item.splitIndex === 1 && !["APPROVED", "COMPLETED"].includes(item.status));
        if (!first) {
          return trace.response({ overview }, { status: 201 });
        }
        trace.bind({ attemptId: first.id });
        if (first.splitIndex !== 1) throw new Error("PAYMENT_TRANSACTION_OUT_OF_ORDER");
        if (first.paymentMethod === "card") {
          await trace.measure(
            "CARD_READY_DB_CHECK_START",
            "CARD_READY_DB_CHECK_DONE",
            () => ensureCardReady(),
          );
        }
        const transactionRequestKey = String(body.transactionRequestKey ?? "");
        const attempt = await trace.measure(
          "BRIDGE_REQUEST_START",
          "BRIDGE_COMMAND_QUEUED",
          () => processPreparedPaymentTransaction({
            reservationId,
            paymentId: overview.payment!.id,
            transactionId: first.id,
            expectedSplitIndex: first.splitIndex,
            requestKey: transactionRequestKey,
            requestedBy: operator.email,
            traceId: trace.traceId,
            dbTrace: (query, durationMs, details) => trace.mark(
              "PAYMENT_D1_QUERY",
              { query, ...details },
              durationMs,
            ),
          }),
          { action, paymentMethod: first.paymentMethod },
        );
        trace.bind({ attemptId: attempt.id });
        return trace.response({ overview, attempt }, { status: 202 });
      }
      return trace.response(overview as unknown as Record<string, unknown>, { status: 201 });
    }

    if (action === "local_release") {
      return trace.response(await releaseLocalDirectPaymentIntent({
        reservationId,
        intentId: String(body.intentId ?? ""),
      }));
    }

    if (action === "local_unknown") {
      return trace.response(await markLocalDirectPaymentUnknown({
        reservationId,
        intentId: String(body.intentId ?? ""),
        reason: String(body.reason ?? ""),
      }) as unknown as Record<string, unknown>);
    }

    if (action === "reconcile_approved") {
      const transactionId = String(body.transactionId ?? "");
      if (!validReservationId(transactionId)) {
        throw new Error("PAYMENT_RECONCILIATION_ATTEMPT_NOT_FOUND");
      }
      return trace.response(await reconcileUnknownPayment({
        reservationId,
        transactionId,
        authNo: body.authNo,
        authDate: body.authDate,
        requestedBy: operator.email,
      }) as unknown as Record<string, unknown>);
    }

    if (action === "record_external_approved") {
      return trace.response(await recordExternalApprovedPayment({
        reservationId,
        amount: body.amount,
        authNo: body.authNo,
        authDate: body.authDate,
        approvalTime: body.approvalTime,
        cardName: body.cardName,
        cardLast4: body.cardLast4,
        terminalId: body.terminalId,
        externalTransactionId: body.externalTransactionId,
        reason: body.reason,
        requestedBy: operator.email,
      }) as unknown as Record<string, unknown>);
    }

    if (action === "unlink_external_approved") {
      const transactionId = String(body.transactionId ?? "");
      if (!validReservationId(transactionId)) {
        throw new Error("PAYMENT_EXTERNAL_UNLINK_NOT_ALLOWED");
      }
      return trace.response(await unlinkExternalApprovedPayment({
        reservationId,
        transactionId,
        reason: body.reason,
        requestedBy: operator.email,
      }) as unknown as Record<string, unknown>);
    }

    if (action === "process" || action === "retry") {
      const transactionId = String(body.transactionId ?? "");
      trace.bind({ attemptId: transactionId });
      const overview = await trace.measure(
        "PAYMENT_DB_LOOKUP_START",
        "PAYMENT_DB_LOOKUP_DONE",
        () => getPaymentOverview(reservationId),
        { lookup: "payment_overview" },
      );
      trace.bind({ paymentId: overview.payment?.id });
      if (
        !overview.payment ||
        !paymentPlanMatchesLedger({
          authoritativeFinalAmount: overview.summary?.finalAmount ?? 0,
          authoritativeDepositAmount: overview.summary?.depositAmount ?? 0,
          storedFinalAmount: overview.payment.finalAmount,
          storedDepositAmount: overview.payment.depositAmount,
          storedPayableAmount: overview.payment.payableAmount,
          planAmounts: overview.plan.map((item) => item.amount),
        })
      ) throw new Error("PAYMENT_PLAN_STALE");
      const transaction = overview.attempts.find(
        (attempt) => attempt.id === transactionId && attempt.attemptType === "PAY",
      );
      if (!transaction) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
      const requestedRetryPaymentMethod = action === "retry" && body.paymentMethod != null
        ? String(body.paymentMethod).trim().toLowerCase()
        : null;
      if (requestedRetryPaymentMethod && !["card", "cash", "account"].includes(requestedRetryPaymentMethod)) {
        throw new Error("PAYMENT_RETRY_METHOD_INVALID");
      }
      const effectivePaymentMethod = requestedRetryPaymentMethod ?? transaction.paymentMethod;
      trace.mark("TRANSPORT_DECISION", {
        transactionUuid: transaction.transactionUuid || transaction.id,
        selectedTransport: effectivePaymentMethod === "card" ? "CLOUD_FAST_LANE" : "NON_CARD",
        localHealth: String(body.localHealth ?? ""),
        localLatencyMs: safeAmount(body.localLatencyMs),
        failureCount: safeAmount(body.localFailureCount),
        featureFlag: paymentTransportConfiguration().transport,
        browserLocalRequestPossible: false,
        fallbackReason: String(body.fallbackReason ?? ""),
      });
      if (effectivePaymentMethod === "card") {
        await trace.measure(
          "CARD_READY_DB_CHECK_START",
          "CARD_READY_DB_CHECK_DONE",
          () => ensureCardReady(),
        );
      }
      const attempt = await trace.measure(
        "BRIDGE_REQUEST_START",
        "BRIDGE_COMMAND_QUEUED",
        () => action === "retry"
          ? retryPaymentTransaction({
            reservationId,
            transactionId,
            requestKey,
            requestedBy: operator.email,
            traceId: trace.traceId,
            paymentMethod: requestedRetryPaymentMethod ?? undefined,
          })
          : processPaymentTransaction({
            reservationId,
            transactionId,
            requestKey,
            requestedBy: operator.email,
            traceId: trace.traceId,
            dbTrace: (query, durationMs, details) => trace.mark(
              "PAYMENT_D1_QUERY",
              { query, ...details },
              durationMs,
            ),
          }),
        { action, paymentMethod: effectivePaymentMethod },
      );
      trace.bind({ attemptId: attempt.id });
      return trace.response({ attempt }, { status: 202 });
    }

    if (action === "change_method") {
      const transactionId = String(body.transactionId ?? "");
      const paymentMethod = String(body.paymentMethod ?? "").trim().toLowerCase();
      trace.bind({ attemptId: transactionId });
      const attempt = await trace.measure(
        "PAYMENT_METHOD_CHANGE_START",
        "PAYMENT_METHOD_CHANGE_DONE",
        () => changePendingPaymentTransactionMethod({
          reservationId,
          transactionId,
          paymentMethod,
          requestedBy: operator.email,
        }),
        { paymentMethod },
      );
      return trace.response({ attempt });
    }

    if (action === "cancel") {
      const paymentId = String(body.paymentId ?? "");
      trace.bind({ attemptId: paymentId });
      const overview = await trace.measure(
        "PAYMENT_DB_LOOKUP_START",
        "PAYMENT_DB_LOOKUP_DONE",
        () => getPaymentOverview(reservationId),
        { lookup: "approved_payment" },
      );
      trace.bind({ paymentId: overview.payment?.id });
      const original = overview.attempts.find(
        (attempt) => attempt.id === paymentId && attempt.attemptType === "PAY",
      );
      if (!original) throw new Error("APPROVED_PAYMENT_NOT_FOUND");
      if (original.paymentMethod === "card") {
        await trace.measure("CARD_READY_DB_CHECK_START", "CARD_READY_DB_CHECK_DONE", () => ensureCardReady());
      }
      const attempt = await trace.measure(
        "BRIDGE_REQUEST_START",
        "BRIDGE_COMMAND_QUEUED",
        () => requestPaymentCancellation({
          reservationId,
          paymentId,
          requestKey,
          requestedBy: operator.email,
          traceId: trace.traceId,
        }),
        { action },
      );
      trace.bind({ attemptId: attempt.id });
      return trace.response({ attempt }, { status: 202 });
    }

    if (action === "cancel_all") {
      const overview = await trace.measure(
        "PAYMENT_DB_LOOKUP_START",
        "PAYMENT_DB_LOOKUP_DONE",
        () => getPaymentOverview(reservationId),
        { lookup: "full_cancel" },
      );
      trace.bind({ paymentId: overview.payment?.id });
      const cancelled = new Set(
        overview.attempts
          .filter((attempt) => attempt.attemptType === "CANCEL" && attempt.status === "CANCELLED")
          .map((attempt) => attempt.originalAttemptId),
      );
      const hasActiveCard = overview.attempts.some(
        (attempt) =>
          attempt.attemptType === "PAY" &&
          attempt.paymentMethod === "card" &&
          ["APPROVED", "COMPLETED"].includes(attempt.status) &&
          !cancelled.has(attempt.id),
      );
      if (hasActiveCard) {
        await trace.measure("CARD_READY_DB_CHECK_START", "CARD_READY_DB_CHECK_DONE", () => ensureCardReady());
      }
      const result = await trace.measure(
        "BRIDGE_REQUEST_START",
        "BRIDGE_COMMAND_QUEUED",
        () => requestFullPaymentCancellation({
          reservationId,
          requestKey,
          requestedBy: operator.email,
          traceId: trace.traceId,
        }),
        { action },
      );
      return trace.response(result as unknown as Record<string, unknown>, { status: 202 });
    }

    return trace.response({ error: "지원하지 않는 결제 요청입니다." }, { status: 400 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const messages: Record<string, string> = {
      PAYMENT_RECONCILIATION_ATTEMPT_NOT_FOUND: "대조할 카드 거래를 찾지 못했습니다.",
      PAYMENT_RECONCILIATION_NOT_UNKNOWN: "결과 미확정 거래만 수동 대조할 수 있습니다.",
      PAYMENT_RECONCILIATION_AUTH_NO_INVALID: "승인번호 형식이 올바르지 않습니다.",
      PAYMENT_RECONCILIATION_AUTH_DATE_INVALID: "승인일자는 YYYYMMDD 형식이어야 합니다.",
      PAYMENT_RECONCILIATION_DUPLICATE: "같은 승인정보가 다른 거래에 이미 등록되어 있습니다.",
      PAYMENT_RECONCILIATION_CONFLICT: "거래 상태가 변경되어 대조하지 않았습니다. 새로고침 후 확인해주세요.",
      PAYMENT_EXTERNAL_IMPORT_AMOUNT_INVALID: "\uB2E8\uB9D0 \uC2B9\uC778\uAE08\uC561\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.",
      PAYMENT_EXTERNAL_IMPORT_AMOUNT_MISMATCH: "\uB2E8\uB9D0 \uC2B9\uC778\uAE08\uC561\uC774 \uD604\uC7AC \uBBF8\uACB0\uC81C\uC561\uACFC \uC77C\uCE58\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.",
      PAYMENT_EXTERNAL_IMPORT_CONFLICT: "\uAE30\uC874 \uACB0\uC81C \uACC4\uD68D \uB610\uB294 \uAC70\uB798\uB0B4\uC5ED\uC774 \uC788\uC5B4 \uC9C1\uC811 \uC2B9\uC778\uAC74\uC744 \uC790\uB3D9 \uB9E4\uCE6D\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.",
      PAYMENT_EXTERNAL_IMPORT_TIME_INVALID: "승인시각은 시:분 또는 시:분:초 형식으로 입력해주세요.",
      PAYMENT_EXTERNAL_IMPORT_TERMINAL_INVALID: "단말기 식별값을 확인해주세요.",
      PAYMENT_EXTERNAL_IMPORT_CARD_LAST4_INVALID: "카드번호 뒤 4자리는 숫자 4자리로 입력해주세요.",
      PAYMENT_EXTERNAL_IMPORT_REASON_REQUIRED: "수동 연결 또는 연결 해제 사유를 2자 이상 입력해주세요.",
      PAYMENT_EXTERNAL_IMPORT_BLOCKED: "확인 중이거나 처리 중인 결제가 있어 단말 직접 승인건을 연결할 수 없습니다.",
      PAYMENT_EXTERNAL_IMPORT_PLAN_CONFLICT: "현재 결제 순서가 카드 결제가 아니거나 연결할 수 없는 상태입니다.",
      PAYMENT_EXTERNAL_IMPORT_SPLIT_MISMATCH: "승인금액이 현재 결제할 회차 금액과 정확히 일치하지 않습니다.",
      PAYMENT_EXTERNAL_UNLINK_NOT_ALLOWED: "단말 직접 결제로 연결된 활성 거래만 연결 해제할 수 있습니다.",
      PAYMENT_TERMINAL_DIRECT_CANCEL_UNVERIFIED: "단말기에서 직접 결제한 건은 자동 승인취소가 검증되지 않았습니다. 단말에서 취소한 뒤 예약 연결만 해제해주세요.",
      RESERVATION_NOT_FOUND: "예약을 찾지 못했습니다.",
      CANCELLED_RESERVATION: "취소된 예약은 결제할 수 없습니다.",
      PAYMENT_PLAN_NOT_FOUND: "결제 계획을 먼저 만들어주세요.",
      PAYMENT_PLAN_LOCKED: "완료되었거나 확인이 필요한 거래가 있어 결제 계획을 변경할 수 없습니다.",
      PAYMENT_METHOD_CHANGE_NOT_ALLOWED: "준비 중인 카드 요청을 해제한 뒤 결제수단을 다시 변경해주세요.",
      PAYMENT_PLAN_STALE: "예약금 또는 결제금액이 변경되었습니다. 표시된 금액으로 결제 계획을 다시 만들어주세요.",
      PAYMENT_GROUP_SIZE_INVALID: "한 번에 묶을 수 있는 예약 수를 확인해주세요.",
      PAYMENT_GROUP_RESERVATION_MISMATCH: "같은 한판더 묶음의 예약만 함께 결제할 수 있습니다.",
      PAYMENT_GROUP_CANCELLED_RESERVATION: "취소된 예약은 묶음 결제에 포함할 수 없습니다.",
      PAYMENT_GROUP_RESERVATION_ONLY: "게임 예약끼리만 한 번에 결제할 수 있습니다.",
      PAYMENT_GROUP_ITEM_ALREADY_PAID: "묶음 안에 이미 결제 완료된 예약이 있습니다.",
      PAYMENT_GROUP_ITEM_HAS_PAYMENT: "묶음 안의 예약에 다른 결제 계획이 이미 있습니다.",
      PAYMENT_GROUP_COUPON_NOT_SUPPORTED: "쿠폰은 예약별로 적용해야 하므로 묶음 결제에서는 사용할 수 없습니다.",
      KIOSK_PARTICIPANT_TOP_UP_EMPTY: "추가할 성인 또는 청소년 인원을 선택해주세요.",
      KIOSK_PARTY_INVALID: "예약 인원은 기존 인원을 포함해 최대 10명까지 등록할 수 있습니다.",
      KIOSK_PARTICIPANT_TOP_UP_PAYMENT_REQUIRED: "기존 결제가 모두 완료된 예약에서만 인원 추가 결제를 진행할 수 있습니다.",
      KIOSK_PARTICIPANT_TOP_UP_NOT_ACTIVE: "취소되거나 이용 완료된 예약에는 인원을 추가할 수 없습니다.",
      KIOSK_PARTICIPANT_TOP_UP_GROUPED: "한판더 묶음 결제된 예약은 인원 추가 결제를 지원하지 않습니다. 기존 예약별 결제 상태를 확인해주세요.",
      KIOSK_PARTICIPANT_TOP_UP_STALE: "예약 인원 또는 결제 상태가 변경되었습니다. 창을 새로고침한 뒤 다시 시도해주세요.",
      KIOSK_PAYMENT_ITEMS_INVALID: "추가 결제는 카드·현금·계좌 결제만 사용할 수 있습니다.",
      PAYMENT_SPLIT_COUNT_INVALID: "분할 횟수는 1회 이상 20회 이하여야 합니다.",
      PAYMENT_SPLIT_AMOUNT_TOO_SMALL: "결제금액보다 분할 횟수가 많습니다.",
      PAYMENT_SPLIT_ITEMS_INVALID: "각 분할 결제금액은 1원 이상이어야 합니다.",
      PAYMENT_SPLIT_TOTAL_UNDER: "분할 금액 합계가 현장 결제금액보다 적습니다.",
      PAYMENT_SPLIT_TOTAL_OVER: "분할 금액 합계가 현장 결제금액보다 큽니다.",
      PAYMENT_REQUEST_KEY_REQUIRED: "결제 요청 식별값이 없습니다. 창을 닫고 다시 시도해주세요.",
      PAYMENT_REQUEST_KEY_CONFLICT: "다른 결제에 사용된 요청 식별값입니다. 상태를 새로고침해주세요.",
      PAYMENT_UNKNOWN: "결과 미확정 거래가 있어 추가 결제와 취소를 차단했습니다.",
      PAYMENT_TERMINAL_BUSY: "다른 카드 거래가 진행 중입니다. 완료 후 다시 시도해주세요.",
      PAYMENT_AGENT_OFFLINE: "매장 브릿지가 오프라인입니다. 브릿지 실행 상태를 확인해주세요.",
      PAYMENT_TERMINAL_NOT_READY: "카드 단말 연결 또는 사업자번호 설정 상태를 확인해주세요.",
      LOCAL_PAYMENT_DISABLED: "로컬 직결 결제가 비활성화되어 기존 결제 경로를 사용합니다.",
      LOCAL_PAYMENT_CARD_ONLY: "로컬 직결은 카드 결제 회차에만 사용합니다.",
      LOCAL_PAYMENT_SIGNING_KEY_NOT_CONFIGURED: "로컬 결제 서명 설정을 확인해주세요.",
      LOCAL_PAYMENT_SCHEMA_INVALID: "결제 준비 스키마가 운영 버전과 일치하지 않습니다. 결제를 진행하지 않았습니다.",
      LOCAL_PAYMENT_INTENT_NOT_FOUND: "로컬 결제 준비정보를 찾지 못했습니다. 다시 준비해주세요.",
      LOCAL_PAYMENT_RELEASE_NOT_ALLOWED: "이미 단말로 전달된 거래는 자동 전환하지 않습니다. 결제 상태를 확인해주세요.",
      PAYMENT_TRANSACTION_OUT_OF_ORDER: "앞 회차 결제를 먼저 완료해주세요.",
      PAYMENT_TRANSACTION_NOT_PENDING: "이미 처리된 결제 회차입니다. 상태를 새로고침해주세요.",
      PAYMENT_TRANSACTION_NOT_RETRYABLE: "이 거래는 재시도할 수 없는 상태입니다.",
      PAYMENT_ATTEMPT_NOT_FOUND: "결제 거래를 찾지 못했습니다.",
      MEMBER_COUPON_REQUIRED: "사용할 회원 쿠폰을 선택해주세요.",
      MEMBER_COUPON_DUPLICATE_IN_PLAN: "같은 쿠폰을 두 결제 회차에 중복 사용할 수 없습니다.",
      MEMBER_COUPON_PARTICIPANT_LIMIT: "쿠폰은 이용자 1명당 1장만 사용할 수 있으며 남은 게임비를 초과해 적용할 수 없습니다.",
      MEMBER_COUPON_AMOUNT_MISMATCH: "쿠폰 1장에는 이용자 1명의 게임비만 적용할 수 있습니다. 결제 계획을 다시 만들어주세요.",
      RESERVATION_MEMBER_REQUIRED_FOR_COUPON: "쿠폰을 사용하려면 예약에 회원을 먼저 연결해주세요.",
      MEMBER_COUPON_NOT_FOUND: "회원 쿠폰을 찾지 못했습니다.",
      MEMBER_COUPON_MEMBER_MISMATCH: "예약 회원과 쿠폰 회원이 다릅니다.",
      MEMBER_COUPON_EXPIRED: "유효기간이 지난 쿠폰입니다.",
      MEMBER_COUPON_NOT_ACTIVE: "이미 사용되었거나 사용할 수 없는 쿠폰입니다.",
      MEMBER_COUPON_RESERVATION_ONLY: "회원 쿠폰은 게임 예약 결제에만 사용할 수 있습니다.",
      WEEKDAY_COUPON_WEEKDAY_ONLY: "평일 이용 쿠폰은 월요일부터 금요일 예약에만 사용할 수 있습니다.",
      ADD_ON_SALE_RESERVATION_ONLY: "부가상품 함께 결제는 게임 예약에서만 사용할 수 있습니다.",
      ADD_ON_SALE_AMOUNT_MISMATCH: "선택한 부가상품 합계와 결제 추가 금액이 맞지 않습니다. 화면을 새로고침해주세요.",
      ADD_ON_SALE_ITEMS_INVALID: "운영 가격 설정에 없는 부가상품이 포함되어 있습니다. 화면을 새로고침해주세요.",
      ADD_ON_SALE_COUPON_EXCEEDS_GAME_FEE: "쿠폰은 게임비에만 사용할 수 있습니다. 부가상품 금액은 카드·현금·계좌 결제에 포함해주세요.",
      APPROVED_PAYMENT_NOT_FOUND: "취소할 완료 거래를 찾지 못했습니다.",
      ORIGINAL_AUTH_MISSING: "승인번호 또는 승인일자가 없어 단말 자동취소할 수 없습니다.",
      PASS_PURCHASE_PARTIALLY_USED: "이미 일부 사용한 다회권은 자동 전체취소할 수 없습니다. 환불 정책을 확인해주세요.",
    };
    trace.mark("API_ERROR", { code });
    return trace.response(
      { error: messages[code] ?? (code || "결제 요청을 저장하지 못했습니다.") },
      { status: code === "RESERVATION_NOT_FOUND" ? 404 : 409 },
    );
  }
}
