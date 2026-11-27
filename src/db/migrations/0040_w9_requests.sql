CREATE TABLE "w9_request_people" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reminder_stage" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "w9_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"audience" jsonb NOT NULL,
	"audience_label" text NOT NULL,
	"due_on" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "w9_request_people" ADD CONSTRAINT "w9_request_people_request_id_w9_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."w9_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "w9_request_people" ADD CONSTRAINT "w9_request_people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "w9_requests" ADD CONSTRAINT "w9_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "w9_request_people_unique" ON "w9_request_people" USING btree ("request_id","user_id");--> statement-breakpoint
CREATE INDEX "w9_request_people_user_idx" ON "w9_request_people" USING btree ("user_id");