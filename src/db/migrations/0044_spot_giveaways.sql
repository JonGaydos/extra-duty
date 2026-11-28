CREATE TYPE "public"."spot_giveaway_status" AS ENUM('open', 'taken', 'withdrawn', 'canceled', 'ended');--> statement-breakpoint
CREATE TABLE "spot_giveaways" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"job_position_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" "spot_giveaway_status" DEFAULT 'open' NOT NULL,
	"taken_by_assignment_id" text,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	"reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spot_giveaways" ADD CONSTRAINT "spot_giveaways_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spot_giveaways" ADD CONSTRAINT "spot_giveaways_job_position_id_job_positions_id_fk" FOREIGN KEY ("job_position_id") REFERENCES "public"."job_positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spot_giveaways" ADD CONSTRAINT "spot_giveaways_taken_by_assignment_id_assignments_id_fk" FOREIGN KEY ("taken_by_assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spot_giveaways" ADD CONSTRAINT "spot_giveaways_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spot_giveaways_open_uq" ON "spot_giveaways" USING btree ("assignment_id") WHERE "spot_giveaways"."status" = 'open';--> statement-breakpoint
CREATE INDEX "spot_giveaways_position_idx" ON "spot_giveaways" USING btree ("job_position_id");