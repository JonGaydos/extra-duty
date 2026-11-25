import { waitText } from "@/domain/auth/wait-text";

export type AuthResult = {
  status: number;
  data: { code?: string; message?: string; twoFactorRedirect?: boolean };
  /** Seconds to wait, from a per-IP limit's X-Retry-After header. */
  retryAfter?: number;
};

/**
 * The words for a 429: an account limit carries its own message with the real wait; the per-IP ceiling (many
 * requests from one network) says how long its window has left.
 */
export function tooManyText(r: AuthResult): string {
  if (r.data.code?.startsWith("TOO_MANY") && r.data.message) return r.data.message;
  return `Too many sign-in requests from this network. Wait ${waitText((r.retryAfter ?? 60) * 1000)} and try again.`;
}

/** POST to a Better Auth endpoint under /api/auth from the browser. */
export async function postAuth(path: string, body: unknown): Promise<AuthResult> {
  const res = await fetch(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as AuthResult["data"];
  const retry = Number(res.headers.get("x-retry-after"));
  return { status: res.status, data: data ?? {}, ...(retry > 0 ? { retryAfter: retry } : {}) };
}
