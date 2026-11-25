import { index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./common";

export type OutboxAttachment = { filename: string; contentType: string; size: number };

/**
 * Every email the app would have sent in training mode (in the training database) or on staging. Nothing in this
 * table was ever sent. Attachments are kept as names and sizes only.
 */
export const trainingOutbox = pgTable(
  "training_outbox",
  {
    id: pk(),
    to: text("to").array().notNull(),
    replyTo: text("reply_to"),
    subject: text("subject").notNull(),
    text: text("text").notNull(),
    html: text("html").notNull(),
    attachments: jsonb("attachments").$type<OutboxAttachment[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [index("training_outbox_created_idx").on(t.createdAt)],
);
