ALTER TABLE "message_recipients" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "requires_ack" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ack_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ack_locks_signups" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ack_reminded_at" timestamp with time zone;