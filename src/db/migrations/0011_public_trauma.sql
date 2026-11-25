CREATE TYPE "public"."job_change_status" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
CREATE TABLE "job_change_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"patch" jsonb NOT NULL,
	"status" "job_change_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_change_requests" ADD CONSTRAINT "job_change_requests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_change_requests" ADD CONSTRAINT "job_change_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_change_requests" ADD CONSTRAINT "job_change_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_change_requests_job_idx" ON "job_change_requests" USING btree ("job_id");