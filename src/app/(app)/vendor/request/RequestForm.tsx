"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { VendorRequestWire } from "@/app/api/v1/vendor-requests/parse";
import { Button } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { Disclosure } from "@/ui/components/Disclosure";
import { AddressField, addressValue, pinWire } from "@/ui/components/AddressField";
import { FormField, Input, Select, TextArea } from "@/ui/components/FormField";
import { Icon } from "@/ui/icons";
import type { ActionResult } from "../../_personnel/result";
import { ActionStatus, useAction } from "../../_personnel/use-action";
import { DatesStep } from "../../coordinate/_coordinator/DatesStep";
import { FlexFields, PreviewRow, SafetyAddressFields, safetyWire, type FlexWire, type SafetyAddressRow, type TimeOverride } from "../../coordinate/_coordinator/DetailFields";
import { SiteContactFields, type ContactOption, type SiteContactValue } from "../../coordinate/_coordinator/SiteContactFields";
import { expandRequestDatesAction } from "../_vendor/actions";

type Option = { id: string; name: string };
const NEW = "new";
// Matches what the upload accepts: legacy .doc files are refused there, so the picker does not offer them.
const FILE_TYPES = ".pdf,.docx,.jpg,.jpeg,.png,application/pdf";

/** Sends the request as multipart (the contract file can be up to 20 MB), so it goes to the API route. */
async function sendRequest(wire: VendorRequestWire, file: File | null): Promise<ActionResult> {
  const body = new FormData();
  body.set("request", JSON.stringify(wire));
  if (file) body.set("contractFile", file);
  const res = await fetch("/api/v1/vendor-requests", { method: "POST", body });
  const json = await res.json().catch(() => null);
  if (res.ok) return { ok: true, value: json?.data?.id, message: "Request sent." };
  return { ok: false, error: json?.error?.message ?? "The request did not go through. Check your connection and try again." };
}

/**
 * The request form. The required questions come first, each in its own card; flexible times, more dates,
 * officer safety and attachments wait behind their own disclosure and count only while open.
 */
