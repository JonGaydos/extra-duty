import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { users } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { NotFoundError, ValidationError } from "../errors";
import { cleanChangedPhone } from "../phone";

export type OwnContact = { name: string; email: string; phone: string | null; mailingAddress: string | null };

const MAX_ADDRESS = 500;

function clean(v: string | null | undefined, max: number, label: string): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  if (t.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer.`);
  return t || null;
}

/** The signed-in person's own contact details. Email is the sign-in name and changes only through a coordinator. */
export async function getOwnContact(actor: Actor, tx: Tx): Promise<OwnContact> {
  assertCan(actor, "profile.updateOwn", { ownerUserId: actor.userId });
  const [row] = await tx
    .select({ name: users.name, email: users.email, phone: users.phone, mailingAddress: users.mailingAddress })
    .from(users)
    .where(eq(users.id, actor.userId));
  if (!row) throw new NotFoundError("User not found.");
  return row;
}

/** Updates the person's own phone and mailing address (the address prints on their invoices). Blank clears. */
export async function updateOwnContact(actor: Actor, tx: Tx, input: { phone: string | null; mailingAddress: string | null }): Promise<OwnContact> {
  assertCan(actor, "profile.updateOwn", { ownerUserId: actor.userId });
  const before = await getOwnContact(actor, tx);
  const phone = cleanChangedPhone(input.phone, before.phone);
  const mailingAddress = clean(input.mailingAddress, MAX_ADDRESS, "Mailing address");
  await tx.update(users).set({ phone, mailingAddress, updatedAt: new Date() }).where(eq(users.id, actor.userId));
  const after = { ...before, phone, mailingAddress };
  await recordAudit(tx, {
    actor,
    action: "user.contact_update",
    entityType: "user",
    entityId: actor.userId,
    before: { phone: before.phone, mailingAddress: before.mailingAddress },
    after: { phone, mailingAddress },
  });
  return after;
}
