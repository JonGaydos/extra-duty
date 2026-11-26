"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ThemePreference } from "@/domain/users/profile";
import { Icon, type IconName } from "./icons";
import { createThemeChooser } from "./theme-chooser";
import { themeColorFor, themeCookie } from "./theme-cookie";

const CHANGE_EVENT = "ed-theme-change";

const OPTIONS: { value: ThemePreference; label: string; icon: IconName }[] = [
  { value: null, label: "System", icon: "monitor" },
  { value: "day", label: "Day", icon: "sun" },
  { value: "night", label: "Night", icon: "moon" },
];

/** Repaints the page (and the browser chrome color) in a theme, and moves every toggle on the page to it. */
function paint(theme: ThemePreference) {
  const root = document.documentElement;
  if (theme) root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    m.content = themeColorFor(theme, m.getAttribute("media"));
  });
  window.dispatchEvent(new CustomEvent<ThemePreference>(CHANGE_EVENT, { detail: theme }));
}

async function save(theme: ThemePreference): Promise<boolean> {
  const res = await fetch("/api/v1/me/theme", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ theme: theme ?? "system" }),
  }).catch(() => null);
  return Boolean(res?.ok);
}

/** One chooser per page, shared by every toggle on it, so overlapping choices stay ordered. */
let chooser: ReturnType<typeof createThemeChooser> | undefined;
function chooserFor(initial: ThemePreference) {
  const keep = (theme: ThemePreference) => {
    document.cookie = themeCookie(theme);
  };
  chooser ??= createThemeChooser(initial, { save, paint, keep });
  return chooser;
}

const SAVE_ERROR = "Your theme could not be saved. Check your connection and try again.";

/**
 * System, Day or Night. System follows the device; Day and Night are an
 * override kept in a cookie (so the server renders it without a flash) and,
 * when signed in, in the profile (so every device picks it up). Signed in,
 * the choice is kept only once the profile has saved it; if that fails the
 * page returns to the last saved theme and says so (see theme-chooser.ts).
 */
export function ThemeToggle({
  initial,
  signedIn,
  compact = false,
}: Readonly<{
  initial: ThemePreference;
  signedIn: boolean;
  /** Icons only, for the desktop header. */
  compact?: boolean;
}>) {
  const [theme, setTheme] = useState<ThemePreference>(initial);
  const [saveFailed, setSaveFailed] = useState(false);
  const name = useId();

  // Several toggles can be on one page (header and profile); keep them in step.
  useEffect(() => {
    const onChange = (e: Event) => setTheme((e as CustomEvent<ThemePreference>).detail);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  async function choose(next: ThemePreference) {
    setSaveFailed(false);
    const result = await chooserFor(initial).choose(next, signedIn);
    if (result?.failed) setSaveFailed(true);
  }

  // The header note closes on Escape or a click outside it.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!saveFailed || !compact) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSaveFailed(false);
    const onPointer = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setSaveFailed(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [saveFailed, compact]);

  return (
    <div ref={box} className={compact ? "relative" : "flex flex-col gap-2"}>
      <div
        role="radiogroup"
        aria-label="Theme"
        className="inline-flex w-fit gap-0.5 rounded-md border border-line bg-surface p-0.5"
      >
        {OPTIONS.map((o) => (
          <label
            key={o.label}
            title={compact ? o.label : undefined}
            className={[
              "relative flex cursor-pointer items-center justify-center gap-1.5 rounded-sm font-medium text-muted",
              "has-checked:bg-accent-soft has-checked:font-semibold has-checked:text-link",
              "has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-focus",
              "not-has-checked:hover:text-ink",
              compact ? "size-8 pointer-coarse:size-11" : "h-10 px-3 text-sm pointer-coarse:h-11",
            ].join(" ")}
          >
            <input
              type="radio"
              name={name}
              className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-sm opacity-0"
              checked={theme === o.value}
              onChange={() => void choose(o.value)}
            />
            <Icon name={o.icon} size={compact ? 18 : 16} />
            <span className={compact ? "sr-only" : undefined}>{o.label}</span>
          </label>
        ))}
      </div>
      {saveFailed && compact ? (
        <div className="absolute top-full right-0 z-30 mt-2 flex w-64 flex-col gap-2 rounded-md border border-danger-line bg-danger-soft p-3 shadow-float">
          <p role="alert" className="m-0 text-xs font-medium text-danger-ink">
            {SAVE_ERROR}
          </p>
          <button
            type="button"
            onClick={() => setSaveFailed(false)}
            className="h-8 self-end rounded-sm px-2 text-xs font-semibold text-danger-ink hover:bg-danger-line/40 pointer-coarse:h-11"
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {saveFailed && !compact ? (
        <p role="alert" className="m-0 text-xs font-medium text-danger-ink">
          {SAVE_ERROR}
        </p>
      ) : null}
    </div>
  );
}
