"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as LeafletMap } from "leaflet";

/**
 * Mouse wheel zoom for a map that sits inside a page. A plain wheel keeps scrolling the page and briefly shows a hint;
 * Ctrl + wheel (Cmd + wheel on a Mac, and a trackpad pinch, which the browser sends the same way) zooms. Once the
 * person clicks or taps into the map, a plain wheel zooms too, until the pointer leaves it. Keyboard zoom, the zoom
 * buttons and touch pinch are Leaflet's own and stay on.
 */
export function guardWheelZoom(map: LeafletMap, el: HTMLElement, onBlockedWheel: () => void): () => void {
  map.scrollWheelZoom.disable();
  const engage = () => map.scrollWheelZoom.enable();
  const release = () => map.scrollWheelZoom.disable();
  const onWheel = (e: WheelEvent) => {
    // Engaged: Leaflet's own wheel handler zooms.
    if (map.scrollWheelZoom.enabled()) return;
    if (!e.ctrlKey && !e.metaKey) {
      onBlockedWheel();
      return;
    }
    // Ctrl + wheel would zoom the whole page; here it zooms the map, around the pointer.
    e.preventDefault();
    const by = e.deltaY < 0 ? 1 : -1;
    map.setZoomAround(map.mouseEventToContainerPoint(e as unknown as MouseEvent), map.getZoom() + by);
  };
  el.addEventListener("pointerdown", engage);
  el.addEventListener("pointerleave", release);
  el.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () => {
    el.removeEventListener("pointerdown", engage);
    el.removeEventListener("pointerleave", release);
    el.removeEventListener("wheel", onWheel, { capture: true });
  };
}

/** Keeps the map's zoom level on its element (`data-zoom`), for tests and styles. */
export function markZoom(map: LeafletMap, el: HTMLElement): void {
  const set = () => el.setAttribute("data-zoom", String(map.getZoom()));
  map.on("zoomend", set);
  map.whenReady(set);
}

/** How long the "Use Ctrl + scroll to zoom" hint stays up after a plain wheel. */
const HINT_MS = 1500;

/** The hint's state: `show()` puts it up and takes it down again after a moment. */
export function useWheelHint(): { visible: boolean; show: () => void } {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback(() => {
    setVisible(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), HINT_MS);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { visible, show };
}

/** The hint over the map. Pointer guidance only, so screen readers skip it; it never takes a click. */
export function WheelHint({ visible }: Readonly<{ visible: boolean }>) {
  const [key, setKey] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.userAgent)) setKey("Cmd");
  }, []);
  return (
    <div
      aria-hidden="true"
      data-testid="wheel-hint"
      data-visible={visible}
      className={`pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center rounded-[inherit] bg-black/70 px-4 text-center text-base font-semibold text-white transition-opacity duration-200 ${visible ? "opacity-100" : "invisible opacity-0"}`}
    >
      Use {key} + scroll to zoom
    </div>
  );
}
