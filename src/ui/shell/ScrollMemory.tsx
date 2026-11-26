"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef } from "react";

const PREFIX = "ed-scroll:";
const keyOf = (pathname: string, search: string) => {
  const query = search ? `?${search}` : "";
  return `${PREFIX}${pathname}${query}`;
};

/** Puts main back where it was on that page, after the page has painted and the router has done its own scroll. */
function restore(key: string): void {
  const main = document.getElementById("main");
  let saved: number | null = null;
  try {
    const v = sessionStorage.getItem(key);
    saved = v === null ? null : Number(v);
  } catch {
    saved = null;
  }
  if (!main || saved === null || !Number.isFinite(saved)) return;
  const top = saved;
  requestAnimationFrame(() => requestAnimationFrame(() => main.scrollTo({ top })));
}

/**
 * Phones scroll `main`, not the document, so the browser's own scroll restoration does not cover it. This keeps
 * main's position per page (path and query, so each filtered list has its own) in sessionStorage and puts it back
 * on Back and Forward, so a deputy returns to the same place in a list. Any other navigation (a link tap, a filter)
 * opens at the top as the router leaves it. Storage can be missing or blocked (private windows); then nothing is
 * restored.
 *
 * The router may render the new page inside its own popstate listener, before ours runs, or after it; both orders
 * are handled, and a Back or Forward only ever applies to the navigation it caused.
 */
export function ScrollMemory() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const key = useRef<string | null>(null);
  // A Back or Forward seen before its page rendered: the page it is going to.
  const pending = useRef<string | null>(null);
  // The page that rendered in this task, in case the Back or Forward that caused it is seen just after.
  const justChanged = useRef<string | null>(null);

  useEffect(() => {
    const main = document.getElementById("main");
    if (!main) return;
    let frame = 0;
    const save = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          if (key.current) sessionStorage.setItem(key.current, String(Math.round(main.scrollTop)));
        } catch {
          // Storage blocked: positions are simply not kept.
        }
      });
    };
    const popped = () => {
      const target = keyOf(window.location.pathname, window.location.search.replace(/^\?/, ""));
      if (target !== key.current) pending.current = target;
      // The page already rendered for this Back or Forward.
      else if (justChanged.current === target) restore(target);
      // Otherwise a hash-only move (Skip to content, or Back over it): not a page change, nothing to restore.
    };
    main.addEventListener("scroll", save, { passive: true });
    window.addEventListener("popstate", popped);
    return () => {
      cancelAnimationFrame(frame);
      main.removeEventListener("scroll", save);
      window.removeEventListener("popstate", popped);
    };
  }, []);

  // A layout effect, so the new page's key is set before any scroll event from the route change is saved
  // (a passive effect can run after the next frame, which would file the new page's top under the old page).
  useLayoutEffect(() => {
    const now = keyOf(pathname, search);
    if (now === key.current) return;
    key.current = now;
    // Any pending Back or Forward is used up by this navigation, whatever kind it is.
    const fromHistory = pending.current === now;
    pending.current = null;
    if (fromHistory) restore(now);
    justChanged.current = now;
    const t = setTimeout(() => {
      if (justChanged.current === now) justChanged.current = null;
    }, 0);
    return () => clearTimeout(t);
  }, [pathname, search]);

  return null;
}
