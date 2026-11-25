import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { NOTE_PRESET_CONTEXTS, listNotePresets } from "@/domain/jobs/job-types";
import { Card } from "@/ui/components/Card";
import { PageTitle } from "../../_personnel/TabLinks";
import { CountSection } from "../../coordinate/_coordinator/ui";
import { PRESET_CONTEXT_LABEL } from "../_admin/labels";
import { managementActor } from "../_admin/session";
import { AddPreset, PresetRow } from "./PresetActions";

export const metadata: Metadata = { title: "Note presets" };

/** Ready-made notes offered in each place people write one, so the common answers are one tap. */
export default async function NotePresetsPage() {
  const actor = await managementActor();
  const presets = await withTx((tx) => listNotePresets(actor, tx));
  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="Offered as one-tap notes. People can still write their own.">Note presets</PageTitle>
      <div className="grid items-start gap-6 md:grid-cols-2">
        {NOTE_PRESET_CONTEXTS.map((c) => {
          const list = presets.filter((p) => p.context === c);
          return (
            <CountSection key={c} id={`ctx-${c}`} title={PRESET_CONTEXT_LABEL[c]} count={list.filter((p) => p.active).length}>
              <Card pad={false} as="div">
                <ul className="m-0 list-none divide-y divide-divider p-0">
                  {list.map((p) => (
                    <PresetRow key={`${p.id}-${p.text}-${p.active}`} id={p.id} text={p.text} active={p.active} />
                  ))}
                  <AddPreset context={c} label={PRESET_CONTEXT_LABEL[c]} />
                </ul>
              </Card>
            </CountSection>
          );
        })}
      </div>
    </div>
  );
}
