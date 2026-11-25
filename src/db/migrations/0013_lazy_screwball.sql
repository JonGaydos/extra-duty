CREATE TYPE "public"."payment_issue_note_visibility" AS ENUM('internal', 'deputy', 'vendor');--> statement-breakpoint
ALTER TABLE "payment_issue_notes" ADD COLUMN "visibility" "payment_issue_note_visibility" DEFAULT 'deputy' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_issues" ADD COLUMN "closed_at" timestamp with time zone;