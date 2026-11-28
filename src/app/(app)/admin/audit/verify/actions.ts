"use server";

import { verifyAuditRecord } from "@/domain/audit/records";
import { DomainError } from "@/domain/errors";
import { agencyStamp } from "@/domain/time/agency-time";
import { requestContext, runInRequest, withTx } from "@/ui/shell/request";

export type VerifyView = { matches: boolean; printedMatches: boolean | null; headline: string; lines: string[]; integrity: string };

/** Checks a printed Audit Record against the audit data as it is now. Admins only. */
export async function verifyRecordAction(recordId: string, integrity: string): Promise<{ ok: true; view: VerifyView } | { ok: false; error: string }> {
  const ctx = await requestContext();
  if (!ctx) return { ok: false, error: "Sign in again to check a record." };
  try {
    const v = await runInRequest(ctx, () => withTx((tx) => verifyAuditRecord(ctx.actor, tx, { recordId, integrity: integrity || null })));
    const good = v.matches && v.printedMatches !== false;
    const headline = good ? `${v.recordId} matches the audit log.` : `${v.recordId} does not match the audit log.`;
    const lines = [
      `Printed ${agencyStamp(v.createdAt)} by ${v.createdBy}, ${v.entryCount} ${v.entryCount === 1 ? "entry" : "entries"}.`,
      v.matches ? "The entries in the audit log are unchanged since it was printed." : "The entries in the audit log differ from the printed record.",
      ...(v.missing > 0 ? [`${v.missing} ${v.missing === 1 ? "entry is" : "entries are"} missing from the audit log.`] : []),
      ...(v.printedMatches === null ? ["No printed integrity code was given to compare."] : [v.printedMatches ? "The integrity code you entered is this record's code." : "The integrity code you entered is not this record's code."]),
      ...v.filters.map((f) => `Filter: ${f}`),
    ];
    return { ok: true, view: { matches: v.matches, printedMatches: v.printedMatches, headline, lines, integrity: v.integrity } };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, error: e.message };
    throw e;
  }
}
