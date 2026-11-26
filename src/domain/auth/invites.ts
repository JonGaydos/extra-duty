import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { uuidv7 } from "uuidv7";
import { withTx, type Tx } from "@/db/client";
import { accounts, invites, users } from "@/db/schema";
import { inviteEmail } from "@/lib/email/templates/invite";
import { queueEmail } from "@/jobs/boss";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { getSettings } from "../settings/settings";
import { trimTrailingSlashes } from "@/lib/text";

const INVITE_VALID_DAYS = 7;
const MAX_PASSWORD_LENGTH = 128;
const INVALID_INVITE = "This invite link is not valid. It may have expired or already been used. Ask a coordinator for a new invite.";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function appUrl(): string {
  const url = process.env.BETTER_AUTH_URL;
  if (!url) throw new Error("BETTER_AUTH_URL is not set");
  return trimTrailingSlashes(url);
}

/** Queues the email (sent after commit) with a one-time link, valid 7 days, for the user to set a password. Coordinators and admins only; only admins invite admins. */
export async function createInvite(actor: Actor, tx: Tx, userId: string): Promise<void> {
  if (actor.role !== "admin" && actor.role !== "coordinator") {
    throw new ForbiddenError("Only coordinators and admins can send invites.");
  }
  const [user] = await tx
    .select({ id: users.id, email: users.email, active: users.active, role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw new NotFoundError("User not found.");
  if (user.role === "admin" && actor.role !== "admin") throw new ForbiddenError("Only admins can manage admin accounts.");
  if (!user.active) throw new ValidationError("This account is deactivated.");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_VALID_DAYS * 86_400_000);
  const [row] = await tx
    .insert(invites)
    .values({ userId, tokenHash: hashToken(token), expiresAt, createdBy: actor.userId })
    .returning({ id: invites.id });
  await recordAudit(tx, {
    actor,
    action: "user.invite",
    entityType: "user",
    entityId: userId,
    after: { inviteId: row.id, expiresAt },
  });

  const { agency } = await getSettings(tx);
  await queueEmail(tx, inviteEmail(user.email, agency.name, `${appUrl()}/accept-invite?token=${token}`));
}

/** Sets the invited user's password and marks the invite used. Reused, expired or unknown tokens are refused. */
export async function acceptInvite(token: string, password: string): Promise<void> {
  if (typeof token !== "string" || !token) throw new ValidationError(INVALID_INVITE);
  if (typeof password !== "string") throw new ValidationError("Enter a password.");

  await withTx(async (tx) => {
    const now = new Date();
    const [invite] = await tx
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .for("update");
    if (!invite || invite.usedAt || invite.expiresAt <= now) throw new ValidationError(INVALID_INVITE);

    const [user] = await tx.select({ active: users.active }).from(users).where(eq(users.id, invite.userId));
    if (!user?.active) throw new ValidationError("This account is deactivated.");

    const { security } = await getSettings(tx);
    if (password.length < security.passwordMinLength) {
      throw new ValidationError(`Password must be at least ${security.passwordMinLength} characters.`);
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new ValidationError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
    }

    const hash = await hashPassword(password);
    const [existing] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, invite.userId), eq(accounts.providerId, "credential")));
    if (existing) {
      await tx.update(accounts).set({ password: hash, updatedAt: now }).where(eq(accounts.id, existing.id));
    } else {
      await tx.insert(accounts).values({
        id: uuidv7(),
        accountId: invite.userId,
        providerId: "credential",
        userId: invite.userId,
        password: hash,
      });
    }
    await tx
      .update(users)
      .set({ emailVerified: true, twoFactorEnabled: true })
      .where(eq(users.id, invite.userId));
    await tx
      .update(invites)
      .set({ usedAt: now })
      .where(and(eq(invites.userId, invite.userId), isNull(invites.usedAt)));
    await recordAudit(tx, {
      actor: "system",
      action: "user.invite_accepted",
      entityType: "user",
      entityId: invite.userId,
      after: { inviteId: invite.id },
    });
  });
}
