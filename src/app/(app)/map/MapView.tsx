"use client";

import { useMemo, useState } from "react";
import { ButtonLink } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { MapsLink } from "@/ui/components/MapsLink";
import { PayLabel, payRangeText } from "@/ui/components/PayLabel";
import { LeafletMap, type MapPin } from "../_personnel/LeafletMap";

export type MapJob = {
  id: string;
  vendorName: string;
  title: string;
  when: string;
  where: string;
  address: string | null;
  lat: number;
  lng: number;
  totalCents: number;
  rateCents: number;
  upTo: { totalCents: number; rateCents: number };
  safety: boolean;
  /** Held by a coordinator: shown so staff and people on it know why it takes no sign-ups. */
  held: boolean;
};

/** The map and the card for the chosen pin, which links to the detail. */
export function MapView({ jobs, tileUrl, attribution, center }: { jobs: MapJob[]; tileUrl: string; attribution: string; center: { lat: number; lng: number; zoom: number } }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const pins: MapPin[] = useMemo(
    () => jobs.map((j) => ({ id: j.id, lat: j.lat, lng: j.lng, label: payRangeText(j, j.upTo), name: `${j.vendorName}, ${j.when}, ${payRangeText(j, j.upTo)}${j.held ? ", held" : ""}` })),
    [jobs],
  );
  const job = jobs.find((j) => j.id === chosen) ?? null;
  return (
    <div className="flex flex-col gap-3">
      <LeafletMap tileUrl={tileUrl} attribution={attribution} pins={pins} label="Map of details" onSelect={setChosen} center={center} className="h-[55vh] min-h-80" />
      <div role="status" aria-live="polite">
        {job ? (
          <Card tone="accent">
            <div className="flex items-start justify-between gap-3">
              <span className="flex flex-col">
                <b>{job.vendorName}</b>
                <span className="text-sm text-muted">{job.title}</span>
              </span>
              <PayLabel totalCents={job.totalCents} rateCents={job.rateCents} upTo={job.upTo} />
            </div>
            <p className="m-0 text-sm text-muted">
              {job.when}. {job.where}
              {job.safety ? " Officer safety information on the detail." : ""}
              {job.held ? " Held: no new sign-ups for now." : ""}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <ButtonLink href={`/jobs/${job.id}`}>View detail</ButtonLink>
              <MapsLink address={job.address} lat={job.lat} lng={job.lng} />
            </div>
          </Card>
        ) : (
          <p className="m-0 text-sm text-muted">Choose a pin to see the detail.</p>
        )}
      </div>
    </div>
  );
}
