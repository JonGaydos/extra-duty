import type { HTMLAttributes, ReactNode } from "react";

export type CardTone = "default" | "accent" | "warning" | "danger";

const TONES: Record<CardTone, string> = {
  default: "border border-line bg-surface",
  accent: "border-2 border-accent bg-surface",
  warning: "border border-warning-line bg-warning-soft",
  danger: "border border-danger-line bg-danger-soft",
};

/**
 * The one container. 18 px corners on phones, 20 px on desktop, a 1 px line,
 * no shadow. `pad={false}` for cards that hold edge-to-edge list rows.
 */
export function Card({
  as: Tag = "section",
  tone = "default",
  pad = true,
  className,
  ...rest
}: { as?: "section" | "div" | "article" | "li"; tone?: CardTone; pad?: boolean } & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={`flex flex-col rounded-xl md:rounded-2xl ${TONES[tone]}${pad ? " gap-3 p-4 md:p-5.5" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}

/** Card heading: 15 px on phones, 16 px on desktop, semibold. */
export function CardTitle({ children, as: Tag = "h2" }: { children: ReactNode; as?: "h2" | "h3" }) {
  return <Tag className="m-0 flex items-center gap-2 text-title font-semibold md:text-base">{children}</Tag>;
}
