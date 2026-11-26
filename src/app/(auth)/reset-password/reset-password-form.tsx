"use client";

import { useState, type SubmitEvent } from "react";
import { Button } from "@/ui/components/Button";
import { FormMessage, type Message } from "../form-message";
import { PasswordFields, PasswordSet } from "../password-fields";
import { postAuth } from "../post-json";
import { formText } from "@/lib/form-text";

type Props = { token: string; minLength: number };

export function ResetPasswordForm({ token, minLength }: Readonly<Props>) {
  const [message, setMessage] = useState<Message>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = (text: string) => setMessage({ text, tone: "danger" });

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newPassword = formText(form, "password");
    if (newPassword !== formText(form, "confirm")) {
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
