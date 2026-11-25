ALTER TABLE "users" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deactivated_by" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deactivation_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_day" date;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "written_off_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "written_off_by" text;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "write_off_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_written_off_by_users_id_fk" FOREIGN KEY ("written_off_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;