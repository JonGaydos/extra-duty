"use client";

import { useMemo } from "react";
import { LeafletMap, type MapPin } from "../../_personnel/LeafletMap";

/** A small map with one pin for an officer safety address. */
export function SafetyMap({ tileUrl, attribution, pin }: Readonly<{ tileUrl: string; attribution: string; pin: MapPin }>) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the pin is redrawn only when its place changes
  const pins = useMemo(() => [pin], [pin.id, pin.lat, pin.lng]);
  return <LeafletMap tileUrl={tileUrl} attribution={attribution} pins={pins} label={pin.name} className="h-40" zoom={15} center={{ lat: pin.lat, lng: pin.lng, zoom: 15 }} />;
}
