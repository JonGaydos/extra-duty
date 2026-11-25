import { jsonb, pgTable } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./common";

/** Single row holding all settings. */
export const settings = pgTable("settings", {
  id: pk(),
  value: jsonb("value").notNull().default({}),
  ...timestamps,
});
