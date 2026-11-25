"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/ui/components/Button";
import { FormMessage, type Message } from "../form-message";
import { PasswordFields, PasswordSet } from "../password-fields";
import { postAuth } from "../post-json";

type Props = { token: string; minLength: number };

export function ResetPasswordForm({ token, minLength }: Props) {
  const [message, setMessage] = useState<Message>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = (text: string) => setMessage({ text, tone: "danger" });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get("password") ?? "");
    if (newPassword !== String(form.get("confirm") ?? "")) {
      error("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const { status, data } = await postAuth("/reset-password", { newPassword, token });
      if (status === 200) {
        setDone(true);
        setMessage(null);
      } else if (data.code === "PASSWORD_TOO_SHORT") {
        error(`Use at least ${minLength} characters.`);
      } else {
        error("This reset link is not valid or has expired. Request a new link.");
      }
    } catch {
      error("The request failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <PasswordSet />;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <PasswordFields minLength={minLength} label="New password" />
      <Button type="submit" size="lg" full busy={busy}>
        Set password
      </Button>
      <FormMessage message={message} />
    </form>
  );
}
