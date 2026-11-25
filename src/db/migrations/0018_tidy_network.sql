ALTER TABLE "calendar_feeds" ALTER COLUMN "url_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD COLUMN "last_sync_requested_at" timestamp with time zone;