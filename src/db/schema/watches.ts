import { index, pgTable, text } from "drizzle-orm/pg-core";
import { pk, timestamps, tstz } from "./common";
import { users } from "./users";
import { jobs } from "./jobs";

export const jobWatches = pgTable(
  "job_watches",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    endedAt: tstz("ended_at"),
    ...timestamps,
  },
  (t) => [index("job_watches_job_idx").on(t.jobId), index("job_watches_user_idx").on(t.userId)],
);
