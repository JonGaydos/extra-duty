"use server";

import { acceptInvite } from "@/domain/auth/invites";
import { ValidationError } from "@/domain/errors";

export async function acceptInviteAction(token: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await acceptInvite(token, password);
    return { ok: true };
  } catch (e) {
    if (e instanceof ValidationError) return { ok: false, error: e.message };
    return { ok: false, error: "Something went wrong. Try again." };
  }
}
