"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { useCoordAction } from "../../../coordinate/_coordinator/status";
import { Check, Switch } from "../../_admin/forms";
import { saveEmailAction, sendTestEmailAction, type EmailForm as Fields } from "../_system/actions";
import { PROVIDER_LABEL } from "../labels";

type Provider = keyof typeof PROVIDER_LABEL;
const REGION_HINT: Partial<Record<Provider, string>> = { ses: "Such as us-east-1.", mailgun: "US or EU." };

/** What the page knows about saved secrets: only whether they are set, never the value. */
export type SecretState = { passwordSet: boolean; apiKeySet: boolean };

function secretHint(set: boolean, name: string) {
  return set ? `${name} is set. Leave blank to keep it.` : `${name} is not set.`;
}

export function EmailSettingsForm({ initial, secrets }: Readonly<{ initial: Omit<Fields, "password" | "apiKey" | "clearPassword" | "clearApiKey">; secrets: SecretState }>) {
  const [v, setV] = useState<Fields>({ ...initial, password: "", apiKey: "", clearPassword: false, clearApiKey: false });
  const { run, busy, error } = useCoordAction();
  const errors = error && !error.ok ? (error.fields ?? {}) : {};
  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const smtp = v.provider === "smtp";
  return (
    <form
      noValidate
      aria-label="Email settings"
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => saveEmailAction(v), () => setV((cur) => ({ ...cur, password: "", apiKey: "", clearPassword: false, clearApiKey: false })));
      }}
    >
      <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
        <FormField label="Provider" error={errors.provider}>
          <Select value={v.provider} onChange={set("provider")}>
            {(Object.keys(PROVIDER_LABEL) as Provider[]).map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="From address" hint="Such as Extra Duty <noreply@agency.gov>." error={errors.from}>
          <Input value={v.from} onChange={set("from")} maxLength={320} autoComplete="off" />
        </FormField>
      </div>
      {smtp ? (
        <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
          <legend className="mb-3 p-0 text-title font-semibold">SMTP server</legend>
          <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
            <FormField label="Host" error={errors.host}>
              <Input value={v.host} onChange={set("host")} maxLength={253} autoComplete="off" spellCheck={false} />
            </FormField>
            <FormField label="Port" hint="Usually 587, or 465 with TLS from the start." error={errors.port}>
              <Input value={v.port} onChange={set("port")} inputMode="numeric" data-numeric className="md:max-w-48" />
            </FormField>
            <FormField label="Username" hint="Blank if the server needs no sign-in.">
              <Input value={v.user} onChange={set("user")} maxLength={320} autoComplete="off" spellCheck={false} />
            </FormField>
            <div className="flex flex-col gap-1">
              <FormField label="Password" hint={secretHint(secrets.passwordSet, "Password")}>
                <Input type="password" value={v.password} onChange={set("password")} autoComplete="new-password" disabled={v.clearPassword} />
              </FormField>
              {secrets.passwordSet ? <Check label="Remove the saved password" checked={v.clearPassword} onChange={(clearPassword) => setV({ ...v, clearPassword, password: "" })} /> : null}
            </div>
          </div>
          <Switch label="Use TLS from the start" hint="Turn on for port 465. Port 587 upgrades to TLS on its own." checked={v.secure} onChange={(secure) => setV({ ...v, secure })} />
        </fieldset>
      ) : (
        <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
          <legend className="mb-3 p-0 text-title font-semibold">{PROVIDER_LABEL[v.provider as Provider] ?? "Provider"} account</legend>
          <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <FormField label="API key" hint={`${secretHint(secrets.apiKeySet, "API key")}${v.provider === "ses" ? " Enter it as ACCESS_KEY_ID:SECRET_ACCESS_KEY." : ""}`}>
                <Input type="password" value={v.apiKey} onChange={set("apiKey")} autoComplete="new-password" disabled={v.clearApiKey} />
              </FormField>
              {secrets.apiKeySet ? <Check label="Remove the saved API key" checked={v.clearApiKey} onChange={(clearApiKey) => setV({ ...v, clearApiKey, apiKey: "" })} /> : null}
            </div>
            {REGION_HINT[v.provider as Provider] ? (
              <FormField label="Region" hint={REGION_HINT[v.provider as Provider]}>
                <Input value={v.region} onChange={set("region")} maxLength={40} autoComplete="off" />
              </FormField>
            ) : null}
          </div>
        </fieldset>
      )}
      <Button type="submit" busy={busy} className="w-full md:w-fit">
        Save email settings
      </Button>
    </form>
  );
}

export function TestEmail({ to }: Readonly<{ to: string }>) {
  const { run, busy } = useCoordAction();
  return (
    <Card>
      <CardTitle>Test email</CardTitle>
      <p className="m-0 max-w-[70ch] text-muted">Sends one message to {to} through the saved settings, right away. Save your changes first.</p>
      <Button variant="secondary" busy={busy} onClick={() => run(() => sendTestEmailAction(), undefined, { refresh: false })} className="w-full md:w-fit">
        Send test email
      </Button>
    </Card>
  );
}
