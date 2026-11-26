"use client";

import { useState } from "react";
import { agencyChannelOn, CATALOG, CATEGORIES, channelsFor, GROUP_LABEL, RECIPIENT_GROUPS, type AgencyChannels, type CatalogEntry, type CatalogKey, type Channel, type RecipientGroup } from "@/domain/notifications/catalog";
import { Card } from "@/ui/components/Card";
import { Icon } from "@/ui/icons";
import { setAgencyChannelAction } from "../../_admin/actions";
import { useCoordAction } from "../../../coordinate/_coordinator/status";

const CHANNEL_LABEL: Record<Channel, string> = { email: "Email", push: "Push" };
/** Vendors never get push, so their column has Email only. */
const COLUMNS: Array<{ group: RecipientGroup; channels: readonly Channel[] }> = RECIPIENT_GROUPS.map((group) => ({ group, channels: group === "vendor" ? ["email"] : ["email", "push"] }));

const slug = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, "-");
const shown = (Object.entries(CATALOG) as Array<[CatalogKey, CatalogEntry]>).filter(([, e]) => !e.unused);

/** A 44 px switch; the visible track is the design system's 30 by 18 px one. */
function ChannelSwitch({ on, label, disabled, onToggle, children }: Readonly<{ on: boolean; label: string; disabled: boolean; onToggle: () => void; children?: React.ReactNode }>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-sm disabled:cursor-wait"
    >
      <span className={`relative inline-flex h-4.5 w-7.5 shrink-0 rounded-full transition-colors duration-150 ${on ? "bg-accent" : "bg-field"}`}>
        <span className={`absolute top-0.5 size-3.5 rounded-full bg-surface transition-[left] duration-150 ${on ? "left-3.5" : "left-0.5"}`} />
      </span>
      {children}
    </button>
  );
}

function Locked() {
  return (
    <span className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-muted">
      <Icon name="lock" size={16} aria-hidden />
      Always on
    </span>
  );
}

function NotSent() {
  return (
    <>
      <span aria-hidden className="text-muted">
        &ndash;
      </span>
      <span className="sr-only">Not sent to this group</span>
    </>
  );
}

function TypeText({ entry }: Readonly<{ entry: CatalogEntry }>) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-semibold">{entry.label}</span>
      <span className="text-sm text-muted">{entry.description}</span>
      {entry.locked ? <span className="text-xs text-muted">Locked on. {entry.locked}</span> : null}
      {entry.inAppOnly ? <span className="text-xs text-muted">In-app inbox only, locked. {entry.inAppOnly}</span> : null}
      {entry.note ? <span className="text-xs text-muted">{entry.note}</span> : null}
    </span>
  );
}

/**
 * Management > Notifications: Email and Push per notification type and recipient group. A table on desktop (type
 * rows, group columns); one card per type on a phone. Each switch saves on its own and goes back if the save fails.
 */
export function NotificationMatrix({ initial }: Readonly<{ initial: AgencyChannels }>) {
  const [channels, setChannels] = useState<AgencyChannels>(initial);
  const [pending, setPending] = useState<string | null>(null);
  const { run } = useCoordAction();

  const set = (key: CatalogKey, group: RecipientGroup, channel: Channel, on: boolean) =>
    setChannels((c) => ({ ...c, [key]: { ...c[key], [group]: { ...c[key]?.[group], [channel]: on } } }));

  const toggle = (key: CatalogKey, group: RecipientGroup, channel: Channel) => {
    if (pending) return;
    const was = agencyChannelOn(channels, key, group, channel);
    set(key, group, channel, !was);
    setPending(`${key}:${group}:${channel}`);
    run(
      async () => {
        try {
          const r = await setAgencyChannelAction({ type: key, group, channel, on: !was });
          if (!r.ok) set(key, group, channel, was);
          return r;
        } catch (e) {
          set(key, group, channel, was);
          throw e;
        } finally {
          setPending(null);
        }
      },
      undefined,
      { refresh: false },
    );
  };

  const cell = (key: CatalogKey, entry: CatalogEntry, group: RecipientGroup, channel: Channel, phone = false) => {
    if (!channelsFor(entry, group).includes(channel)) return phone ? null : <NotSent />;
    if (entry.locked) return <Locked />;
    const on = agencyChannelOn(channels, key, group, channel);
    return (
      <ChannelSwitch
        on={on}
        label={`${CHANNEL_LABEL[channel]} to ${GROUP_LABEL[group].toLowerCase()}: ${entry.label}`}
        disabled={pending !== null}
        onToggle={() => toggle(key, group, channel)}
      >
        {phone ? <span className="text-sm">{CHANNEL_LABEL[channel]}</span> : null}
      </ChannelSwitch>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {CATEGORIES.map((category) => {
        const rows = shown.filter(([, e]) => e.category === category);
        return (
          <Card key={category} pad={false} aria-labelledby={`cat-${slug(category)}`}>
            <div className="px-4 pt-4 md:px-5.5 md:pt-5">
              <h2 id={`cat-${slug(category)}`} className="m-0 text-title font-semibold md:text-base">
                {category}
              </h2>
            </div>

            {/* Desktop: type rows, group columns. */}
            <table className="hidden w-full table-fixed border-collapse text-body md:table">
              <colgroup>
                <col className="w-[40%]" />
                {COLUMNS.flatMap((c) => c.channels.map((ch) => <col key={`${c.group}-${ch}`} />))}
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" rowSpan={2} className="px-5.5 pt-3 pb-2 text-left align-bottom text-xs font-semibold text-muted">
                    Notification
                  </th>
                  {COLUMNS.map((c) => (
                    <th key={c.group} scope="colgroup" colSpan={c.channels.length} className="border-l border-divider px-2 pt-3 text-center text-xs font-semibold">
                      {GROUP_LABEL[c.group]}
                    </th>
                  ))}
                </tr>
                <tr>
                  {COLUMNS.flatMap((c) =>
                    c.channels.map((ch, i) => (
                      <th key={`${c.group}-${ch}`} scope="col" className={`px-2 pb-2 text-center text-xs font-semibold text-muted ${i === 0 ? "border-l border-divider" : ""}`}>
                        {CHANNEL_LABEL[ch]}
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map(([key, entry]) => (
                  <tr key={key} className="border-t border-divider">
                    <th scope="row" className="px-5.5 py-2.5 text-left align-top font-normal">
                      <TypeText entry={entry} />
                    </th>
                    {COLUMNS.flatMap((c) =>
                      c.channels.map((ch, i) => (
                        <td key={`${c.group}-${ch}`} className={`px-2 py-1 text-center align-middle ${i === 0 ? "border-l border-divider" : ""}`}>
                          {cell(key, entry, c.group, ch)}
                        </td>
                      )),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Phone: one block per type, a line per group that gets it. */}
            <ul className="m-0 flex list-none flex-col p-0 md:hidden">
              {rows.map(([key, entry]) => (
                <li key={key} className="flex flex-col gap-2 border-t border-divider px-4 py-3 first:mt-3">
                  <TypeText entry={entry} />
                  <dl className="m-0 flex flex-col">
                    {entry.groups.map((group) => (
                      <div key={group} className="flex flex-wrap items-center justify-between gap-x-3">
                        <dt className="text-sm text-muted">{GROUP_LABEL[group]}</dt>
                        <dd className="m-0 flex items-center gap-3">
                          {entry.locked ? <Locked /> : (["email", "push"] as const).map((ch) => <span key={ch}>{cell(key, entry, group, ch, true)}</span>)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
