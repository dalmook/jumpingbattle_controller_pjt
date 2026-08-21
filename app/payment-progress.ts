import type { PaymentAttempt, PaymentOverview } from "./types";

export type MinimalNextSplitResult = {
  reservationId: string;
  paymentId: string;
  ledgerRevision: string;
  payment: NonNullable<PaymentOverview["payment"]>;
  summary: NonNullable<PaymentOverview["summary"]>;
  currentAttempt: PaymentAttempt;
  nextAttempt: PaymentAttempt | null;
  plan: PaymentAttempt[];
  canUseNextSplit: boolean;
  finalizationRequired: boolean;
  finalizationReady: boolean;
};

const WHOLE_STATUS_RANK: Record<NonNullable<PaymentOverview["payment"]>["status"], number> = {
  PENDING: 0,
  PARTIALLY_PAID: 1,
  PAID: 2,
  PARTIALLY_CANCELLED: 2,
  CANCELLED: 3,
  UNKNOWN: 3,
  ERROR: 3,
};

function mergeAttemptRows(current: PaymentAttempt[], incoming: PaymentAttempt[]) {
  const merged = new Map(current.map((attempt) => [attempt.id, attempt]));
  for (const attempt of incoming) merged.set(attempt.id, attempt);
  return Array.from(merged.values()).sort(
    (left, right) =>
      right.attemptNumber - left.attemptNumber ||
      right.requestedAt.localeCompare(left.requestedAt),
  );
}

export function mergeMinimalPaymentProgress(
  overview: PaymentOverview,
  progress: MinimalNextSplitResult,
): PaymentOverview {
  if (overview.payment && overview.payment.id !== progress.paymentId) return overview;
  return {
    ...overview,
    payment: progress.payment,
    summary: progress.summary,
    plan: progress.plan,
    attempts: mergeAttemptRows(
      overview.attempts,
      [progress.currentAttempt, ...progress.plan],
    ),
  };
}

export function paymentOverviewCoversProgress(
  overview: PaymentOverview,
  progress: MinimalNextSplitResult,
) {
  if (overview.payment?.id !== progress.paymentId) return false;
  const current = overview.attempts.find(
    (attempt) => attempt.id === progress.currentAttempt.id,
  );
  if (!current || current.status !== progress.currentAttempt.status) return false;
  if (
    WHOLE_STATUS_RANK[overview.payment.status] <
    WHOLE_STATUS_RANK[progress.payment.status]
  ) return false;
  if (progress.nextAttempt) {
    const next = overview.plan.find(
      (attempt) => attempt.id === progress.nextAttempt?.id,
    );
    if (!next || next.status !== progress.nextAttempt.status) return false;
  }
  return true;
}