export function RequestForm({
  locations,
  contacts,
  jobTypes,
  positionTypes,
  defaultPositionTypeId,
  canSetRate,
  rules,
  today,
  weekStartsOn,
}: {
  locations: Array<Option & { address: string | null }>;
  contacts: ContactOption[];
  jobTypes: Option[];
  positionTypes: Option[];
  defaultPositionTypeId: string;
  canSetRate: boolean;
  rules: string[];
  today: string;
  weekStartsOn: number;
}) {
  const router = useRouter();
  const { run, busy, result } = useAction();
  const [locationId, setLocationId] = useState(locations[0]?.id ?? NEW);
  const [newName, setNewName] = useState("");
  const [newAddress, setNewAddress] = useState(() => addressValue(""));
  const [date, setDate] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [typeId, setTypeId] = useState(jobTypes[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [positions, setPositions] = useState([{ positionTypeId: defaultPositionTypeId, count: "1" }]);
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [contact, setContact] = useState<SiteContactValue>({ contactName: "", contactPhone: "", newContact: null });
  const [rate, setRate] = useState("");
  // Optional sections: their values count only while the section is open.
  const [flex, setFlex] = useState<FlexWire | null>(null);
  const [moreDates, setMoreDates] = useState(false);
  const [extra, setExtra] = useState<string[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, TimeOverride>>({});
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [safetyNotes, setSafetyNotes] = useState("");
  const [safetyAddresses, setSafetyAddresses] = useState<SafetyAddressRow[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [contractLabel, setContractLabel] = useState("");
  const [contractUrl, setContractUrl] = useState("");
  const [contractFile, setContractFile] = useState<File | null>(null);
  // Changing the key empties the file input when the chosen file is removed.
  const [fileKey, setFileKey] = useState(0);
  const removeFile = () => {
    setContractFile(null);
    setFileKey((k) => k + 1);
  };

  const setPosition = (i: number, patch: Partial<(typeof positions)[number]>) => setPositions(positions.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const adding = locationId === NEW;
  const allDates = useMemo(() => {
    const set = new Set([...(date ? [date] : []), ...(moreDates ? extra : [])]);
    return [...set].filter((d) => d === date || !removed.has(d)).sort();
  }, [date, extra, moreDates, removed]);

  const submit = () => {
    const wire: VendorRequestWire = {
      locationId: adding ? "" : locationId,
      newLocation: adding ? { name: newName, address: newAddress.address, ...(pinWire(newAddress) === undefined ? {} : { pin: pinWire(newAddress) }) } : null,
      typeId,
      title,
      description,
      notes,
      date,
      startTime: start,
      endTime: end,
      dates: allDates.length > 1 ? allDates : [],
      overrides: allDates.length > 1 ? Object.fromEntries(Object.entries(overrides).filter(([k]) => allDates.includes(k))) : {},
      flex,
      positions: positions.map((p) => ({ positionTypeId: p.positionTypeId, count: Number(p.count) })),
      contactName: contact.contactName,
      contactPhone: contact.contactPhone,
      newContact: contact.newContact,
      rate: canSetRate ? rate : "",
      contract: filesOpen && (contractUrl.trim() || contractFile) ? { label: contractLabel, url: contractFile ? "" : contractUrl } : null,
      safetyNotes: safetyOpen ? safetyNotes : "",
      safetyAddresses: safetyOpen ? safetyWire(safetyAddresses) : [],
    };
    run(
      () => sendRequest(wire, filesOpen ? contractFile : null),
      (r) => {
        if (r.value) router.push(`/vendor/details/${r.value}`);
      },
      false,
    );
  };

  return (
    <form
      className="grid gap-4.5 md:grid-cols-[minmax(0,1fr)_340px] md:items-start md:gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex min-w-0 flex-col gap-4.5">
        <Card>
          <CardTitle>Where</CardTitle>
          <FormField label="Location">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.address ? `, ${l.address}` : ""}
                </option>
              ))}
              <option value={NEW}>Add a new location</option>
            </Select>
          </FormField>
          {adding ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Location name">
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} required maxLength={200} />
              </FormField>
              <div className="sm:col-span-2">
                <AddressField label="Address" hint="Street, city and ZIP. Used for the map pin." value={newAddress} onChange={setNewAddress} pin />
              </div>
            </div>
          ) : null}
        </Card>

        <Card>
          <CardTitle>When</CardTitle>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Date">
              <Input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} required />
            </FormField>
            <FormField label="Start">
              <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
            </FormField>
            <FormField label="End" hint="An end before the start finishes the next day.">
              <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </FormField>
          </div>
          <div className="flex flex-col border-t border-divider pt-1">
            <Disclosure label="Flexible times" open={flex !== null} onOpenChange={(o) => setFlex(o ? { earliest: start, latest: end, allowShorter: false } : null)}>
              <div className="flex flex-col gap-2 pb-2">
                <p className="m-0 text-sm text-muted">Deputies may start or finish at other times within this range.</p>
                {flex ? <FlexFields flex={flex} onFlex={setFlex} /> : null}
              </div>
            </Disclosure>
            <Disclosure
              label="More dates"
              open={moreDates}
              onOpenChange={(o) => {
                setMoreDates(o);
                setExtra([]);
                setRemoved(new Set());
                setOverrides({});
              }}
            >
              <div className="flex flex-col gap-3 pb-2">
                <p className="m-0 text-sm text-muted">The same detail on other dates. Each date becomes its own detail, and the coordinators approve them together.</p>
                <DatesStep today={today} weekStartsOn={weekStartsOn} modes={["range", "pick", "repeat"]} initial="range" minDate={today} expand={expandRequestDatesAction} onDates={(list) => setExtra(list)} />
                {allDates.length > 1 ? (
                  <div className="flex flex-col gap-1.5">
                    <h3 className="m-0 text-body font-semibold">{allDates.length} details will be requested</h3>
                    <ul className="m-0 max-h-96 list-none divide-y divide-divider overflow-y-auto rounded-md border border-line p-0">
                      {allDates.map((k) => (
                        <PreviewRow
                          key={k}
                          date={k}
                          start={start}
                          end={end}
                          override={overrides[k]}
                          onOverride={(o) =>
                            setOverrides((x) => {
                              const next = { ...x };
                              if (o) next[k] = o;
                              else delete next[k];
                              return next;
                            })
                          }
                          onRemove={() => (k === date ? setDate(allDates.find((d) => d !== date) ?? "") : setRemoved((s) => new Set(s).add(k)))}
                        />
                      ))}
                    </ul>
                    <p className="m-0 text-xs text-muted">Change one date&apos;s times or remove it. Every date is sent together.</p>
                  </div>
                ) : null}
              </div>
            </Disclosure>
          </div>
        </Card>

        <Card>
          <CardTitle>Who you need</CardTitle>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {positions.map((p, i) => (
              <li key={i} className="grid grid-cols-[minmax(0,1fr)_6rem] items-end gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_auto]">
                <FormField label={i === 0 ? "Position" : `Position ${i + 1}`}>
                  <Select value={p.positionTypeId} onChange={(e) => setPosition(i, { positionTypeId: e.target.value })}>
                    {positionTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label={i === 0 ? "How many" : `How many, position ${i + 1}`}>
                  <Input type="number" inputMode="numeric" min={1} max={99} value={p.count} onChange={(e) => setPosition(i, { count: e.target.value })} required data-numeric />
                </FormField>
                {positions.length > 1 ? (
                  <Button variant="secondary" className="col-span-2 sm:col-span-1" onClick={() => setPositions(positions.filter((_, j) => j !== i))} aria-label={`Remove position ${i + 1}`}>
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setPositions([...positions, { positionTypeId: defaultPositionTypeId, count: "1" }])}
            className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-sm text-sm font-semibold text-link hover:text-link-hover"
          >
            <Icon name="plus" size={16} />
            Add another position
          </button>
          <p className="m-0 text-xs text-muted">The coordinator confirms the positions when approving.</p>
        </Card>

        <Card>
          <CardTitle>About the detail</CardTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Title" hint="A short name, such as Varsity basketball game.">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
            </FormField>
            <FormField label="Detail type">
              <Select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                {jobTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <FormField label="What the deputies will do" hint="Where to check in, who to report to and anything they should know.">
            <TextArea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
          </FormField>
          <FormField label="Notes" hint="Optional">
            <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </FormField>
          {canSetRate ? (
            <FormField label="Hourly rate" hint="Optional. Dollars an hour; the coordinator sets it when blank.">
              <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} data-numeric />
            </FormField>
          ) : null}
        </Card>

        <Card>
          <CardTitle>Contact on site</CardTitle>
          <p className="m-0 text-sm text-muted">Optional. Deputies ask for this person when they arrive.</p>
          <SiteContactFields contacts={contacts} value={contact} onChange={setContact} />
        </Card>

        <Card>
          <CardTitle>Safety and attachments</CardTitle>
          <div className="flex flex-col">
            <Disclosure label="Officer safety" open={safetyOpen} onOpenChange={setSafetyOpen}>
              <div className="flex flex-col gap-3 pb-2">
                <p className="m-0 text-sm text-muted">Anything deputies should know about a safety concern, and any address involved.</p>
                <FormField label="Safety notes" hint="Shown above everything else on the detail.">
                  <TextArea value={safetyNotes} onChange={(e) => setSafetyNotes(e.target.value)} maxLength={4000} />
                </FormField>
                <SafetyAddressFields addresses={safetyAddresses} onAddresses={setSafetyAddresses} />
              </div>
            </Disclosure>
            <Disclosure
              label="Attachments"
              open={filesOpen}
              onOpenChange={(o) => {
                setFilesOpen(o);
                // A closed section sends nothing and reopens empty.
                if (!o) {
                  removeFile();
                  setContractLabel("");
                  setContractUrl("");
                }
              }}
            >
              <div className="flex flex-col gap-3 pb-2">
                <p className="m-0 text-sm text-muted">Your agreement with the agency usually covers every detail. Attach a contract only if this detail has its own.</p>
                <FormField label="Contract name" hint="Optional. The file name is used when blank.">
                  <Input value={contractLabel} onChange={(e) => setContractLabel(e.target.value)} maxLength={200} />
                </FormField>
                <FormField label="Contract file" hint="PDF, Word, JPG or PNG, up to 20 MB.">
                  <Input key={fileKey} type="file" accept={FILE_TYPES} onChange={(e) => setContractFile(e.target.files?.[0] ?? null)} className="py-2" />
                </FormField>
                {contractFile ? (
                  <Button variant="secondary" size="sm" className="w-fit" onClick={removeFile} aria-label={`Remove ${contractFile.name}`}>
                    Remove file
                  </Button>
                ) : null}
                <FormField label="Or a contract link" hint={contractFile ? "A file is attached. Remove the file to send a link instead." : "A signing service or shared drive link."}>
                  <Input type="url" value={contractUrl} onChange={(e) => setContractUrl(e.target.value)} maxLength={2000} placeholder="https://" disabled={!!contractFile} />
                </FormField>
              </div>
            </Disclosure>
          </div>
        </Card>
      </div>

      <Card tone="accent" className="md:sticky md:top-6">
        <CardTitle>Before you send</CardTitle>
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
          {rules.map((r) => (
            <li key={r} className="flex items-start gap-2">
              <Icon name="check" size={16} className="mt-0.5 shrink-0 text-muted" />
              <span>{r}</span>
            </li>
          ))}
        </ul>
        <Button type="submit" size="lg" full busy={busy}>
          {allDates.length > 1 ? `Send request for ${allDates.length} dates` : "Send request"}
        </Button>
        <ActionStatus result={result && !result.ok ? result : null} />
      </Card>
    </form>
  );
}
