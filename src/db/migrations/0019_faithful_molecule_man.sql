CREATE TYPE "public"."theme_preference" AS ENUM('day', 'night');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "theme_preference" "theme_preference";