CREATE TYPE "public"."ops_plan_decision" AS ENUM('pending', 'agreed', 'denied');--> statement-breakpoint
CREATE TABLE "ops_plan_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
UPDATE "ops_plan_versions" SET "decision" = NULL WHERE "decision" NOT IN ('agreed', 'denied');--> statement-breakpoint
ALTER TABLE "ops_plan_versions" ALTER COLUMN "decision" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ops_plan_versions" ALTER COLUMN "decision" SET DATA TYPE "public"."ops_plan_decision" USING "decision"::text::"public"."ops_plan_decision";--> statement-breakpoint
ALTER TABLE "ops_plan_versions" ALTER COLUMN "decision" SET DEFAULT 'pending';--> statement-breakpoint
UPDATE "ops_plan_versions" SET "decision" = 'pending' WHERE "decision" IS NULL;--> statement-breakpoint
ALTER TABLE "ops_plan_versions" ALTER COLUMN "decision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "ic_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ops_plan_alerts" ADD CONSTRAINT "ops_plan_alerts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ops_plan_alerts_uq" ON "ops_plan_alerts" USING btree ("job_id","kind","key");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_plans_job_uq" ON "ops_plans" USING btree ("job_id") WHERE "ops_plans"."job_id" is not null;