"use client";

import { useEffect, useRef, useState } from "react";
import type { RankChange } from "@/domain/ranks/ranks";
import { Button } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { Icon } from "@/ui/icons";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import { applyRankChangeAction, deleteRankAction, previewRankChangeAction, rankActiveAction, renameRankAction, type RankChangeEffect } from "../_admin/actions";

export type RankRow = {
  id: string;
  name: string;
  active: boolean;
  holders: number;
  /** Why the rank cannot be deleted ("Used by 3 people"), or null when it never has been used. */
  used: string | null;
};

type Pending = { change: RankChange; title: string; effects: RankChangeEffect[]; after?: () => void };

const details = (n: number) => (n === 1 ? "1 upcoming detail" : `${n} upcoming details`);
const andList = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** "Deputy Sheriff spots: CSO can now fill them. Affects 4 upcoming details." */
function effectText(e: RankChangeEffect): string {
  const parts = [
    e.added.length ? `${andList(e.added)} can now fill them` : null,
    e.removed.length ? `${andList(e.removed)} can no longer fill them` : null,
  ].filter(Boolean);
  const affects = e.upcomingDetails ? ` This applies to ${details(e.upcomingDetails)} already posted.` : "";
  return `${e.name} spots: ${parts.join("; ")}.${affects}`;
}

/**
 * The Ranks page's controls: the ladder highest first with Higher and Lower, ranks outside the ladder as their own
 * group, rename, in or out of the ladder, turn off and delete, and Add. A change that rewrites who can fill a position
 * type asks first, listing each change and the posted details it reaches.
 */
