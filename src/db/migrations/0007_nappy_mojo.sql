ALTER TYPE "public"."invoice_email_status" ADD VALUE 'not_queued';--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "minimum_override_minutes" integer;