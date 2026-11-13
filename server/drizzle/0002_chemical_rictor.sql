CREATE TABLE `checks` (
	`user_id` text PRIMARY KEY NOT NULL,
	`facts` text NOT NULL,
	`first_checked_at` integer NOT NULL,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `words` (
	`word` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`first_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `entries` ADD `removed_by` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `caught_by` text;--> statement-breakpoint
UPDATE `reports` SET `outcome` = 'pending' WHERE `outcome` IN ('accepted', 'rejected', 'known');
