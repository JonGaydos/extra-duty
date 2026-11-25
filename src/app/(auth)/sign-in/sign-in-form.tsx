"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input } from "@/ui/components/FormField";
import { FormMessage, type Message } from "../form-message";
import { postAuth, tooManyText } from "../post-json";

export function SignInForm() {
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const error = (text: string) => setMessage({ text, tone: "danger" });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setMessage(null);
    try {
      const result = await postAuth("/sign-in/email", { email, password });
      const { status, data } = result;
      if (status === 200) {
        window.location.assign(data.twoFactorRedirect ? "/two-factor" : "/");
        return;
      }
      if (data.code === "ACCOUNT_LOCKED") {
        await postAuth("/request-password-reset", { email, redirectTo: "/reset-password" });
        setMessage({
          tone: "warning",
          text:
            "This account is locked. We emailed you a link to reset your password. " +
            "After you set a new password, sign in with it and the 6-digit code we email you.",
        });
      } else if (data.code === "ACCOUNT_DISABLED") {
        error("This account is deactivated. Contact a coordinator.");
      } else if (status === 429) {
        error(tooManyText(result));
      } else {
        error("The email or password is not correct.");
      }
    } catch {
      error("Sign-in failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <FormField label="Email">
        <Input id="email" name="email" type="email" autoComplete="username" size="lg" required />
      </FormField>
      <FormField label="Password">
        <Input id="password" name="password" type="password" autoComplete="current-password" size="lg" required />
      </FormField>
      <Button type="submit" size="lg" full busy={busy}>
        Sign in
      </Button>
      <FormMessage message={message} />
    </form>
  );
}
