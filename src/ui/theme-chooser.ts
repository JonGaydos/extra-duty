import type { ThemePreference } from "@/domain/users/profile";

export type ThemeChooserDeps = {
  /** Saves to the profile; resolves true when it was saved. */
  save(theme: ThemePreference): Promise<boolean>;
  /** Shows a theme on screen. */
  paint(theme: ThemePreference): void;
  /** Stores a theme on this device (the cookie). */
  keep(theme: ThemePreference): void;
};

/**
 * Orders theme choices so the screen, the cookie and the profile end up
 * agreeing even when choices overlap. Saves go out one at a time in the order
 * chosen; only the latest choice's outcome touches the screen or the cookie;
 * a failure falls back to the last theme that was actually saved.
 */
export function createThemeChooser(initial: ThemePreference, deps: ThemeChooserDeps) {
  let confirmed = initial;
  let latest = 0;
  let queue: Promise<unknown> = Promise.resolve();

  /** Resolves with what is now shown and whether the choice failed, or null when a newer choice superseded it. */
  async function choose(next: ThemePreference, persist: boolean): Promise<{ theme: ThemePreference; failed: boolean } | null> {
    const id = ++latest;
    deps.paint(next);
    if (!persist) {
      confirmed = next;
      deps.keep(next);
      return { theme: next, failed: false };
    }
    const run = queue.then(() => deps.save(next)).catch(() => false);
    queue = run;
    const ok = await run;
    if (ok) confirmed = next;
    if (id !== latest) return null;
    if (ok) {
      deps.keep(next);
      return { theme: next, failed: false };
    }
    deps.paint(confirmed);
    deps.keep(confirmed);
    return { theme: confirmed, failed: true };
  }

  return { choose };
}
