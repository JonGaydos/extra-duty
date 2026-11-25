ALTER TABLE "jobs" ADD COLUMN "rate_override_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "rate_override_by" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "rate_override_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_rate_override_by_users_id_fk" FOREIGN KEY ("rate_override_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;