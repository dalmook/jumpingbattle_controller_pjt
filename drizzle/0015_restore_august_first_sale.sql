UPDATE `reservations`
SET
  `status` = 'completed',
  `active_slot_key` = NULL,
  `cancelled_at` = NULL,
  `schedule_overridden` = 1,
  `details_overridden` = 1,
  `updated_at` = CURRENT_TIMESTAMP
WHERE `source` = 'naver'
  AND `booking_code` = 'JB-260801-4B0F7C'
  AND `scheduled_date` = '2026-08-01';--> statement-breakpoint
INSERT INTO `reservation_events` (
  `id`, `reservation_id`, `event_type`, `details_json`, `created_by`, `created_at`
)
SELECT
  lower(hex(randomblob(16))),
  `id`,
  'complete',
  '{"reason":"restore_incorrect_naver_cancellation","bookingCode":"JB-260801-4B0F7C"}',
  'data-repair',
  CURRENT_TIMESTAMP
FROM `reservations`
WHERE `source` = 'naver'
  AND `booking_code` = 'JB-260801-4B0F7C'
  AND `scheduled_date` = '2026-08-01'
  AND NOT EXISTS (
    SELECT 1
    FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id`
      AND `event_type` IN ('complete', 'auto_complete_game_stopped')
  );
