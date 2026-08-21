ALTER TABLE `reservations` ADD `payment_card_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `payment_cash_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `payment_account_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `reservations`
SET `payment_card_amount` = MAX(
  0,
  `payment_amount` -
    CASE
      WHEN `source` = 'naver' THEN MIN(5000, `payment_amount`)
      ELSE 0
    END
)
WHERE `payment_status` = 'paid' AND `payment_method` = 'card';--> statement-breakpoint
UPDATE `reservations`
SET `payment_cash_amount` = MAX(
  0,
  `payment_amount` -
    CASE
      WHEN `source` = 'naver' THEN MIN(5000, `payment_amount`)
      ELSE 0
    END
)
WHERE `payment_status` = 'paid' AND `payment_method` = 'cash';--> statement-breakpoint
UPDATE `reservations`
SET `payment_account_amount` = MAX(
  0,
  `payment_amount` -
    CASE
      WHEN `source` = 'naver' THEN MIN(5000, `payment_amount`)
      ELSE 0
    END
)
WHERE `payment_status` = 'paid' AND `payment_method` = 'account';
