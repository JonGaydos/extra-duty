ALTER TABLE "vendor_documents" ADD COLUMN "reminded_60_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_documents" ADD COLUMN "reminded_30_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_locations" ADD COLUMN "active" boolean DEFAULT true NOT NULL;