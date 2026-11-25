import Link from "next/link";

/**
 * Section tabs that are links (List, Calendar, Map; Inbox, Sent). The current one is marked for assistive tech
 * with aria-current and drawn like the active nav item.
 */
export function TabLinks({ label, items, current }: { label: string; items: Array<{ href: string; label: string; key: string }>; current: string }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 rounded-md border border-line bg-surface p-1">
      {items.map((i) => {
        const on = i.key === current;
        return (
          <Link
            key={i.key}
            href={i.href}
            aria-current={on ? "page" : undefined}
            data-nav-item
            className={`inline-flex min-h-9 items-center rounded-sm px-3 text-body no-underline pointer-coarse:min-h-11 ${
              on ? "bg-accent-soft font-semibold text-link hover:text-link" : "font-medium text-muted hover:bg-subtle hover:text-ink"
            }`}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The page heading and an optional action on the same line. */
export function PageTitle({ children, action, sub }: { children: React.ReactNode; action?: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-2xl font-bold md:text-3xl">{children}</h1>
        {sub ? <p className="m-0 text-muted">{sub}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** A titled group of cards with the heading outside the card, as on Home. */
export function Section({ title, action, children, id }: { title: string; action?: React.ReactNode; children: React.ReactNode; id?: string }) {
  const headingId = id ?? `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="m-0 text-title font-semibold md:text-base">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
