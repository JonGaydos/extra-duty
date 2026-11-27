"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import type { Map as LeafletMap, Marker } from "leaflet";
import type { MapConfig } from "./MapConfig";
import { guardWheelZoom, markZoom, useWheelHint, WheelHint } from "./wheel-zoom";

type Point = { lat: number; lng: number };

/** About 10 metres at these latitudes: one arrow-key press. */
const STEP = 0.0001;

/**
 * A small OpenStreetMap map with one draggable pin. Dragging the pin, tapping the map, or focusing the pin and
 * pressing the arrow keys moves it; every move calls `onMove`. With no point yet the map opens on the agency's
 * default center and the first tap places the pin.
 */
export function PinPicker({ config, point, onMove, label }: Readonly<{ config: MapConfig; point: Point | null; onMove: (p: Point) => void; label: string }>) {
  const box = useRef<HTMLElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const move = useRef(onMove);
  move.current = onMove;
  const lat = point?.lat ?? null;
  const lng = point?.lng ?? null;
  const hasPoint = lat !== null && lng !== null;
  const hint = useWheelHint();
  const showHint = hint.show;

  // The map is built once per config; the pin follows `point` below without rebuilding it.
  useEffect(() => {
    let alive = true;
    let unguard = () => {};
    void import("leaflet").then((L) => {
      if (!alive || !box.current) return;
      const m = L.map(box.current, { scrollWheelZoom: false, attributionControl: true });
      map.current = m;
      unguard = guardWheelZoom(m, box.current, showHint);
      markZoom(m, box.current);
      m.attributionControl.setPrefix(false);
      L.tileLayer(config.tileUrl, { attribution: config.attribution, maxZoom: 19 }).addTo(m);
      m.setView([config.center.lat, config.center.lng], config.center.zoom);
      m.on("click", (e) => move.current({ lat: round(e.latlng.lat), lng: round(e.latlng.lng) }));
      const icon = L.divIcon({ className: "ed-pin", html: '<span class="ed-pin-label ed-pin-plain">Pin</span>', iconSize: undefined, iconAnchor: [0, 0] });
      const mk = L.marker([config.center.lat, config.center.lng], { icon, draggable: true, keyboard: true, title: label, alt: label });
      mk.on("dragend", () => {
        const p = mk.getLatLng();
        move.current({ lat: round(p.lat), lng: round(p.lng) });
      });
      marker.current = mk;
      // Leaflet needs the element in the page before the first pin is placed.
      m.whenReady(() => box.current?.dispatchEvent(new Event("ed-map-ready")));
    });
    return () => {
      alive = false;
      unguard();
      map.current?.remove();
      map.current = null;
      marker.current = null;
    };
  }, [config.tileUrl, config.attribution, config.center.lat, config.center.lng, config.center.zoom, label, showHint]);

  useEffect(() => {
    const place = () => {
      const m = map.current;
      const mk = marker.current;
      if (!m || !mk) return false;
      if (lat === null || lng === null) {
        mk.remove();
        return true;
      }
      mk.setLatLng([lat, lng]);
      if (!m.hasLayer(mk)) {
        mk.addTo(m);
        const el = mk.getElement();
        if (el) {
          el.setAttribute("role", "button");
          el.setAttribute("aria-label", `${label}. Drag, or use the arrow keys, to move it.`);
          el.addEventListener("keydown", (e) => {
            const d = { ArrowUp: [STEP, 0], ArrowDown: [-STEP, 0], ArrowLeft: [0, -STEP], ArrowRight: [0, STEP] }[e.key];
            if (!d) return;
            e.preventDefault();
            const p = mk.getLatLng();
            move.current({ lat: round(p.lat + d[0]), lng: round(p.lng + d[1]) });
          });
        }
      }
      // No animation: the pin should sit still under a finger or pointer as soon as it shows.
      if (!m.getBounds().pad(-0.2).contains([lat, lng])) m.setView([lat, lng], Math.max(m.getZoom(), 16), { animate: false });
      return true;
    };
    if (place()) return;
    const el = box.current;
    el?.addEventListener("ed-map-ready", place, { once: true });
    return () => el?.removeEventListener("ed-map-ready", place);
  }, [lat, lng, label]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative z-0 overflow-hidden rounded-md">
        <section ref={box} aria-label={`Map: ${label}`} data-testid="pin-map" className="ed-map relative z-0 h-70 w-full overflow-hidden rounded-md border border-line md:h-96" />
        <WheelHint visible={hint.visible} />
      </div>
      <p className="m-0 text-xs text-muted">{hasPoint ? "Drag the pin, or tap the map, to put it exactly on the spot." : "Tap the map to place the pin."}</p>
    </div>
  );
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
