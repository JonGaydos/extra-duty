import { randomBytes } from "node:crypto";

/** A new random password: 18 URL-safe characters. */
export const randomPassword = (): string => randomBytes(13).toString("base64url");

/**
 * The demo accounts' password: DEMO_PASSWORD when it is set. Otherwise a random one for this run, printed once through
 * `print` so the accounts can still be signed in to.
 */
export function demoPassword(env: Record<string, string | undefined> = process.env, print: (line: string) => void = console.log): string {
  if (env.DEMO_PASSWORD) return env.DEMO_PASSWORD;
  const password = randomPassword();
  print(`DEMO_PASSWORD is not set; the demo accounts use a random password for this run: ${password}`);
  return password;
}
