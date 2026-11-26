"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Chip } from "@/ui/components/Chip";
import { FormField, Input } from "@/ui/components/FormField";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import { createPresetAction, presetActiveAction, updatePresetAction } from "../_admin/actions";

export function PresetRow({ id, text, active }: Readonly<{ id: string; text: string; active: boolean }>) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(text);
  const { run, busy } = useCoordAction();
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3 md:flex-row md:items-center md:justify-between md:gap-4">
      {editing ? (
        <form
          className="flex flex-1 flex-col gap-2 md:flex-row md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => updatePresetAction({ id, text: v }), () => setEditing(false));
          }}
        >
          <div className="flex-1">
            <FormField label="Preset text">
              <Input value={v} onChange={(e) => setV(e.target.value)} required maxLength={300} autoFocus />
            </FormField>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" busy={busy}>
              Save
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
              Close
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className={`m-0 flex flex-wrap items-center gap-2 ${active ? "" : "text-muted"}`}>
            {text}
            {!active ? <Chip>Off</Chip> : null}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="secondary" aria-label={`Edit "${text}"`} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="secondary" busy={busy} aria-label={`${active ? "Turn off" : "Turn on"} "${text}"`} onClick={() => run(() => presetActiveAction({ id, active: !active }))}>
              {active ? "Turn off" : "Turn on"}
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

export function AddPreset({ context, label }: Readonly<{ context: string; label: string }>) {
  const [text, setText] = useState("");
  const { run, busy } = useCoordAction();
  return (
    <li className="px-4 py-3">
      <form
        className="flex flex-col gap-2 md:flex-row md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => createPresetAction({ context, text }), () => setText(""));
        }}
      >
        <div className="flex-1">
          <FormField label={`New preset for ${label.toLowerCase()}`}>
            <Input value={text} onChange={(e) => setText(e.target.value)} required maxLength={300} />
          </FormField>
        </div>
        <Button type="submit" size="sm" busy={busy} className="md:h-11">
          Add preset
        </Button>
      </form>
    </li>
  );
}
