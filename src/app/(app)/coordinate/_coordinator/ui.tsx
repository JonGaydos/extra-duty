import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/ui/components/Card";

/** A to-do or record section: an h2 with a count badge outside a card of rows. The section is a named region. */
export function CountSection({ title, count, action, children, id }: Readonly<{ title: string; count?: number; action?: ReactNode; children: ReactNode; id?: string }>) {
  const headingId = id ?? `sec-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="m-0 flex items-center gap-2 text-title font-semibold md:text-base">
          {title}
          {count !== undefined ? (
            <span className="inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-full bg-accent-soft px-1.5 text-xs font-semibold text-link" data-numeric>
              {count}
            </span>
          ) : null}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A card of divided rows. */
export function Rows({ children, tone }: Readonly<{ children: ReactNode; tone?: "danger" | "warning" }>) {
  return (
    <Card pad={false} tone={tone} as="div">
      <ul className="m-0 list-none divide-y divide-divider p-0">{children}</ul>
    </Card>
  );
}

/** One row: title line, detail lines, and actions that wrap under the text on phones. */
export function Row({ title, href, meta, children, actions }: Readonly<{ title: ReactNode; href?: string; meta?: ReactNode; children?: ReactNode; actions?: ReactNode }>) {
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3.25 md:flex-row md:items-start md:justify-between md:gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="m-0 font-semibold">
          {href ? (
            <Link href={href} className="text-ink hover:text-link">
              {title}
            </Link>
          ) : (
            title
          )}
        </p>
        {meta ? <div className="text-sm text-muted">{meta}</div> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-start gap-2">{actions}</div> : null}
    </li>
  );
}

/** Label and value pairs in two columns. */
export function Facts({ items }: Readonly<{ items: Array<[string, ReactNode]> }>) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-body">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="m-0 min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
