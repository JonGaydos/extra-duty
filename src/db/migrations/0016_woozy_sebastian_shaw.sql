CREATE TABLE "saved_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text,
	"name" text NOT NULL,
	"spec" jsonb NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_reports_owner_idx" ON "saved_reports" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_reports_built_in_name_uq" ON "saved_reports" USING btree ("name") WHERE "saved_reports"."built_in";