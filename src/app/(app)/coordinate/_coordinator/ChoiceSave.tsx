"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Select } from "@/ui/components/FormField";
import type { ActionResult } from "../../_personnel/result";
import { Switch } from "../../admin/_admin/forms";
import { setVendorEmailApprovedAction, setVendorSendScheduleAction, setWaitForAllDeputiesAction } from "./actions";
import { useCoordAction } from "./status";

/** One labeled choice with its own Save, shown only once the choice changes. */
function ChoiceSave({
  label,
  hint,
  options,
  initial,
  save,
}: Readonly<{
  label: string;
  hint?: string;
  options: Array<[string, string]>;
  initial: string;
  save: (value: string) => Promise<ActionResult>;
}>) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const { run, busy } = useCoordAction();
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => save(value), () => setSaved(value));
      }}
    >
      <div className="min-w-0 sm:max-w-90 sm:flex-1">
        <FormField label={label} hint={hint}>
          <Select value={value} onChange={(e) => setValue(e.target.value)}>
            {options.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      {value !== saved ? (
        <Button type="submit" variant="secondary" busy={busy} className="w-full sm:w-fit">
          Save
        </Button>
      ) : null}
    </form>
  );
}

const SEND_LABEL = { immediate: "Right away", weekly: "Weekly", every_2_weeks: "Every two weeks", monthly: "Monthly" } as const;
type Schedule = keyof typeof SEND_LABEL;

/** A vendor's own invoice send schedule, or the agency's. */
export function VendorSendSchedule({ vendorId, current, agency }: Readonly<{ vendorId: string; current: Schedule | null; agency: Schedule }>) {
  return (
    <ChoiceSave
      label="Send this vendor's invoices"
      hint="Batched sends go in one email per vendor with a cover summary."
      initial={current ?? ""}
      options={[["", `Agency setting (${SEND_LABEL[agency].toLowerCase()})`], ...(Object.entries(SEND_LABEL) as Array<[string, string]>)]}
      save={(schedule) => setVendorSendScheduleAction({ vendorId, schedule })}
    />
  );
}

/** "Email approved invoices to this vendor": saves on each change and goes back if the save fails. */
export function VendorEmailApproved({ vendorId, initial }: Readonly<{ vendorId: string; initial: boolean }>) {
  const [on, setOn] = useState(initial);
  const { run } = useCoordAction();
  return (
    <div className="sm:max-w-120">
      <Switch
        label="Email approved invoices to this vendor"
        hint={on ? "Approving an invoice sends it. You can still approve one without sending." : "Approving an invoice does not send it. You can still send one when you approve it, or later."}
        checked={on}
        onChange={(next) => {
          setOn(next);
          run(async () => {
            const r = await setVendorEmailApprovedAction({ vendorId, on: next }).catch((e: unknown) => {
              setOn(!next);
              throw e;
            });
            if (!r.ok) setOn(!next);
            return r;
          });
        }}
      />
    </div>
  );
}

/** The saved choice as an option key: no choice of its own follows the agency. */
function holdChoice(current: boolean | null): "agency" | "on" | "off" {
  if (current === null) return "agency";
  return current ? "on" : "off";
}

/** A detail's own wait-for-all-deputies choice, or the agency's. */
export function DetailInvoiceHold({ jobId, current, agency }: Readonly<{ jobId: string; current: boolean | null; agency: boolean }>) {
  return (
    <ChoiceSave
      label="Batched invoices for this detail"
      hint="Only applies when this vendor's invoices go out in batches."
      initial={holdChoice(current)}
      options={[
        ["agency", `Agency setting (${agency ? "wait for every deputy" : "send as each is approved"})`],
        ["on", "Wait until every deputy has billed"],
        ["off", "Send each invoice as it is approved"],
      ]}
      save={(value) => setWaitForAllDeputiesAction({ jobId, value: value as "agency" | "on" | "off" })}
    />
  );
}
