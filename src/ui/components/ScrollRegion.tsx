"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A horizontally scrolling box that becomes a labeled, focusable region only
 * while its content is wider than it, so keyboard users can scroll it without
 * every table adding a tab stop.
 */
export function ScrollRegion({ label, className, children }: Readonly<{ label: string; className?: string; children: ReactNode }>) {
  const ref = useRef<HTMLElement>(null);
  const [scrolls, setScrolls] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);

  return (
    // A section is a named region only while it has a label, so it is one only while it scrolls.
    <section ref={ref} className={className} aria-label={scrolls ? label : undefined} tabIndex={scrolls ? 0 : undefined}>
      {children}
    </section>
  );
}
