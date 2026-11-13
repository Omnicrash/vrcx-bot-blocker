CREATE TABLE `entries` (
	`user_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`grounds` text NOT NULL,
	`seq` integer NOT NULL,
	`added_at` integer NOT NULL,
	`removed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `entries_seq` ON `entries` (`seq`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`grounds` text NOT NULL,
	`install` text NOT NULL,
	`ip` text NOT NULL,
	`received_at` integer NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `reports_pending` ON `reports` (`outcome`);--> statement-breakpoint
CREATE INDEX `reports_user` ON `reports` (`user_id`);