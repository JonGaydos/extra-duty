"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input } from "@/ui/components/FormField";
import { ActionStatus } from "../../_personnel/use-action";

/** The Incident Commander uploads the ops plan, or a new version after a denial or a change. */
export function OpsPlanUpload({ jobId, again }: { jobId: string; again: boolean }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        setBusy(true);
        setMsg(null);
        try {
          const body = new FormData();
          body.set("file", file);
          const res = await fetch(`/api/v1/jobs/${jobId}/ops-plan`, { method: "POST", body });
          const err = res.ok ? null : ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message;
          setMsg(res.ok ? { ok: true, text: "Ops plan submitted for review." } : { ok: false, text: err ?? "The ops plan could not be submitted. Use a PDF, DOCX or DOC under 20 MB." });
          if (res.ok) router.refresh();
        } catch {
          setMsg({ ok: false, text: "The ops plan could not be submitted. Check your connection and try again." });
        } finally {
          setBusy(false);
        }
      }}
    >
      <FormField label={again ? "New version of the ops plan" : "Ops plan file"} hint="You are the Incident Commander. PDF, DOCX or DOC, up to 20 MB.">
        <Input type="file" accept=".pdf,.docx,.doc,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="py-2" />
      </FormField>
      <Button type="submit" variant="secondary" busy={busy} disabled={!file} className="w-fit">
        {again ? "Submit new version" : "Submit ops plan"}
      </Button>
      <ActionStatus result={msg ? (msg.ok ? { ok: true, message: msg.text } : { ok: false, error: msg.text }) : null} />
    </form>
  );
}
