"use server";

import { liveDb } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { switchMode, type PracticeRole } from "@/domain/training/mode";
import { requestContext } from "./request";

type Result = { ok: true } | { ok: false; error: string };

async function change(mode: "live" | "training", role?: PracticeRole): Promise<Result> {
  const ctx = await requestContext();
  if (!ctx) return { ok: false, error: "Your session ended. Sign in again." };
  try {
    // The signed-in person switches, never the demo user they practice as; sessions live in the live database.
    await liveDb.transaction((tx) => switchMode(ctx.user, tx, ctx.sessionId, mode, role));
    return { ok: true };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function switchToTrainingAction(role: PracticeRole): Promise<Result> {
  return change("training", role);
}

export async function backToLiveAction(): Promise<Result> {
  return change("live");
}
