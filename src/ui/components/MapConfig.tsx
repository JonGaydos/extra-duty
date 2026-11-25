"use client";

import { createContext, useContext, type ReactNode } from "react";

export type MapConfig = { tileUrl: string; attribution: string; center: { lat: number; lng: number; zoom: number } };

const Ctx = createContext<MapConfig | null>(null);

/** The agency's map tiles and default center from settings, for the pin pickers inside forms. */
export function MapConfigProvider({ value, children }: { value: MapConfig; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMapConfig(): MapConfig | null {
  return useContext(Ctx);
}
