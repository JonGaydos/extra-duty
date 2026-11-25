CREATE TABLE "auth_throttle" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "sign_in_failures" CASCADE;--> statement-breakpoint
CREATE INDEX "auth_throttle_kind_key_at_idx" ON "auth_throttle" USING btree ("kind","key","at");