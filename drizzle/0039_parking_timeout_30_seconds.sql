UPDATE kiosk_parking_settings
SET session_max_seconds = 30,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;
