/**
 * Startup clean-up for settings an env file filled in wrong. Docker Compose reads `VAR=  # comment` as the value
 * "# comment", so an install made from an older example file can carry comment text in a setting that should be
 * empty. A URL setting that is not an http or https URL, and an optional setting that starts with "#", are treated as
 * unset, with one warning naming the variable. Required secrets are never touched.
 */

type Env = Record<string, string | undefined>;

/** Settings that hold a web address. VAPID_SUBJECT may also be a mailto: address. */
const URL_SETTINGS = new Set(["APP_URL", "BETTER_AUTH_URL", "S3_ENDPOINT", "VAPID_SUBJECT", "MAP_TILE_URL", "NOMINATIM_URL"]);

/** Settings the app runs without. Passwords are left out: a real password may start with "#". */
const OPTIONAL_SETTINGS = [
  "STAGING_EMAIL_ALLOWLIST",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "TRAINING_DATABASE_URL",
  "TRUSTED_PROXY",
  "SEED_ADMIN_EMAIL",
  "S3_REGION",
  "S3_BUCKET",
  "TRAINING_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "STORAGE_LOCAL_DIR",
  "TRAINING_STORAGE_LOCAL_DIR",
  "MAP_TILE_ATTRIBUTION",
  "PORT",
  "HOST",
];

function isWebUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function urlProblem(name: string, value: string): boolean {
  if (name === "VAPID_SUBJECT" && value.startsWith("mailto:")) return false;
  return !isWebUrl(value);
}

/** Removes the bad values from `env` in place and reports each one through `warn`. */
export function cleanEnv(env: Env = process.env, warn: (message: string) => void = console.warn): void {
  for (const name of [...URL_SETTINGS, ...OPTIONAL_SETTINGS]) {
    const value = env[name]?.trim();
    if (value === undefined) continue;
    if (value === "") {
      delete env[name];
      continue;
    }
    const isUrl = URL_SETTINGS.has(name);
    if (isUrl ? urlProblem(name, value) : value.startsWith("#")) {
      delete env[name];
      warn(
        isUrl
          ? `${name} is not a valid http or https URL, so it is treated as unset. Check the env file: a comment must be on its own line.`
          : `${name} starts with "#", so it is treated as unset. Check the env file: a comment must be on its own line.`,
      );
    }
  }
}
