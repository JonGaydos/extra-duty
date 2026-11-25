CREATE TYPE "public"."invoice_send_schedule" AS ENUM('immediate', 'weekly', 'every_2_weeks', 'monthly');--> statement-breakpoint
ALTER TYPE "public"."invoice_status" ADD VALUE 'ready_to_send' BEFORE 'sent';--> statement-breakpoint
CREATE TABLE "invoice_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"sent_by" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"early_reason" text,
	"attach_w9_for_all" boolean DEFAULT false NOT NULL,
	"email_status" "invoice_email_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "invoice_send_schedule" "invoice_send_schedule";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "wait_for_all_deputies" boolean;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "w9_requested_by" text;--> statement-breakpoint
ALTER TABLE "invoice_batches" ADD CONSTRAINT "invoice_batches_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_batches" ADD CONSTRAINT "invoice_batches_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_batches_vendor_idx" ON "invoice_batches" USING btree ("vendor_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_batch_id_invoice_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."invoice_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_w9_requested_by_users_id_fk" FOREIGN KEY ("w9_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;