export function RankManager({ ladder, outside }: Readonly<{ ladder: RankRow[]; outside: RankRow[] }>) {
  const { run, busy } = useCoordAction();
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pending) confirmRef.current?.focus();
  }, [pending]);

  /** Applies the change at once when it rewrites no position type; otherwise asks first. */
  const propose = (change: RankChange, title: string, after?: () => void) =>
    run(
      () => previewRankChangeAction(change),
      (r) => {
        const effects = JSON.parse(r.value ?? "[]") as RankChangeEffect[];
        if (effects.length) setPending({ change, title, effects, after });
        else run(() => applyRankChangeAction(change), after);
      },
      { refresh: false, quiet: true },
    );

  const confirm = () => {
    if (!pending) return;
    const { change, after } = pending;
    run(
      () => applyRankChangeAction(change),
      () => {
        setPending(null);
        after?.();
      },
    );
  };

  return (
    <div className="flex flex-col gap-5.5">
      {pending ? (
        <section ref={confirmRef} tabIndex={-1} aria-labelledby="rank-confirm-title" className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-focus md:rounded-2xl">
          <Card tone="warning" as="div" className="gap-3">
            <h2 id="rank-confirm-title" className="m-0 text-title font-semibold md:text-base">
              {pending.title}: this changes who can fill these positions
            </h2>
            <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-warning-ink">
              {pending.effects.map((e) => (
                <li key={e.name} className="max-w-[70ch]">
                  {effectText(e)}
                </li>
              ))}
            </ul>
            <p className="m-0 text-sm text-warning-ink">People already signed up keep their spots. A detail with its own rank choices is not changed.</p>
            <div className="flex flex-wrap gap-2">
              <Button busy={busy} onClick={confirm}>
                Make the change
              </Button>
              <Button variant="secondary" onClick={() => setPending(null)}>
                Cancel
              </Button>
            </div>
          </Card>
        </section>
      ) : null}

      <section aria-labelledby="rank-ladder" className="flex flex-col gap-2.5">
        <h2 id="rank-ladder" className="m-0 flex items-center gap-2 text-title font-semibold md:text-base">
          <span>Ladder</span>
          <span className="inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-full bg-accent-soft px-1.5 text-xs font-semibold text-link" data-numeric>
            {ladder.length}
          </span>
        </h2>
        <Card pad={false} as="div">
          {ladder.length === 0 ? (
            <p className="m-0 px-4 py-3.25 text-sm text-muted">No ranks in the ladder. Bring one in from below, or add one.</p>
          ) : (
            <ol aria-label="Ladder, highest first" className="m-0 list-none divide-y divide-divider p-0">
              {ladder.map((r, i) => (
                <RankItem key={`${r.id}-${r.name}`} r={r} place={i + 1} busy={busy || !!pending}>
                  <Button size="sm" variant="secondary" disabled={busy || !!pending || i === 0} aria-label={`Move ${r.name} higher`} onClick={() => propose({ kind: "move", id: r.id, direction: "higher" }, `Move ${r.name} higher`)}>
                    <Icon name="up" size={18} />
                    Higher
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy || !!pending || i === ladder.length - 1} aria-label={`Move ${r.name} lower`} onClick={() => propose({ kind: "move", id: r.id, direction: "lower" }, `Move ${r.name} lower`)}>
                    <Icon name="down" size={18} />
                    Lower
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy || !!pending} aria-label={`Move ${r.name} outside the ladder`} onClick={() => propose({ kind: "ladder", id: r.id, inLadder: false }, `Move ${r.name} outside the ladder`)}>
                    Outside the ladder
                  </Button>
                </RankItem>
              ))}
            </ol>
          )}
        </Card>
      </section>

      <section aria-labelledby="rank-outside" className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <h2 id="rank-outside" className="m-0 flex items-center gap-2 text-title font-semibold md:text-base">
            <span>Outside the ladder</span>
            <span className="inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-full bg-accent-soft px-1.5 text-xs font-semibold text-link" data-numeric>
              {outside.length}
            </span>
          </h2>
          <p className="m-0 max-w-[70ch] text-sm text-muted">These ranks fill only their own spots, and no other rank fills theirs.</p>
        </div>
        <Card pad={false} as="div">
          {outside.length === 0 ? (
            <p className="m-0 px-4 py-3.25 text-sm text-muted">None.</p>
          ) : (
            <ul aria-label="Outside the ladder" className="m-0 list-none divide-y divide-divider p-0">
              {outside.map((r) => (
                <RankItem key={`${r.id}-${r.name}`} r={r} busy={busy || !!pending}>
                  <IntoLadder r={r} places={ladder.length + 1} disabled={busy || !!pending} onPlace={(place) => propose({ kind: "ladder", id: r.id, inLadder: true, place }, `Bring ${r.name} into the ladder`)} />
                </RankItem>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <AddRank places={ladder.length + 1} busy={busy} disabled={!!pending} onAdd={(change, done) => propose(change, `Add ${change.kind === "create" ? change.name.trim() : "the rank"}`, done)} />
    </div>
  );
}

/** One rank: its place in the ladder, name, people, and its controls; rename opens in place. */
function RankItem({ r, place, busy, children }: Readonly<{ r: RankRow; place?: number; busy: boolean; children: React.ReactNode }>) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(r.name);
  const { run, busy: saving } = useCoordAction();
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3.25 md:flex-row md:items-center md:justify-between md:gap-4">
      {renaming ? (
        <form
          aria-label={`Rename ${r.name}`}
          className="flex flex-1 flex-col gap-2 md:flex-row md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => renameRankAction({ id: r.id, name }), () => setRenaming(false));
          }}
        >
          <div className="md:w-72">
            <FormField label="Rank name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus />
            </FormField>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" busy={saving}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setName(r.name);
                setRenaming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="m-0 flex flex-wrap items-center gap-2 font-semibold">
            {place ? (
              <span className="w-6 text-muted" data-numeric>
                <span className="sr-only">Place </span>
                {place}
              </span>
            ) : null}
            {r.name}
            {r.active ? null : <Chip>Off</Chip>}
          </p>
          <p className={`m-0 text-sm text-muted ${place ? "pl-8" : ""}`}>
            {r.used ?? "Not used yet"}
          </p>
        </div>
      )}
      {renaming ? null : (
        <div className={`flex shrink-0 flex-wrap gap-2 ${place ? "pl-8 md:pl-0" : ""}`}>
          {children}
          <Button size="sm" variant="secondary" disabled={busy || saving} aria-label={`Rename ${r.name}`} onClick={() => setRenaming(true)}>
            Rename
          </Button>
          <OffOrDelete r={r} disabled={busy || saving} />
        </div>
      )}
    </li>
  );
}

