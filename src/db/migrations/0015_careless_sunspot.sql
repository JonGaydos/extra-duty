CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."deputy_note_status" AS ENUM('pending', 'approved', 'denied', 'retired');--> statement-breakpoint
CREATE TABLE "deputy_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"location_id" text,
	"body" text NOT NULL,
	"status" "deputy_note_status" DEFAULT 'pending' NOT NULL,
	"submitted_by" text NOT NULL,
	"submitted_from_job_id" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deputy_notes" ADD CONSTRAINT "deputy_notes_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deputy_notes" ADD CONSTRAINT "deputy_notes_location_id_vendor_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."vendor_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deputy_notes" ADD CONSTRAINT "deputy_notes_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deputy_notes" ADD CONSTRAINT "deputy_notes_submitted_from_job_id_jobs_id_fk" FOREIGN KEY ("submitted_from_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deputy_notes" ADD CONSTRAINT "deputy_notes_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deputy_notes_vendor_idx" ON "deputy_notes" USING btree ("vendor_id","status");