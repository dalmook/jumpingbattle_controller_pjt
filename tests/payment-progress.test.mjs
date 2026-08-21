import assert from "node:assert/strict";
import test from "node:test";
import { mergeMinimalPaymentProgress, paymentOverviewCoversProgress } from "../app/payment-progress.ts";

const attempt = (id, splitIndex, status) => ({
  id, transactionUuid: id, reservationId: "r1", paymentId: "p1", memberId: null,
  memberPassId: null, memberCouponId: null, splitIndex, attemptType: "PAY",
  attemptNumber: splitIndex + 1, amount: 1000, saleAmount: 1000, addOnAmount: 0,
  discountAmount: 0, paymentMethod: "card", status, responseCode: "",
  responseMessage: "", authNo: "", authDate: "", issuerName: "", acquirerName: "",
  maskedCardNo: "", rawReturnCode: null, errorCode: "", elapsedMs: 0,
  mposTransactionId: null, originalAttemptId: null, originalMposTransactionId: null,
  commandId: null, activeKey: null, traceId: "", transactionSource: "SYSTEM",
  verificationStatus: "", approvalTime: "", terminalId: "", externalTransactionId: "",
  operatorNote: "", requestedAt: "", completedAt: null, updatedAt: "",
});

const overview = (attempts, status = "PENDING") => ({
  terminal: {},
  payment: { id: "p1", reservationId: "r1", mode: "equal", splitCount: 5,
    finalAmount: 5000, depositAmount: 0, payableAmount: 5000, status,
    fullCancelRequested: false, createdAt: "", updatedAt: "" },
  summary: { finalAmount: 5000, depositAmount: 0, payableAmount: 5000,
    approvedAmount: 0, completedAmount: 0, splitApprovedAmount: 0,
    remainingAmount: 5000, approvedByMethod: {}, hasUnknown: false, hasBusy: false,
    amountLocked: true, paymentStatus: status, currentSplitIndex: 0, orderStatus: status },
  plan: attempts, attempts, group: null, terminalImport: {},
});

test("minimal result unlocks only the next unfinished split and rejects stale overview", () => {
  const rows = [0, 1, 2, 3, 4].map((index) => attempt(`a${index + 1}`, index, "PENDING"));
  const progress = {
    reservationId: "r1", paymentId: "p1", ledgerRevision: "rev2",
    payment: { ...overview(rows).payment, status: "PARTIALLY_PAID" },
    summary: { ...overview(rows).summary, approvedAmount: 1000, completedAmount: 1000,
      splitApprovedAmount: 1000, remainingAmount: 4000, paymentStatus: "PARTIALLY_PAID",
      orderStatus: "PARTIALLY_PAID", currentSplitIndex: 1 },
    currentAttempt: attempt("a1", 0, "APPROVED"), nextAttempt: attempt("a2", 1, "PENDING"),
    plan: [attempt("a1", 0, "APPROVED"), ...rows.slice(1)], canUseNextSplit: true,
    finalizationRequired: false, finalizationReady: true,
  };
  const merged = mergeMinimalPaymentProgress(overview(rows), progress);
  assert.equal(merged.payment.status, "PARTIALLY_PAID");
  assert.equal(merged.plan[0].status, "APPROVED");
  assert.equal(merged.plan[1].status, "PENDING");
  assert.equal(merged.summary.remainingAmount, 4000);
  assert.equal(paymentOverviewCoversProgress(overview(rows), progress), false);
  assert.equal(paymentOverviewCoversProgress(merged, progress), true);
});
