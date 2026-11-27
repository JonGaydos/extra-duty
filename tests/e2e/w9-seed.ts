import type { Db } from "@/db/client";
import { w9s } from "@/db/schema";
import { storeFile } from "@/domain/files/files";

const W9_PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% Test W-9 (no real taxpayer data)\n%%EOF\n");

/**
 * An approved W-9 for a person, stored encrypted like an upload, so they can sign up (the W-9 sign-up lock,
 * owner decision 2026-11-27) and invoices can attach it. Signed in January of the current year by default.
 */
export async function seedApprovedW9(db: Db, userId: string, signedOn = `${new Date().getFullYear()}-01-15`): Promise<void> {
  await db.transaction(async (tx) => {
    const file = await storeFile("system", tx, { kind: "w9", filename: "W-9.pdf", contentType: "application/pdf", body: W9_PDF, ownerUserId: userId }, { only: "pdf" });
    await tx.insert(w9s).values({ userId, fileId: file.id, current: true, status: "approved", signedOn, formRevision: "March 2024", reviewedAt: new Date() });
  });
}
