CREATE TYPE "public"."schedule_exception_kind" AS ENUM('off', 'extra');--> statement-breakpoint
CREATE TYPE "public"."work_schedule_kind" AS ENUM('weekly', 'rotation');--> statement-breakpoint
CREATE TABLE "calendar_busy" (
	"id" text PRIMARY KEY NOT NULL,
	"feed_id" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_feeds" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"url_enc" text NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "earnings_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"monthly_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hidden_vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"kind" "schedule_exception_kind" NOT NULL,
	"shift_start" text,
	"shift_end" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "work_schedule_kind" NOT NULL,
	"weekdays" integer[],
	"cycle" text,
	"anchor_date" date NOT NULL,
	"shift_start" text NOT NULL,
	"shift_end" text NOT NULL,
	"buffer_minutes" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_schedules_buffer_check" CHECK ("work_schedules"."buffer_minutes" in (0, 15, 30, 45, 60))
);
--> statement-breakpoint
ALTER TABLE "calendar_busy" ADD CONSTRAINT "calendar_busy_feed_id_calendar_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."calendar_feeds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings_goals" ADD CONSTRAINT "earnings_goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hidden_vendors" ADD CONSTRAINT "hidden_vendors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hidden_vendors" ADD CONSTRAINT "hidden_vendors_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_busy_feed_idx" ON "calendar_busy" USING btree ("feed_id","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feeds_user_idx" ON "calendar_feeds" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "earnings_goals_user_idx" ON "earnings_goals" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hidden_vendors_user_vendor_idx" ON "hidden_vendors" USING btree ("user_id","vendor_id");--> statement-breakpoint
CREATE INDEX "hidden_vendors_vendor_idx" ON "hidden_vendors" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "schedule_exceptions_user_idx" ON "schedule_exceptions" USING btree ("user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "work_schedules_user_idx" ON "work_schedules" USING btree ("user_id");