"use server";

import { isAPIError } from "better-auth/api";
import { headers } from "next/headers";
import { sendSignInCode } from "@/lib/auth";

type SendResult = { ok: true } | { ok: false; reason: "rate_limited" | "failed"; message?: string };

/** Sends a fresh code for the pending sign-in. */
export async function sendCode(): Promise<SendResult> {
  try {
    await sendSignInCode(await headers());
    return { ok: true };
  } catch (e) {
    if (isAPIError(e) && e.statusCode === 429) return { ok: false, reason: "rate_limited", message: e.body?.message };
    return { ok: false, reason: "failed" };
  }
}
