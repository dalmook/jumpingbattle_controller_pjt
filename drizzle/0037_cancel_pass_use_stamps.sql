INSERT OR IGNORE INTO stamp_ledger (
  id, member_id, reservation_id, type, amount, reason, source, reference_key, created_by
)
SELECT
  'stamp-ledger:pass-use-cancel:' || earned.reservation_id,
  earned.member_id,
  earned.reservation_id,
  'CANCEL',
  -ABS(earned.amount),
  '다회권 사용으로 스탬프 적립 취소',
  'PASS',
  'stamp-cancel:pass-use:' || earned.reservation_id,
  'migration-0037'
FROM stamp_ledger earned
WHERE earned.type = 'EARN'
  AND earned.reservation_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM pass_ledger used
    WHERE used.reservation_id = earned.reservation_id
      AND used.type = 'USE'
      AND used.source = 'POS'
      AND NOT EXISTS (
        SELECT 1
        FROM pass_ledger restored
        WHERE restored.type = 'RESTORE'
          AND restored.reference_id = used.id
      )
  );
--> statement-breakpoint
PRAGMA optimize;
