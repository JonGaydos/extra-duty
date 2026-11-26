import Link from "next/link";
import { Icon, type IconName } from "../icons";
import type { ButtonHTMLAttributes, ComponentProps } from "react";
import { withClass } from "./with-class";

type ButtonVariant = "primary" | "secondary" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap select-none " +
  "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55 aria-disabled:pointer-events-none aria-disabled:opacity-55";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover hover:text-on-accent",
  secondary: "border border-line bg-surface text-ink hover:bg-subtle hover:text-ink",
  danger: "bg-danger text-on-danger hover:bg-danger/90 hover:text-on-danger",
};

/** sm: dense desktop rows (36 px, 44 px on touch). md: forms and dialogs (44 px). lg: the one main action on a phone screen (50 px). */
const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 rounded-sm px-3 text-sm pointer-coarse:h-11",
  md: "h-11 rounded-md px-4.5 text-body",
  lg: "h-12.5 rounded-lg px-4.5 text-base",
};

function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", full = false): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]}${full ? " w-full" : ""}`;
}

type Common = { variant?: ButtonVariant; size?: ButtonSize; full?: boolean };

/** A real <button>. `busy` disables it and tells assistive tech the action is running. */
export function Button({
  variant,
  size,
  full,
  busy = false,
  className,
  disabled,
  type = "button",
  ...rest
}: Common & { busy?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={withClass(buttonClass(variant, size, full), className)}
      {...rest}
    />
  );
}

/** Navigation that looks like a button (it is still a link). Buttons carry no underline. */
export function ButtonLink({ variant, size, full, className, ...rest }: Common & ComponentProps<typeof Link>) {
  return <Link data-button-link className={withClass(`${buttonClass(variant, size, full)} no-underline`, className)} {...rest} />;
}

/** The class of a standalone action link: underlined text, 13 px 600, a 44 px tall hit area. */
export const ACTION_LINK = "inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold";

/**
 * A standalone action link (View invoice, Open the deputy view, Directions): underlined text and a trailing icon,
 * a chevron for a page in the app and an external mark for another site, which opens in a new tab.
 */
export function ActionLink({ external = false, icon, className, children, ...rest }: { external?: boolean; icon?: IconName } & ComponentProps<typeof Link>) {
  const trailing = <Icon name={icon ?? (external ? "external" : "chevronRight")} size={16} className="shrink-0" />;
  return (
    <Link className={withClass(ACTION_LINK, className)} {...(external ? { target: "_blank", rel: "noreferrer" } : {})} {...rest}>
      {children}
      {trailing}
    </Link>
  );
}
