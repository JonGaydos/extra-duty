"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/ui/components/Button";
import { FormMessage, type Message } from "../form-message";
import { PasswordFields, PasswordSet } from "../password-fields";
import { acceptInviteAction } from "./actions";

type Props = { token: string; minLength: number };

export function AcceptInviteForm({ token, minLength }: Props) {
  const [message, setMessage] = useState<Message>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = (text: string) => setMessage({ text, tone: "danger" });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirm") ?? "")) {
      error("The passwords do not match.");
      return;
    }
    setBusy(true);
    const result = await acceptInviteAction(token, password);
    setBusy(false);
    if (result.ok) setDone(true);
    else error(result.error ?? "Something went wrong. Try again.");
  }

  if (done) return <PasswordSet />;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <PasswordFields minLength={minLength} />
      <Button type="submit" size="lg" full busy={busy}>
        Set password
      </Button>
      <FormMessage message={message} />
    </form>
  );
}
