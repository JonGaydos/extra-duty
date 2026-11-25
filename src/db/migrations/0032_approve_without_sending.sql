ALTER TYPE "public"."invoice_status" ADD VALUE 'approved_unsent';--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "email_approved_invoices" boolean DEFAULT true NOT NULL;