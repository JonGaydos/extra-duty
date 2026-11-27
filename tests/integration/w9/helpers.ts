import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/client";
import { files, w9s } from "@/db/schema";

/** Approves the person's latest W-9 as a reviewer would (signed in January of `year`, March 2024 revision). */
export async function approveCurrentW9(db: Db, userId: string, signedOn = "2026-01-15"): Promise<void> {
  await db
    .update(w9s)
    .set({ status: "approved", signedOn, formRevision: "March 2024", reviewedAt: new Date() })
    .where(and(eq(w9s.userId, userId), eq(w9s.current, true)));
}

/** An approved W-9 row for sign-up rules, with a file row but no stored object (nothing reads it). */
export async function giveApprovedW9(db: Db, userId: string, opts: { signedOn?: string | null; uploadedAt?: Date } = {}): Promise<string> {
  const [file] = await db
    .insert(files)
    .values({ storageKey: `w9/${uuidv7()}`, filename: "W-9.pdf", contentType: "application/pdf", size: 10, encrypted: true, ownerUserId: userId, kind: "w9" })
    .returning();
  await db.update(w9s).set({ current: false }).where(and(eq(w9s.userId, userId), eq(w9s.current, true)));
  const [row] = await db
    .insert(w9s)
    .values({ userId, fileId: file.id, current: true, status: "approved", signedOn: opts.signedOn === undefined ? "2026-01-15" : opts.signedOn, formRevision: "March 2024", uploadedAt: opts.uploadedAt ?? new Date(), reviewedAt: new Date() })
    .returning();
  return row.id;
}
