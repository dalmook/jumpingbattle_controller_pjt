UPDATE `reservations`
SET
  `status` = 'cancelled',
  `active_slot_key` = NULL,
  `cancelled_at` = COALESCE(`cancelled_at`, CURRENT_TIMESTAMP),
  `updated_at` = CURRENT_TIMESTAMP
WHERE `source` = 'naver'
  AND `status` <> 'cancelled'
  AND (
    `source_status` LIKE '%취소%'
    OR `source_status` LIKE '%환불%'
    OR UPPER(`source_status`) LIKE '%CANCEL%'
    OR UPPER(`source_status`) LIKE '%REFUND%'
  );--> statement-breakpoint
UPDATE `reservations`
SET
  `status` = 'booked',
  `active_slot_key` = CASE
    WHEN `scheduled_date` <> '' AND `scheduled_time` <> '' AND `room_code` <> ''
      THEN `scheduled_date` || '|' || `scheduled_time` || '|' || `room_code` || '|naver-reopen|' || `id`
    ELSE NULL
  END,
  `cancelled_at` = NULL,
  `updated_at` = CURRENT_TIMESTAMP
WHERE `source` = 'naver'
  AND `status` = 'completed'
  AND `scheduled_date` >= date('now', '+9 hours')
  AND NOT (
    `source_status` LIKE '%취소%'
    OR `source_status` LIKE '%환불%'
    OR UPPER(`source_status`) LIKE '%CANCEL%'
    OR UPPER(`source_status`) LIKE '%REFUND%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id`
      AND `event_type` IN ('complete', 'auto_complete_game_stopped')
  );
