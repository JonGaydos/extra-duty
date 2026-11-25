"use client";

import { useEffect } from "react";

/** Registers /sw.js (push notifications and the offline page). */
export function ServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return null;
}
