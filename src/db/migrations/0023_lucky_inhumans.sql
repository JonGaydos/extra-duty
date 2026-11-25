ALTER TABLE "job_positions" ADD COLUMN "rate_differential_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "position_types" ADD COLUMN "rate_differential_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "position_types" SET "rate_differential_cents" = 2500 WHERE "is_incident_commander" = true;
