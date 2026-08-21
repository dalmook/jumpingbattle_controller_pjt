ALTER TABLE `reservations` ADD `details_overridden` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `reservations`
SET
  `details_overridden` = 1,
  `team_name` = COALESCE((
    SELECT json_extract(`details_json`, '$.teamName')
    FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id` AND `event_type` = 'details'
    ORDER BY `created_at` DESC, `rowid` DESC LIMIT 1
  ), `team_name`),
  `difficulty_code` = COALESCE((
    SELECT json_extract(`details_json`, '$.difficultyCode')
    FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id` AND `event_type` = 'details'
    ORDER BY `created_at` DESC, `rowid` DESC LIMIT 1
  ), `difficulty_code`),
  `difficulty_label` = COALESCE((
    SELECT json_extract(`details_json`, '$.difficultyLabel')
    FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id` AND `event_type` = 'details'
    ORDER BY `created_at` DESC, `rowid` DESC LIMIT 1
  ), `difficulty_label`),
  `map_index` = COALESCE((
    SELECT CAST(json_extract(`details_json`, '$.mapIndex') AS INTEGER)
    FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id` AND `event_type` = 'details'
    ORDER BY `created_at` DESC, `rowid` DESC LIMIT 1
  ), `map_index`),
  `adult_count` = COALESCE((
    SELECT CAST(json_extract(`details_json`, '$.adultCount') AS INTEGER)
    FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id` AND `event_type` = 'details'
    ORDER BY `created_at` DESC, `rowid` DESC LIMIT 1
  ), `adult_count`),
  `youth_count` = COALESCE((
    SELECT CAST(json_extract(`details_json`, '$.youthCount') AS INTEGER)
    FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id` AND `event_type` = 'details'
    ORDER BY `created_at` DESC, `rowid` DESC LIMIT 1
  ), `youth_count`),
  `total_count` = COALESCE((
    SELECT CAST(json_extract(`details_json`, '$.totalCount') AS INTEGER)
    FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id` AND `event_type` = 'details'
    ORDER BY `created_at` DESC, `rowid` DESC LIMIT 1
  ), `total_count`),
  `vehicle_last4` = COALESCE((
    SELECT json_extract(`details_json`, '$.vehicleLast4')
    FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id` AND `event_type` = 'details'
    ORDER BY `created_at` DESC, `rowid` DESC LIMIT 1
  ), `vehicle_last4`),
  `base_amount` = COALESCE((
    SELECT CAST(json_extract(`details_json`, '$.baseAmount') AS INTEGER)
    FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id` AND `event_type` = 'details'
    ORDER BY `created_at` DESC, `rowid` DESC LIMIT 1
  ), `base_amount`),
  `memo` = COALESCE((
    SELECT json_extract(`details_json`, '$.memo')
    FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id` AND `event_type` = 'details'
    ORDER BY `created_at` DESC, `rowid` DESC LIMIT 1
  ), `memo`)
WHERE `source` = 'naver'
  AND EXISTS (
    SELECT 1 FROM `reservation_events`
    WHERE `reservation_id` = `reservations`.`id` AND `event_type` = 'details'
  );--> statement-breakpoint
UPDATE `reservations`
SET
  `status` = 'completed',
  `active_slot_key` = NULL,
  `cancelled_at` = NULL,
  `schedule_overridden` = 1,
  `details_overridden` = 1,
  `room_code` = 'A1',
  `difficulty_code` = 'normal',
  `difficulty_label` = '노멀',
  `map_index` = 3,
  `updated_at` = CURRENT_TIMESTAMP
WHERE `source` = 'naver'
  AND `booking_code` = 'JB-260801-4B0F7C'
  AND `status` = 'cancelled';
