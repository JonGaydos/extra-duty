ALTER TABLE "invoice_events" ALTER COLUMN "vendor_visible" SET DEFAULT false;
--> statement-breakpoint
UPDATE "invoice_events" SET "vendor_visible" = ("event" IN ('sent', 'revised', 'responsibility', 'vendor_paid', 'deputy_paid', 'closed_paid', 'closed_written_off'));
