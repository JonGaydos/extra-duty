"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import { createW9RequestAction } from "../_admin/actions";

type Option = { id: string; name: string };
type Kind = "everyone" | "rank" | "flag" | "person";

const KIND_LABEL: Record<Kind, string> = { everyone: "Everyone", rank: "A rank", flag: "A special flag", person: "One person" };

/** Ask for a new W-9: who (everyone, a rank, a special flag or one person), the due date and an optional note. */
export function RequestForm({ ranks, flags, people, tomorrow, initialPerson }: Readonly<{ ranks: Option[]; flags: Option[]; people: Option[]; tomorrow: string; initialPerson: string }>) {
  const [kind, setKind] = useState<Kind>(initialPerson ? "person" : "everyone");
  const choices: Record<Kind, Option[]> = { everyone: [], rank: ranks, flag: flags, person: people };
  const [picked, setPicked] = useState<Record<Kind, string>>({ everyone: "", rank: ranks[0]?.id ?? "", flag: flags[0]?.id ?? "", person: initialPerson || (people[0]?.id ?? "") });
  const [dueOn, setDueOn] = useState("");
  const [note, setNote] = useState("");
  const { run, busy } = useCoordAction();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => createW9RequestAction({ kind, id: picked[kind], dueOn, note }), () => setNote(""));
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="Ask">
          <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </FormField>
        {kind === "everyone" ? null : (
          <FormField label={KIND_LABEL[kind].replace(/^(A|One) /, "").replace(/^./, (c) => c.toUpperCase())}>
            <Select value={picked[kind]} onChange={(e) => setPicked({ ...picked, [kind]: e.target.value })} required>
              {choices[kind].map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <FormField label="Due date" hint="After this date, sign-ups lock until their new W-9 is approved.">
          <Input type="date" value={dueOn} min={tomorrow} onChange={(e) => setDueOn(e.target.value)} required />
        </FormField>
        <FormField label="Note" hint="Optional. For example: New IRS revision.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} autoComplete="off" />
        </FormField>
      </div>
      <Button type="submit" busy={busy} className="w-fit">
        Send request
      </Button>
    </form>
  );
}
