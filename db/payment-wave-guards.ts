export type PaymentGuardAttemptSnapshot = {
  id: string;
  split_index: number;
  attempt_type: string;
  status: string;
  active_key: string | null;
};

export const PAYMENT_GUARD_PAYMENT_SQL = `WITH allocated AS (
    SELECT payment_id FROM payment_allocations WHERE reservation_id = ?
    ORDER BY updated_at DESC LIMIT 1
  )
  SELECT id, reservation_id, split_count, status FROM payments
  WHERE id = (SELECT payment_id FROM allocated) OR reservation_id = ?
  ORDER BY CASE WHEN id = (SELECT payment_id FROM allocated) THEN 0 ELSE 1 END
  LIMIT 1`;

export const PAYMENT_GUARD_ATTEMPTS_SQL = `WITH allocated AS (
    SELECT payment_id FROM payment_allocations WHERE reservation_id = ?
    ORDER BY updated_at DESC LIMIT 1
  ), target AS (
    SELECT id FROM payments
    WHERE id = (SELECT payment_id FROM allocated) OR reservation_id = ?
    ORDER BY CASE WHEN id = (SELECT payment_id FROM allocated) THEN 0 ELSE 1 END
    LIMIT 1
  )
  SELECT id, reservation_id, payment_id, split_index, attempt_type, amount,
    payment_method, status, command_id, active_key
  FROM payment_attempts
  WHERE payment_id = (SELECT id FROM target)
  ORDER BY attempt_number DESC, requested_at DESC`;

export const PAYMENT_INTENT_SCHEMA_CHECK_SQL = `SELECT
    (SELECT COUNT(*) FROM pragma_table_info('payment_intents')
      WHERE name IN (
        'id', 'reservation_id', 'payment_id', 'attempt_id', 'transaction_uuid',
        'amount', 'payment_method', 'request_key', 'nonce', 'version', 'signature',
        'status', 'trace_id', 'requested_by', 'issued_at', 'expires_at',
        'result_json', 'local_durable_at', 'cloud_synced_at', 'created_at', 'updated_at'
      )) AS column_count,
    (SELECT COUNT(*) FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'payment_intents_attempt_status_idx',
        'payment_intents_transaction_uuid_idx',
        'payment_intents_status_expiry_idx'
      )) AS index_count`;

export function paymentIntentSchemaIsReady(row?: {
  column_count: number;
  index_count: number;
} | null) {
  return Number(row?.column_count) === 21 && Number(row?.index_count) === 3;
}

export function evaluatePaymentExecutionGuard<T extends PaymentGuardAttemptSnapshot>(input: {
  attempts: T[];
  splitCount: number;
  attemptId: string;
}) {
  const latest = new Map<number, T>();
  for (const attempt of input.attempts) {
    if (
      attempt.attempt_type === "PAY" &&
      attempt.split_index >= 1 &&
      attempt.split_index <= input.splitCount &&
      !latest.has(attempt.split_index)
    ) {
      latest.set(attempt.split_index, attempt);
    }
  }
  const splitRows = Array.from(
    { length: input.splitCount },
    (_, index) => latest.get(index + 1) ?? null,
  );
  const successful = (attempt: T | null) => Boolean(
    attempt && ["APPROVED", "COMPLETED"].includes(attempt.status),
  );
  const attempt = splitRows.find((candidate) => candidate?.id === input.attemptId) ?? null;
  const firstUnfinished = splitRows.find((candidate) => !successful(candidate)) ?? null;
  const otherActive = input.attempts.find(
    (candidate) => candidate.id !== input.attemptId && Boolean(candidate.active_key),
  ) ?? null;
  return {
    attempt,
    firstUnfinishedAttemptId: firstUnfinished?.id ?? null,
    hasUnknown: input.attempts.some((candidate) => candidate.status === "UNKNOWN"),
    otherActiveAttemptId: otherActive?.id ?? null,
  };
}
