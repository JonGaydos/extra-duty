"use client";

import { useState, type SubmitEvent } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input } from "@/ui/components/FormField";
import { FormMessage, type Message } from "../form-message";
import { waitText } from "@/domain/auth/wait-text";
import { postAuth } from "../post-json";
import { formText } from "@/lib/form-text";

export function ForgotPasswordForm() {
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = formText(new FormData(e.currentTarget), "email");
    setBusy(true);
    try {
      const result = await postAuth("/request-password-reset", { email, redirectTo: "/reset-password" });
      setMessage(
        result.status === 429
          ? { tone: "danger", text: `Too many reset requests from this network. Wait ${waitText((result.retryAfter ?? 600) * 1000)} and try again.` }
          : { tone: "success", text: "If an account uses that email, we sent a reset link. It expires in 1 hour." },
      );
    } catch {
      setMessage({ tone: "danger", text: "The request failed. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <FormField label="Email">
        <Input id="email" name="email" type="email" autoComplete="username" size="lg" required />
      </FormField>
      <Button type="submit" size="lg" full busy={busy}>
        Email me a reset link
      </Button>
      <FormMessage message={message} />
    </form>
  );
}
