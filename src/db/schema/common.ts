import { text, timestamp } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

/** UUIDv7 text primary key, generated in the app. */
export const pk = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const tstz = (name: string) => timestamp(name, { withTimezone: true });
