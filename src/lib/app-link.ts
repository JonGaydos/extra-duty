import { trimTrailingSlashes } from "./text";

let warnedNoBase = false;

/** The full address of an app path for an email (APP_URL, else BETTER_AUTH_URL), or null when neither is set. */
export function appLink(path: string): string | null {
  const base = process.env.APP_URL ?? process.env.BETTER_AUTH_URL;
  if (!base) {
    if (!warnedNoBase) {
      warnedNoBase = true;
      console.warn("Alert emails have no link: set APP_URL or BETTER_AUTH_URL.");
    }
    return null;
  }
  return `${trimTrailingSlashes(base)}${path}`;
}
