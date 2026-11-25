/**
 * The capture's safety rule: screenshots are taken only of demo data. That is the staging site (APP_ENV=staging,
 * which runs on the demo agency), or a page that shows the training banner (a coordinator or admin practicing on the
 * training database). Anything else, including a site that does not say which it is, is refused.
 */
export type CaptureTarget = {
  /** What the site's /api/health reports. */
  appEnv: string | undefined;
  /** Whether the page about to be captured shows "TRAINING: practicing as". */
  trainingBanner: boolean;
};

export function captureRefusal(t: CaptureTarget): string | null {
  if (t.appEnv === "staging") return null;
  if (t.appEnv === "production" && t.trainingBanner) return null;
  if (t.appEnv === "production") return "Refusing to capture: this is a live site and the page is not in training mode. Use staging, or switch to training first.";
  return "Refusing to capture: the site did not say it is staging (GET /api/health has no appEnv).";
}
