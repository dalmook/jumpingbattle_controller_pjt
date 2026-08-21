ALTER TABLE `reservations` ADD `cancelled_at` text;--> statement-breakpoint
UPDATE `reservations`
SET `cancelled_at` = COALESCE(
  (
    SELECT MIN(`reservation_events`.`created_at`)
    FROM `reservation_events`
    WHERE `reservation_events`.`reservation_id` = `reservations`.`id`
      AND `reservation_events`.`event_type` IN ('cancel', 'import_cancelled')
  ),
  `updated_at`,
  `created_at`
)
WHERE `status` = 'cancelled';
