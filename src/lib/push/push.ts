// A namespace import: web-push 4 is an ES module with named exports only (no default), and the worker runs under plain Node ESM.
import * as webpush from "web-push";

export type PushPayload = { title: string; body: string; url: string };
export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };

let warned = false;

/** True when the VAPID keys are set. Without them push is skipped, with one warning per process. */
export function pushConfigured(): boolean {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) return true;
  if (!warned) {
    warned = true;
    console.warn("Web push is disabled: set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT.");
  }
  return false;
}

/** Sends one push. Throws web-push's error (with `statusCode`) on failure; the caller decides what a 404 or 410 means. */
export async function sendPush(target: PushTarget, payload: PushPayload): Promise<void> {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT!, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  await webpush.sendNotification(target, JSON.stringify(payload));
}

/** True when the push service says the endpoint no longer exists. */
export function isGone(err: unknown): boolean {
  const code = (err as { statusCode?: number } | null)?.statusCode;
  return code === 404 || code === 410;
}
