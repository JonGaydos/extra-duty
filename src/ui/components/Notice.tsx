import type { ReactNode } from "react";
import { Icon } from "../icons";

export type NoticeTone = "warning" | "danger" | "success" | "info";

const TONES: Record<NoticeTone, string> = {
  warning: "bg-warning-soft text-warning-ink",
  danger: "bg-danger-soft text-danger-ink",
  success: "bg-success-soft text-success-ink",
  info: "bg-accent-soft text-link",
};

/**
 * A short tinted message inside a card: a rule to know, a result, a problem.
 * Rendered as `as` (default p) so it can sit inside text flow.
 */
export function Notice({
  tone = "warning",
  children,
  role,
  live,
  as: Tag = "p",
}: Readonly<{
  tone?: NoticeTone;
  children: ReactNode;
  role?: "status" | "alert";
  live?: "polite" | "assertive";
  as?: "p" | "span" | "div";
}>) {
  return (
    <Tag role={role} aria-live={live} className={`m-0 flex items-start gap-2 rounded-md px-3 py-2.5 text-sm ${TONES[tone]}`}>
      <Icon name="info" size={16} strokeWidth={2} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </Tag>
  );
}
