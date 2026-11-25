"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input } from "@/ui/components/FormField";
import { FormMessage, type Message } from "../form-message";
import { postAuth, tooManyText } from "../post-json";
import { sendCode } from "./actions";

type Props = {
  trustedDeviceDays?: number;
  codeMinutes?: number;
};

const ERRORS: Record<string, string> = {
  INVALID_CODE: "That code is not correct.",
  OTP_HAS_EXPIRED: "That code has expired. Send a new code.",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "Too many tries with that code. Send a new code.",
  INVALID_TWO_FACTOR_COOKIE: "Your sign-in has timed out. Sign in again.",
};

export function TwoFactorForm({ trustedDeviceDays = 30, codeMinutes = 15 }: Props) {
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const sentOnLoad = useRef(false);

  async function requestCode() {
    setBusy(true);
    const result = await sendCode();
    setBusy(false);
    if (!result.ok) {
      setMessage({
        tone: "danger",
        text:
          result.reason === "rate_limited"
            ? (result.message ?? "Too many codes requested. Wait a few minutes and try again.")
            : "We could not send a code. Sign in again.",
      });
      return;
    }
    setMessage({ tone: "success", text: "We emailed you a 6-digit code." });
  }

  useEffect(() => {
    if (sentOnLoad.current) return;
    sentOnLoad.current = true;
    void requestCode();
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setMessage(null);
    try {
      const result = await postAuth("/two-factor/verify-otp", {
        code: String(form.get("code") ?? "").trim(),
        trustDevice: form.get("trustDevice") === "on",
      });
      if (result.status === 200) {
        window.location.assign("/");
        return;
      }
      setMessage({ tone: "danger", text: result.status === 429 ? tooManyText(result) : (ERRORS[result.data.code ?? ""] ?? "That code was not accepted.") });
    } catch {
      setMessage({ tone: "danger", text: "Verification failed. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <p className="m-0 text-muted">
        Enter the 6-digit code sent to your email. Codes expire after {codeMinutes} minutes.
      </p>
      <FormField label="Code">
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          size="code"
          data-numeric
          required
        />
      </FormField>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-body">
        <input id="trustDevice" name="trustDevice" type="checkbox" className="size-5 shrink-0 accent-accent" />
        Trust this device for {trustedDeviceDays} days
      </label>
      <Button type="submit" size="lg" full busy={busy}>
        Verify
      </Button>
      <Button type="button" variant="secondary" full onClick={() => void requestCode()} disabled={busy}>
        Send a new code
      </Button>
      <FormMessage message={message} />
    </form>
  );
}
