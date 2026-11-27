"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import type { Map as LeafletMapType } from "leaflet";
import { guardWheelZoom, markZoom, useWheelHint, WheelHint } from "@/ui/components/wheel-zoom";

export type MapPin = { id: string; lat: number; lng: number; label: string; name: string; tone?: "pay" | "safety" | "plain" };

/** A character as an HTML numeric entity, for the pin label markup. */
const entity = (c: string) => `&#${c.codePointAt(0)};`;

/**
 * OpenStreetMap tiles through Leaflet, with the agency's tile URL and attribution from settings. Pins are
 * keyboard-focusable buttons named in words; choosing one calls `onSelect`. The page always lists the same
 * places in text too, so the map is never the only way in.
 */
export function LeafletMap({
  tileUrl,
  attribution,
  pins,
  label,
  onSelect,
  className = "h-80",
  zoom = 13,
  center,
  wheel = "guarded",
}: Readonly<{
  tileUrl: string;
  attribution: string;
  pins: MapPin[];
  label: string;
  onSelect?: (id: string) => void;
  className?: string;
  zoom?: number;
  /** Where the map opens with no pins (the agency's default center from settings). */
  center: { lat: number; lng: number; zoom: number };
  /** "page": the map is the page (/map), so a plain wheel always zooms; "guarded": see guardWheelZoom. */
  wheel?: "page" | "guarded";
}>) {
  const box = useRef<HTMLElement>(null);
  const map = useRef<LeafletMapType | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const hint = useWheelHint();
  const showHint = hint.show;

  useEffect(() => {
    let alive = true;
    let unguard = () => {};
    void import("leaflet").then((L) => {
      if (!alive || !box.current) return;
      map.current?.remove();
      const m = L.map(box.current, { scrollWheelZoom: wheel === "page", attributionControl: true });
      map.current = m;
      if (wheel === "guarded") unguard = guardWheelZoom(m, box.current, showHint);
      markZoom(m, box.current);
      // Only the agency's attribution from settings (the tile provider's credit); no library badge.
      m.attributionControl.setPrefix(false);
      L.tileLayer(tileUrl, { attribution, maxZoom: 19 }).addTo(m);
      // Pins at the same place stack upward instead of hiding each other.
      const seen = new Map<string, number>();
      const markers = pins.map((p) => {
        const key = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
        const stack = seen.get(key) ?? 0;
        seen.set(key, stack + 1);
        const icon = L.divIcon({
          className: "ed-pin",
          html: `<span class="ed-pin-label ed-pin-${p.tone ?? "pay"}">${p.label.replace(/[&<>"]/g, entity)}</span>`,
          iconSize: undefined,
          iconAnchor: [0, stack * 30],
        });
        const mk = L.marker([p.lat, p.lng], { icon, keyboard: true, title: p.name, alt: p.name, riseOnHover: true }).addTo(m);
        mk.on("click", () => select.current?.(p.id));
        const el = mk.getElement();
        if (el) {
          el.setAttribute("role", "button");
          el.setAttribute("aria-label", p.name);
        }
        return mk;
      });
      if (pins.length === 1) m.setView([pins[0].lat, pins[0].lng], zoom);
      else if (pins.length > 1) m.fitBounds(L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number])).pad(0.2));
      else m.setView([center.lat, center.lng], center.zoom);
      return markers;
    });
    return () => {
      alive = false;
      unguard();
      map.current?.remove();
      map.current = null;
    };
  }, [tileUrl, attribution, pins, zoom, center.lat, center.lng, center.zoom, wheel, showHint]);

  return (
    <div className="relative z-0 overflow-hidden rounded-xl md:rounded-2xl">
      <section ref={box} aria-label={label} className={`ed-map relative z-0 w-full overflow-hidden rounded-xl border border-line md:rounded-2xl ${className}`} />
      {wheel === "guarded" ? <WheelHint visible={hint.visible} /> : null}
    </div>
  );
}
