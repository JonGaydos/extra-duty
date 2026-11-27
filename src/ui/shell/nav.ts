import type { Role } from "@/domain/actor";
import type { IconName } from "../icons";

export type NavItem = {
  label: string;
  /** Shorter label for the phone tab bar. */
  short?: string;
  href: string;
  icon: IconName;
};

export type ShellNav = {
  /** Where "/" sends this role. */
  home: string;
  /** Desktop top nav: the role's sections. Deputies, coordinators and admins share the same list. */
  desktop: NavItem[];
  /**
   * Coordinators and admins only: their staff sections, after the shared ones and set apart by a separator on the
   * desktop bar, and in their own group on More. Empty for every other role.
   */
  staff: NavItem[];
  /** Phone tab bar: at most five, the last is More when sections do not fit. */
  phone: NavItem[];
  /** Listed on the More page (the staff sections follow in their own group). */
  more: NavItem[];
};

const PROFILE: NavItem = { label: "Profile", href: "/profile", icon: "user" };
const MORE: NavItem = { label: "More", href: "/more", icon: "more" };
/** The user manuals (/help), on the More page. */
const HELP: NavItem = { label: "Help", href: "/help", icon: "help" };

const MAP: NavItem = { label: "Map", href: "/map", icon: "map" };
const MESSAGES: NavItem = { label: "Messages", href: "/messages", icon: "mail" };

/** The tabs everyone but vendors shares, in this order. */
const SHARED: NavItem[] = [
  { label: "Home", href: "/home", icon: "home" },
  { label: "Details", href: "/jobs", icon: "details" },
  { label: "Calendar", href: "/calendar", icon: "calendar" },
  { label: "Billing", href: "/billing", icon: "receipt" },
  MESSAGES,
  PROFILE,
];
/** The shared phone tabs; More holds the rest. */
const SHARED_PHONE: NavItem[] = [...SHARED.filter((i) => i !== MESSAGES && i !== PROFILE), MORE];
const SHARED_MORE: NavItem[] = [MAP, MESSAGES, PROFILE, HELP];

/** What coordinators and admins have on top of the shared tabs. */
const STAFF: NavItem[] = [
  { label: "To-do", href: "/coordinate", icon: "todo" },
  { label: "Payments", href: "/coordinate/payments", icon: "receipt" },
  { label: "Vendors", href: "/coordinate/vendors", icon: "building" },
  { label: "Reports", href: "/coordinate/reports", icon: "chart" },
  { label: "Management", href: "/admin", icon: "sliders" },
];

const VENDOR: NavItem[] = [
  { label: "My details", href: "/vendor", icon: "details" },
  { label: "Request a detail", short: "Request", href: "/vendor/request", icon: "plus" },
  { label: "Invoices", href: "/vendor/invoices", icon: "receipt" },
  { label: "Locations", href: "/vendor/locations", icon: "pin" },
  { label: "Contracts", href: "/vendor/contracts", icon: "file" },
];

function build(desktop: NavItem[], phoneLabels: string[]): ShellNav {
  const phone = desktop.filter((i) => phoneLabels.includes(i.label));
  const more = [...desktop.filter((i) => !phone.includes(i)), PROFILE, HELP];
  return { home: desktop[0].href, desktop, staff: [], phone: [...phone, MORE], more };
}

/** Staff see the Outbox where email is kept instead of sent (training mode and staging). */
const OUTBOX: NavItem = { label: "Outbox", href: "/coordinate/outbox", icon: "mail" };

export function navFor(role: Role, opts: { outbox?: boolean } = {}): ShellNav {
  switch (role) {
    case "personnel":
      return { home: "/home", desktop: SHARED, staff: [], phone: SHARED_PHONE, more: SHARED_MORE };
    case "coordinator":
    case "admin":
      return { home: "/home", desktop: SHARED, staff: opts.outbox ? [...STAFF, OUTBOX] : STAFF, phone: SHARED_PHONE, more: SHARED_MORE };
    case "vendor":
      return build(VENDOR, ["My details", "Request a detail", "Invoices", "Locations"]);
  }
}

/**
 * The phone tab to mark current. The section is found among all of the
 * role's sections (plus those on More), so a parent path such as
 * /coordinate never claims /coordinate/payments; a section that is not in the
 * bar marks More.
 */
export function currentTab(nav: ShellNav, pathname: string): string | undefined {
  const section = activeHref([...nav.desktop, ...nav.staff, ...nav.more, PROFILE, MORE, HELP], pathname);
  if (!section) return undefined;
  if (nav.phone.some((i) => i.href === section)) return section;
  return nav.phone.some((i) => i.href === MORE.href) ? MORE.href : undefined;
}

/** The item for the current path: the longest href that is the path or a parent of it. */
export function activeHref(items: NavItem[], pathname: string): string | undefined {
  return items
    .map((i) => i.href)
    .filter((h) => pathname === h || pathname.startsWith(`${h}/`))
    .sort((a, b) => b.length - a.length)[0];
}
