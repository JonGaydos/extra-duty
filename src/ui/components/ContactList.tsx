import type { ReactNode } from "react";
import { formatPhone, phoneDigits } from "@/lib/phone";
import { Icon } from "../icons";
import { withClass } from "./with-class";

export type ContactItem = { label: string; value: ReactNode | null | undefined | false };

/**
 * Labeled facts, one per line: label above value on phones, a label column beside the values from 768 px.
 * Empty items are left out rather than shown blank.
 */
export function ContactList({ items, className }: Readonly<{ items: ContactItem[]; className?: string }>) {
  const shown = items.filter((i) => i.value !== null && i.value !== undefined && i.value !== false && i.value !== "");
  if (!shown.length) return null;
  return (
    <dl className={withClass("m-0 grid grid-cols-1 gap-y-2.5 text-body md:grid-cols-[minmax(8rem,auto)_1fr] md:gap-x-6 md:gap-y-2", className)}>
      {shown.map((i) => (
        <div key={i.label} className="contents">
          <dt className="text-sm font-medium text-muted md:text-body md:font-normal">{i.label}</dt>
          <dd className="m-0 -mt-2 min-w-0 break-words md:mt-0">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A phone number as a tel: link with a leading phone icon, shown in full as ###-###-####. Numbers saved before the rule show as they were. */
export function PhoneLink({ phone }: Readonly<{ phone: string }>) {
  const d = phoneDigits(phone);
  if (d.length !== 10) return <span>{phone}</span>;
  return (
    <a href={`tel:+1${d}`} className="inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap" data-numeric>
      <Icon name="phone" size={16} className="shrink-0" />
      {formatPhone(d)}
    </a>
  );
}

/** Each address on its own line as a mailto: link with a leading mail icon. */
export function EmailLinks({ emails }: Readonly<{ emails: string[] }>) {
  return (
    <span className="flex flex-col gap-0.5">
      {emails.map((e) => (
        <a key={e} href={`mailto:${e}`} className="inline-flex min-h-11 items-center gap-1.5 break-all">
          <Icon name="mail" size={16} className="shrink-0" />
          {e}
        </a>
      ))}
    </span>
  );
}

/** A phone number: a call link, or the number as typed when it is not 10 digits (flagged for staff). */
function sitePhone(phone: string, bad: boolean, staff: boolean) {
  if (!bad) {
    return (
      <span>
        <PhoneLink phone={phone} />
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span data-numeric>{phone}</span>
      {staff ? <span className="text-xs font-semibold text-warning-ink">Check this number</span> : null}
    </span>
  );
}

/**
 * The on-site contact: the name on one line, the number as a tel: link on the next. A number saved before
 * validation that is not a full US number shows as typed; staff also see a hint to fix it.
 */
export function SiteContact({ name, phone, staff }: Readonly<{ name: string | null; phone: string | null; staff: boolean }>) {
  const bad = phone !== null && phoneDigits(phone).length !== 10;
  return (
    <span className="flex flex-col">
      <span>{name ?? "No name given"}</span>
      {phone ? sitePhone(phone, bad, staff) : null}
    </span>
  );
}
