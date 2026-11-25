CREATE TYPE "public"."maps_app" AS ENUM('google', 'apple', 'osm');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_maps_app" "maps_app";