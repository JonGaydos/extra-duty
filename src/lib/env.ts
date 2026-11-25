/**
 * Which deployment this is. `production` is the live site (it carries training mode). `staging` is the copy where
 * new versions are checked first: it runs on demo data and sends no email (every message goes to the outbox).
 * Anything other than "staging", including unset, is production, so codes are never shown by accident.
 */
export type AppEnv = "production" | "staging";

export function appEnvFromProcess(): AppEnv {
  return process.env.APP_ENV === "staging" ? "staging" : "production";
}
