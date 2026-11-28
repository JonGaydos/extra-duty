CREATE TABLE "audit_records" (
	"id" text PRIMARY KEY NOT NULL,
	"number" serial NOT NULL,
	"created_by" text NOT NULL,
	"filters" text[] NOT NULL,
	"query" jsonb NOT NULL,
	"entry_ids" text[] NOT NULL,
	"entry_count" integer NOT NULL,
	"integrity" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_records_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;