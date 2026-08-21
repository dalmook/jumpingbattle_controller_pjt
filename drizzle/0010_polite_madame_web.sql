ALTER TABLE `reservations` ADD `schedule_overridden` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `reservations`
SET `schedule_overridden` = 1
WHERE `source` = 'naver'
  AND EXISTS (
    SELECT 1
    FROM `reservation_events`
    WHERE `reservation_events`.`reservation_id` = `reservations`.`id`
      AND `reservation_events`.`event_type` = 'move'
  );
