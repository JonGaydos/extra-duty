"use client";

import { useRef, useState } from "react";
import { AgencyLogo, type AgencyLogoData } from "@/ui/components/AgencyLogo";
import { Button } from "@/ui/components/Button";
import { logoShape } from "@/lib/logo-fit";
import { FormField, Input } from "@/ui/components/FormField";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import type { ActionResult } from "../../_personnel/result";
import { removeLogoAction } from "../_admin/actions";

/** Posts the file to the logo route and reports back like a server action. */
async function uploadLogo(data: FormData): Promise<ActionResult> {
  const res = await fetch("/api/v1/agency/logo", { method: "POST", body: data });
  const body = (await res.json().catch(() => null)) as { data?: { message: string }; error?: { message: string } } | null;
  if (res.ok) return { ok: true, message: body?.data?.message };
  return { ok: false, error: body?.error?.message ?? "The logo could not be saved. Try again." };
}

/**
 * The logo on invoices, sign-in and the header: upload a PNG, SVG, JPG or WebP (each is redrawn as a PNG with its
 * margins trimmed on the server), or remove it. The preview shows the slot it gets: square, or wide for logos
 * about 1.3:1 and wider.
 */
export function LogoUpload({ logo, initials }: { logo: AgencyLogoData | null; initials: string }) {
  const fileId = logo?.fileId ?? null;
  const form = useRef<HTMLFormElement>(null);
  const [chosen, setChosen] = useState(false);
  const { run, busy } = useCoordAction();
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start">
      {logo ? (
        <figure className="m-0 flex shrink-0 flex-col items-start gap-1.5">
          <span role="img" aria-label="Agency logo">
            <AgencyLogo logo={logo} place="signIn" />
          </span>
          <figcaption className="text-xs text-muted" data-numeric>
            {logoShape(logo.width, logo.height) === "wide" ? "Wide logo: it gets the wider slot." : "Square slot."} {logo.width} by {logo.height} px after trimming.
          </figcaption>
        </figure>
      ) : (
        <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-subtle">
          <span role="img" className="text-xl font-bold text-muted" aria-label="No logo yet">
            {initials}
          </span>
        </div>
      )}
      <form
        ref={form}
        className="flex flex-1 flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          run(
            () => uploadLogo(data),
            () => {
              form.current?.reset();
              setChosen(false);
            },
          );
        }}
      >
        <FormField label="Logo file" hint="PNG, SVG, JPG or WebP, up to 2 MB. Empty margins are trimmed; wide logos get a wider slot.">
          <Input type="file" name="logo" accept="image/png,image/svg+xml,image/jpeg,image/webp,.png,.svg,.jpg,.jpeg,.webp" onChange={(e) => setChosen(!!e.target.files?.length)} className="py-2" />
        </FormField>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={busy} disabled={!chosen}>
            Upload logo
          </Button>
          {fileId ? (
            <Button type="button" variant="secondary" busy={busy} onClick={() => run(() => removeLogoAction())}>
              Remove logo
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
