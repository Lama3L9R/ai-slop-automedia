CREATE TABLE `artifacts` (
	`path` text PRIMARY KEY NOT NULL,
	`media_id` integer NOT NULL,
	`source_url` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`media_id` integer NOT NULL,
	`season` integer NOT NULL,
	`number` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`air_date` text DEFAULT '' NOT NULL,
	`runtime` real,
	`still_url` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`media_id`, `season`, `number`)
);
--> statement-breakpoint
CREATE TABLE `links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_id` integer NOT NULL,
	`season` integer NOT NULL,
	`episode` integer NOT NULL,
	`kind` text NOT NULL,
	`suffix` text DEFAULT '' NOT NULL,
	`ext` text NOT NULL,
	`source_type` text NOT NULL,
	`source_ref` text NOT NULL,
	`source_name` text DEFAULT '' NOT NULL,
	`source_path` text NOT NULL,
	`target_path` text NOT NULL,
	`link_mode` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_target_idx` ON `links` (`target_path`);--> statement-breakpoint
CREATE INDEX `links_media_idx` ON `links` (`media_id`);--> statement-breakpoint
CREATE INDEX `links_source_idx` ON `links` (`source_type`,`source_ref`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text DEFAULT 'series' NOT NULL,
	`title` text NOT NULL,
	`original_title` text DEFAULT '' NOT NULL,
	`sort_title` text DEFAULT '' NOT NULL,
	`year` integer,
	`premiered` text DEFAULT '' NOT NULL,
	`status` text DEFAULT '' NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`rating` real,
	`genres` text NOT NULL,
	`studios` text NOT NULL,
	`tvdb_id` text DEFAULT '' NOT NULL,
	`tmdb_id` text DEFAULT '' NOT NULL,
	`imdb_id` text DEFAULT '' NOT NULL,
	`poster_url` text DEFAULT '' NOT NULL,
	`fanart_url` text DEFAULT '' NOT NULL,
	`library_id` text DEFAULT '' NOT NULL,
	`folder_path` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `seasons` (
	`media_id` integer NOT NULL,
	`number` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`poster_url` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`media_id`, `number`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `torrents` (
	`hash` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'new' NOT NULL,
	`updated_at` integer NOT NULL
);
