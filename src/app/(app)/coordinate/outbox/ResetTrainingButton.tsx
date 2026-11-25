"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { ActionStatus, useAction } from "../../_personnel/use-action";
import { resetTrainingAction } from "./actions";

/** "Reset training data", with a confirmation: everything practiced since the last reset is replaced. */
export function ResetTrainingButton() {
  const { run, busy, result } = useAction();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col items-end gap-2">
      {confirming ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="m-0 text-sm">Replace all training data with the starting demo data?</p>
          <Button size="sm" variant="danger" busy={busy} onClick={() => run(resetTrainingAction, () => setConfirming(false))}>
            Reset training data
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>
          Reset training data
        </Button>
      )}
      <ActionStatus result={result} />
    </div>
  );
}
