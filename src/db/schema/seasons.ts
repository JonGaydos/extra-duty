import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./common";

/** Null cap means not enforced. Month-days are `MM-DD`. */
export const seasons = pgTable("seasons", {
  id: pk(),
  name: text("name").notNull(),
  startMonthDay: text("start_month_day").notNull(),
  endMonthDay: text("end_month_day").notNull(),
  rollingCapMinutes: integer("rolling_cap_minutes"),
  weekCapMinutes: integer("week_cap_minutes"),
  monthCapMinutes: integer("month_cap_minutes"),
  ...timestamps,
});
