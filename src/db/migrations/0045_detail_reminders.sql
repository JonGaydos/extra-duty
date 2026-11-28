CREATE TABLE "detail_reminder_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"hours_before" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"sent" boolean NOT NULL,
	"recipients" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "reminder_hours" integer[];--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "reminder_note" text;--> statement-breakpoint
ALTER TABLE "detail_reminder_sends" ADD CONSTRAINT "detail_reminder_sends_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "detail_reminder_sends_slot_uq" ON "detail_reminder_sends" USING btree ("job_id","hours_before","due_at");