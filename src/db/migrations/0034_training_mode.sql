CREATE TYPE "public"."data_mode" AS ENUM('live', 'training');--> statement-breakpoint
CREATE TYPE "public"."practice_role" AS ENUM('deputy', 'coordinator', 'admin', 'vendor');--> statement-breakpoint
CREATE TABLE "training_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"to" text[] NOT NULL,
	"reply_to" text,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"html" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "mode" "data_mode" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "practice_role" "practice_role";--> statement-breakpoint
CREATE INDEX "training_outbox_created_idx" ON "training_outbox" USING btree ("created_at");