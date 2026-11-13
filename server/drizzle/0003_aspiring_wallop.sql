CREATE TABLE `recommendations` (
	`key` text PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`reasoning` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `whitelist` (
	`hash` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL
);