/**
 * Delete for a rank nothing has used (added by mistake); Turn off, with the reason, for one that has been used. A
 * rank someone holds cannot be turned off either.
 */
function OffOrDelete({ r, disabled }: Readonly<{ r: RankRow; disabled: boolean }>) {
  const { run, busy } = useCoordAction();
  const [sure, setSure] = useState(false);
  if (!r.used) {
    if (!sure)
      return (
        <Button size="sm" variant="secondary" disabled={disabled || busy} aria-label={`Delete ${r.name}`} onClick={() => setSure(true)}>
          Delete
        </Button>
      );
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Delete is only for a rank added by mistake.</span>
        <Button size="sm" variant="danger" busy={busy} onClick={() => run(() => deleteRankAction(r.id))}>
          Delete {r.name}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setSure(false)}>
          Keep
        </Button>
      </span>
    );
  }
  if (!r.active)
    return (
      <Button size="sm" variant="secondary" disabled={disabled || busy} aria-label={`Turn on ${r.name}`} onClick={() => run(() => rankActiveAction({ id: r.id, active: true }))}>
        Turn on
      </Button>
    );
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={disabled || busy || r.holders > 0}
      aria-label={`Turn off ${r.name}`}
      title={r.holders > 0 ? "Move everyone off this rank first." : undefined}
      onClick={() => run(() => rankActiveAction({ id: r.id, active: false }))}
    >
      Turn off
    </Button>
  );
}

/** Place options counted from the top: "1, highest" to "n, lowest". */
function PlaceOptions({ places }: Readonly<{ places: number }>) {
  return (
    <>
      {Array.from({ length: places }, (_, i) => i + 1).map((n) => {
        let suffix = "";
        if (n === 1) suffix = ", highest";
        else if (n === places) suffix = ", lowest";
        return (
          <option key={n} value={n}>
            {n}
            {suffix}
          </option>
        );
      })}
    </>
  );
}

/** "Into the ladder" for a rank outside it: choose its place, then preview. */
function IntoLadder({ r, places, disabled, onPlace }: Readonly<{ r: RankRow; places: number; disabled: boolean; onPlace: (place: number) => void }>) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(String(places));
  if (!open)
    return (
      <Button size="sm" variant="secondary" disabled={disabled} aria-label={`Bring ${r.name} into the ladder`} onClick={() => setOpen(true)}>
        Into the ladder
      </Button>
    );
  return (
    <form
      aria-label={`Bring ${r.name} into the ladder`}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(false);
        onPlace(Number(place));
      }}
    >
      <FormField label="Place in the ladder">
        <Select value={place} onChange={(e) => setPlace(e.target.value)}>
          <PlaceOptions places={places} />
        </Select>
      </FormField>
      <Button type="submit" size="sm" disabled={disabled}>
        Bring in
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

/** Add a rank, into the ladder at a chosen place or outside it. */
function AddRank({ places, busy, disabled, onAdd }: Readonly<{ places: number; busy: boolean; disabled: boolean; onAdd: (change: RankChange, done: () => void) => void }>) {
  const [name, setName] = useState("");
  const [where, setWhere] = useState(String(places));
  return (
    <section aria-labelledby="rank-add" className="flex flex-col gap-2.5">
      <h2 id="rank-add" className="m-0 text-title font-semibold md:text-base">
        Add a rank
      </h2>
      <form
        aria-label="Add rank"
        className="flex flex-col gap-2 md:flex-row md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const change: RankChange = where === "outside" ? { kind: "create", name, inLadder: false } : { kind: "create", name, inLadder: true, place: Number(where) };
          onAdd(change, () => setName(""));
        }}
      >
        <div className="md:w-72">
          <FormField label="Rank name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          </FormField>
        </div>
        <div className="md:w-56">
          <FormField label="Where">
            <Select value={where} onChange={(e) => setWhere(e.target.value)}>
              <optgroup label="In the ladder, place">
                <PlaceOptions places={places} />
              </optgroup>
              <option value="outside">Outside the ladder</option>
            </Select>
          </FormField>
        </div>
        <Button type="submit" busy={busy} disabled={disabled} className="w-full md:w-fit">
          Add rank
        </Button>
      </form>
    </section>
  );
}
