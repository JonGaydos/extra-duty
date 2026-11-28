import type { ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { ButtonLink } from "./Button";

export type BannerTone = "attention" | "warning" | "danger";

const TONES: Record<BannerTone, { box: string; ink: string }> = {
  attention: { box: "border-2 border-attention-dot bg-attention-soft", ink: "text-attention-ink" },
  warning: { box: "border-2 border-warning-line bg-warning-soft", ink: "text-warning-ink" },
  danger: { box: "border-2 border-danger-line bg-danger-soft", ink: "text-danger-ink" },
};

/**
 * Something the person must act on, at the top of Home (DESIGN.md, Action banners): a tinted card with a 2 px border,
 * a 20 px line icon, a bold one-line title, the facts in a sentence and one action. It cannot be dismissed; it goes
 * away by itself once nothing needs action.
 */
export function ActionBanner({
  tone = "warning",
  icon = "info",
  title,
  children,
  action,
  testId,
}: Readonly<{ tone?: BannerTone; icon?: IconName; title: ReactNode; children?: ReactNode; action: { href: string; label: string }; testId?: string }>) {
  const t = TONES[tone];
  return (
    <section aria-label={typeof title === "string" ? title : undefined} data-testid={testId} className={`flex flex-col gap-3 rounded-xl p-4 md:flex-row md:items-center md:gap-4 md:rounded-2xl md:p-5 ${t.box}`}>
      <div className={`flex min-w-0 flex-1 items-start gap-3 ${t.ink}`}>
        <Icon name={icon} size={20} className="mt-0.5 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="m-0 font-bold text-pretty">{title}</p>
          {children ? <div className="m-0 text-sm text-pretty">{children}</div> : null}
        </div>
      </div>
      <ButtonLink href={action.href} className="shrink-0 max-md:w-full">
        {action.label}
      </ButtonLink>
    </section>
  );
}
