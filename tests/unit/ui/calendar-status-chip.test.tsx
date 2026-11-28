import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CalEntry } from "@/domain/calendar/calendar";
import { EntryRow, entryChips } from "@/app/(app)/calendar/entries";

const text = (html: string) => html.replace(/<[^<>]+>/g, " ").replace(/\s+/g, " ").trim();

const entry = (over: Partial<CalEntry>): CalEntry =>
  ({
    id: "j1",
    number: 12,
    title: "Escort",
    vendorName: "Example Vendor",
    locationName: null,
    address: null,
    lat: null,
    lng: null,
    startAt: new Date("2035-03-01T15:00:00Z"),
    endAt: new Date("2035-03-01T19:00:00Z"),
    status: "not_released",
    state: "scheduled",
    held: false,
    confidential: false,
    mine: false,
    myStatus: null,
    pay: { totalCents: 28000, rateCents: 7000, maxTotalCents: 28000, maxRateCents: 7000 },
    ...over,
  }) as CalEntry;

describe("calendar status chip", () => {
  test("a confidential detail shows Confidential, never Not released", () => {
    const chips = entryChips(entry({ confidential: true }));
    expect(chips.map((c) => c.text)).toEqual(["Confidential"]);
    const html = text(renderToStaticMarkup(<EntryRow e={entry({ confidential: true })} />));
    expect(html).toContain("Confidential");
    expect(html).not.toContain("Not released");
  });

  test("an ordinary detail keeps its status word", () => {
    expect(entryChips(entry({})).map((c) => c.text)).toEqual(["Not released"]);
    expect(entryChips(entry({ status: "filled", held: true })).map((c) => c.text)).toEqual(["Filled", "Held"]);
  });

  test("a confidential detail that has started keeps Confidential beside its status", () => {
    expect(entryChips(entry({ confidential: true, status: "filled" })).map((c) => c.text)).toEqual(["Confidential", "Filled"]);
  });
});
