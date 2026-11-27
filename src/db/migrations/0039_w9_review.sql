CREATE TYPE "public"."w9_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
ALTER TABLE "w9s" ADD COLUMN "status" "w9_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "w9s" ADD COLUMN "uploaded_by" text;--> statement-breakpoint
ALTER TABLE "w9s" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "w9s" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "w9s" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "w9s" ADD COLUMN "signed_on" date;--> statement-breakpoint
ALTER TABLE "w9s" ADD COLUMN "form_revision" text;--> statement-breakpoint
ALTER TABLE "w9s" ADD COLUMN "grandfathered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "w9s" ADD CONSTRAINT "w9s_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "w9s" ADD CONSTRAINT "w9s_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "w9s_user_idx" ON "w9s" USING btree ("user_id");--> statement-breakpoint
-- Owner decision 2026-11-27: every W-9 already on file is approved (grandfathered), signature date unknown, so nobody is
-- sign-up locked by the update. The release step writes a system audit entry for each one.
UPDATE "w9s" SET "status" = 'approved', "grandfathered" = true, "reviewed_at" = now();
