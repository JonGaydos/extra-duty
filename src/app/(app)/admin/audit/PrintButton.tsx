"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Notice } from "@/ui/components/Notice";
import { Icon } from "@/ui/icons";
import { downloadError } from "../../coordinate/reports/download";

/** "Print this entry": the one-entry Audit Record, with the same layout as a larger one. */
export function PrintEntryButton({ id }: Readonly<{ id: string }>) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const print = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/v1/audit/print", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: {}, ids: [id] }) });
      if (!res.ok) {
        setStatus({ ok: false, text: await downloadError(res) });
        return;
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "audit-record.pdf";
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      a.click();
      URL.revokeObjectURL(href);
      setStatus({ ok: true, text: `Downloaded ${name}.` });
    } catch {
      setStatus({ ok: false, text: "The download did not work. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Button busy={busy} onClick={print} className="w-fit">
        <Icon name="file" size={18} />
        Print this entry
      </Button>
      <output aria-live="polite" className="block empty:hidden">
        {status ? (
          <Notice tone={status.ok ? "success" : "danger"} as="div">
            {status.text}
          </Notice>
        ) : null}
      </output>
    </div>
  );
}
