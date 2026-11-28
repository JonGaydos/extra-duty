"use client";

import { useMemo, useRef, useState } from "react";
import type { MessageDef } from "@/domain/email-messages/catalog";
import type { PlaceholderKey, PlaceholderValues } from "@/domain/email-messages/placeholders";
import { messageProblem, placeholderChoices, renderMessage } from "@/domain/email-messages/render";
import { Button } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { FormField, Input, TextArea } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import { resetMessageAction, saveMessageAction, sendTestMessageAction } from "./message-actions";

type Field = "subject" | "body";

/** Paragraphs with keys from their own words, a repeat numbered. */
function keyed(paragraphs: string[]): Array<{ key: string; text: string }> {
  const seen = new Map<string, number>();
  return paragraphs.map((text) => {
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    return { key: `${n}:${text}`, text };
  });
}

/**
 * One email message: subject and body with Insert placeholder buttons, a live preview with sample values, Save, Send
 * me a test and Reset to default. Read-only (preview and test only) for a coordinator on an admins' message.
 */
export function MessageEditor({
  messageKey,
  def,
  initial,
  custom,
  changed,
  editable,
  samples,
}: Readonly<{ messageKey: string; def: MessageDef; initial: { subject: string; body: string }; custom: boolean; changed: string | null; editable: boolean; samples: PlaceholderValues }>) {
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const last = useRef<Field>("body");
  const { run, busy } = useCoordAction();
  const problem = messageProblem(def, { subject, body });
  const preview = useMemo(() => renderMessage({ subject, body }, samples), [subject, body, samples]);
  const dirty = subject !== initial.subject || body !== initial.body;

  const insert = (key: PlaceholderKey) => {
    const field = last.current;
    const el = document.getElementById(`message-${field}`) as HTMLInputElement | HTMLTextAreaElement | null;
    const token = `{{${key}}}`;
    const value = field === "subject" ? subject : body;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    (field === "subject" ? setSubject : setBody)(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="grid gap-4.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start md:gap-6">
      <Card>
        <CardTitle>Message</CardTitle>
        {editable ? null : <Notice tone="info">Only admins can change sign-in, invitation, password reset and security emails. You can preview it and send yourself a test.</Notice>}
        {def.confidential ? <Notice tone="info">This is a confidential detail&apos;s message. It can say only the date and time, so nothing about the detail leaves the app.</Notice> : null}
        <form
          aria-label="Email message"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => saveMessageAction({ key: messageKey, subject, body }));
          }}
        >
          <FormField label="Subject">
            <Input id="message-subject" value={subject} onChange={(e) => setSubject(e.target.value)} onFocus={() => (last.current = "subject")} readOnly={!editable} maxLength={200} />
          </FormField>
          <FormField label="Message" hint="Plain text. Leave a blank line between paragraphs. Web addresses become links. A paragraph whose placeholders are all empty is left out." error={problem ?? undefined}>
            <TextArea id="message-body" value={body} onChange={(e) => setBody(e.target.value)} onFocus={() => (last.current = "body")} readOnly={!editable} rows={12} maxLength={10_000} />
          </FormField>
          {editable ? (
            <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
              <legend className="mb-1 p-0 text-sm font-medium text-muted">Insert placeholder</legend>
              <div className="flex flex-wrap gap-2">
                {placeholderChoices(def).map((p) => (
                  <Button key={p.key} variant="secondary" size="sm" onClick={() => insert(p.key)} aria-label={`Insert ${p.label}`}>
                    {p.label}
                  </Button>
                ))}
              </div>
              {def.required?.length ? <p className="m-0 text-xs text-muted">Must stay in the message: {def.required.map((r) => `{{${r.key}}}`).join(", ")}.</p> : null}
            </fieldset>
          ) : null}
          <p className="m-0 text-sm text-muted" data-testid="message-changed">
            {changed ?? "The default message. Nobody has changed it."}
          </p>
          <div className="flex flex-wrap gap-2">
            {editable ? (
              <Button type="submit" busy={busy} disabled={!!problem || !dirty}>
                Save message
              </Button>
            ) : null}
            <Button variant="secondary" busy={busy} disabled={!!problem} onClick={() => run(() => sendTestMessageAction({ key: messageKey, subject, body }), undefined, { refresh: false })}>
              Send me a test
            </Button>
            {editable && custom ? (
              <Button
                variant="secondary"
                busy={busy}
                onClick={() =>
                  run(() => resetMessageAction({ key: messageKey }), () => {
                    setSubject(def.subject);
                    setBody(def.body);
                  })
                }
              >
                Reset to default
              </Button>
            ) : null}
          </div>
        </form>
      </Card>
      <Card tone="accent" className="md:sticky md:top-6">
        <CardTitle>Preview</CardTitle>
        <p className="m-0 text-xs text-muted">With sample details. Push and in-app alerts keep their own short wording.</p>
        <section aria-label="Preview" className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3.5">
          <p className="m-0 font-semibold" data-testid="preview-subject">
            {preview.subject}
          </p>
          <div className="flex flex-col gap-2.5 text-body break-words" data-testid="preview-body">
            {keyed(preview.text.split("\n\n")).map((p) => (
              <p key={p.key} className="m-0 whitespace-pre-line">
                {p.text}
              </p>
            ))}
          </div>
        </section>
      </Card>
    </div>
  );
}
