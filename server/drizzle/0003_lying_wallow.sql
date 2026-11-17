CREATE TABLE `automation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`automation_id` integer NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`exit_code` integer,
	`output` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `automation_runs_idx` ON `automation_runs` (`automation_id`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source` text DEFAULT 'inline' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`file_path` text DEFAULT '' NOT NULL,
	`interpreter` text DEFAULT '' NOT NULL,
	`cwd` text DEFAULT '' NOT NULL,
	`env` text NOT NULL,
	`triggers` text NOT NULL,
	`manual` integer DEFAULT false NOT NULL,
	`timeout_sec` integer DEFAULT 3600 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
