"use client";

import { useState } from "react";
import { Button } from "../components/Button";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setBusy(true);
    setFailed(false);
    const res = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    if (res?.ok) {
      window.location.assign("/sign-in");
      return;
    }
    // The session may still be live: stay here and say so rather than pretend.
    setBusy(false);
    setFailed(true);
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" busy={busy} onClick={() => void signOut()} className="w-fit">
        Sign out
      </Button>
      {failed ? (
        <p role="alert" className="m-0 text-xs font-medium text-danger-ink">
          Could not sign you out. Check your connection and try again.
        </p>
      ) : null}
    </div>
  );
}
