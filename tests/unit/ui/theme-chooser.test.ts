import { describe, expect, test } from "vitest";
import type { ThemePreference } from "@/domain/users/profile";
import { createThemeChooser } from "@/ui/theme-chooser";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A chooser whose saves resolve only when the test says so. */
function setup(initial: ThemePreference) {
  const saves: { theme: ThemePreference; done: ReturnType<typeof deferred<boolean>> }[] = [];
  const screen: ThemePreference[] = [];
  const cookie: ThemePreference[] = [];
  const chooser = createThemeChooser(initial, {
    save: (theme) => {
      const done = deferred<boolean>();
      saves.push({ theme, done });
      return done.promise;
    },
    paint: (t) => screen.push(t),
    keep: (t) => cookie.push(t),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { chooser, saves, screen, cookie, flush, last: <T,>(a: T[]) => a[a.length - 1] };
}

describe("theme chooser", () => {
  test("a failed save returns the screen and cookie to the last saved theme", async () => {
    const t = setup(null);
    const result = t.chooser.choose("day", true);
    expect(t.last(t.screen)).toBe("day");
    await t.flush();
    t.saves[0].done.resolve(false);
    expect(await result).toEqual({ theme: null, failed: true });
    expect(t.last(t.screen)).toBeNull();
    expect(t.last(t.cookie)).toBeNull();
  });

  test("overlapping choices: an earlier failure never undoes a later choice that saved", async () => {
    const t = setup(null);
    const day = t.chooser.choose("day", true);
    const night = t.chooser.choose("night", true);
    await t.flush();
    // Saves go out one at a time, in the order chosen.
    expect(t.saves.map((s) => s.theme)).toEqual(["day"]);
    t.saves[0].done.resolve(false);
    expect(await day).toBeNull(); // stale: no repaint, no error
    expect(t.last(t.screen)).toBe("night");
    await t.flush();
    expect(t.saves.map((s) => s.theme)).toEqual(["day", "night"]);
    t.saves[1].done.resolve(true);
    expect(await night).toEqual({ theme: "night", failed: false });
    expect(t.last(t.screen)).toBe("night");
    expect(t.last(t.cookie)).toBe("night");
  });

  test("overlapping choices: a later failure falls back to the earlier choice that saved", async () => {
    const t = setup(null);
    const day = t.chooser.choose("day", true);
    const night = t.chooser.choose("night", true);
    await t.flush();
    t.saves[0].done.resolve(true);
    expect(await day).toBeNull();
    await t.flush();
    t.saves[1].done.resolve(false);
    expect(await night).toEqual({ theme: "day", failed: true });
    expect(t.last(t.screen)).toBe("day");
    expect(t.last(t.cookie)).toBe("day");
  });

  test("signed out, a choice is kept at once with no save", async () => {
    const t = setup(null);
    expect(await t.chooser.choose("night", false)).toEqual({ theme: "night", failed: false });
    expect(t.saves).toHaveLength(0);
    expect(t.last(t.cookie)).toBe("night");
  });
});
