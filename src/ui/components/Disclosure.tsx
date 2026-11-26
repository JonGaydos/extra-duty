"use client";

import { useId, useState, type ReactNode } from "react";
import { Icon } from "../icons";

/**
 * A disclosure toggle ("9 other checks passed", "Show 3 more"): a tertiary button, not a link, with a chevron
 * that turns when open and aria-expanded. The content is rendered only while open. Pass `open` and `onOpenChange`
 * when the parent needs to know (an optional form section whose values count only while it is open).
 */
export function Disclosure({
  label,
  openLabel,
  children,
  className,
  open: controlled,
  onOpenChange,
}: Readonly<{
  label: ReactNode;
  openLabel?: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}>) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (v: boolean) => {
    setOwn(v);
    onOpenChange?.(v);
  };
  const id = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-sm text-sm font-semibold text-link hover:text-link-hover"
      >
        <Icon name="chevronDown" size={16} className={`shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
        {open && openLabel ? openLabel : label}
      </button>
      {open ? <div id={id}>{children}</div> : null}
    </div>
  );
}
