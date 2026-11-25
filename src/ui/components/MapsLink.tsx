"use client";

import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { MAPS_APPS, mapsUrls, type MapsApp, type Place } from "@/lib/maps";
import { Icon } from "../icons";
import { ACTION_LINK } from "./Button";

type Pref = { app: MapsApp | null; setApp: (app: MapsApp | null) => void };
const MapsPreference = createContext<Pref | null>(null);

/** Holds the signed-in person's maps app for every MapsLink on the page, so a remembered choice applies at once. */
export function MapsPreferenceProvider({ initial, children }: { initial: MapsApp | null; children: React.ReactNode }) {
  const [app, setApp] = useState<MapsApp | null>(initial);
  return <MapsPreference.Provider value={{ app, setApp }}>{children}</MapsPreference.Provider>;
}

export function useMapsPreference(): Pref {
  return useContext(MapsPreference) ?? { app: null, setApp: () => undefined };
}

/** Saves the choice to the profile. Returns false when the save failed. */
export async function saveMapsApp(app: MapsApp | null): Promise<boolean> {
  try {
    const res = await fetch("/api/v1/me/maps-app", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: app ?? "ask" }), keepalive: true });
    return res.ok;
  } catch {
    return false;
  }
}

const nameOf = (app: MapsApp) => MAPS_APPS.find((a) => a.key === app)!.name;

/**
 * "Open in Maps" for an address: a small menu of Google Maps, Apple Maps and OpenStreetMap (each a real link that
 * opens in a new tab) with "Remember my choice". Once the person has a preferred app, the link opens it directly and
 * "Other maps" opens the menu. Uses the pinned coordinates when there are any, else the address text.
 */
export function MapsLink({ label = "Open in Maps", className, ...place }: Place & { label?: string; className?: string }) {
  const { app, setApp } = useMapsPreference();
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const [note, setNote] = useState("");
  const box = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const urls = mapsUrls(place);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  // Keep the menu on screen: when it would run past the right edge (a link at the end of a row), it opens leftward.
  useLayoutEffect(() => {
    if (!open || !box.current) return;
    const left = box.current.getBoundingClientRect().left;
    const width = menu.current?.offsetWidth ?? 256;
    setAlignEnd(left + width > document.documentElement.clientWidth - 8);
  }, [open]);

  const choose = (k: MapsApp) => {
    setNote("");
    if (remember) {
      const before = app;
      setApp(k);
      void saveMapsApp(k).then((ok) => {
        if (ok) return;
        setApp(before);
        setNote("Your maps choice could not be saved. It will ask again next time.");
      });
    }
    setOpen(false);
  };

  const opener = (text: string) => (
    <button
      ref={toggle}
      type="button"
      aria-expanded={open}
      aria-controls={menuId}
      onClick={() => setOpen(!open)}
      className="inline-flex min-h-11 items-center gap-1 rounded-sm text-sm font-semibold text-link hover:text-link-hover"
    >
      {text}
      <Icon name="chevronDown" size={16} className={`shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
    </button>
  );

  return (
    <span
      ref={box}
      className={`relative inline-flex flex-wrap items-center gap-x-4${className ? ` ${className}` : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          setOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      {app ? (
        <>
          <a href={urls[app]} target="_blank" rel="noreferrer" className={ACTION_LINK}>
            {label}
            <span className="sr-only"> with {nameOf(app)}, opens in a new tab</span>
            <Icon name="external" size={16} className="shrink-0" />
          </a>
          {opener("Other maps")}
        </>
      ) : (
        opener(label)
      )}
      {open ? (
        <span
          ref={menu}
          id={menuId}
          role="group"
          aria-label="Open with"
          className={`absolute top-full z-30 mt-1 flex w-64 max-w-[calc(100vw-2.5rem)] flex-col rounded-md border border-line bg-surface p-1.5 shadow-float ${alignEnd ? "right-0" : "left-0"}`}
        >
          {MAPS_APPS.map((a) => (
            <a
              key={a.key}
              href={urls[a.key]}
              target="_blank"
              rel="noreferrer"
              onClick={() => choose(a.key)}
              className="flex min-h-11 items-center justify-between gap-2 rounded-sm px-3 text-body font-medium hover:bg-subtle"
            >
              {a.name}
              <span className="sr-only">, opens in a new tab</span>
              <Icon name="external" size={16} className="shrink-0" />
            </a>
          ))}
          <label className="mt-1 flex min-h-11 cursor-pointer items-center gap-2.5 border-t border-divider px-3 pt-1 text-sm text-ink">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4.5 accent-accent" />
            Remember my choice
          </label>
        </span>
      ) : null}
      <span role="status" className="basis-full text-xs font-medium text-danger-ink empty:hidden">
        {note}
      </span>
    </span>
  );
}

/** Profile: the maps app every "Open in Maps" uses, or ask each time. Saves on change and says when it could not. */
export function MapsPreferenceControl() {
  const { app, setApp } = useMapsPreference();
  const [error, setError] = useState(false);
  const options: Array<{ key: MapsApp | null; name: string }> = [{ key: null, name: "Ask each time" }, ...MAPS_APPS];
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="sr-only">Maps app</legend>
      {options.map((o) => (
        <label key={o.key ?? "ask"} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-line px-3 has-checked:border-2 has-checked:border-accent">
          <input
            type="radio"
            name="maps-app"
            checked={app === o.key}
            onChange={async () => {
              const before = app;
              setApp(o.key);
              setError(false);
              if (!(await saveMapsApp(o.key))) {
                setApp(before);
                setError(true);
              }
            }}
            className="size-4.5 accent-accent"
          />
          {o.name}
        </label>
      ))}
      <p role="status" className="m-0 text-xs font-medium text-danger-ink empty:hidden">
        {error ? "Your maps app could not be saved. Check your connection and try again." : ""}
      </p>
    </fieldset>
  );
}
