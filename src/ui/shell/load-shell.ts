import { cache } from "react";
import type { Actor } from "@/domain/actor";
import type { DataMode, PracticeRole } from "@/domain/training/mode";
import { getShellProfile, type ShellProfile } from "@/domain/users/profile";
import { requestContext } from "./request";

export type Shell = {
  /** Who the request acts as (in training, the demo user for the practice role). */
  actor: Actor;
  profile: ShellProfile;
  mode: DataMode;
  practiceRole: PracticeRole | null;
  /** The signed-in person's own role, which decides whether they may switch to training. */
  userRole: Actor["role"];
};

/**
 * The signed-in person and their shell profile, loaded once per request and
 * shared by the (app) layout and its pages. Null when signed out.
 */
export const loadShell = cache(async (): Promise<Shell | null> => {
  const ctx = await requestContext();
  if (!ctx) return null;
  const profile = await ctx.run((tx) => getShellProfile(ctx.actor, tx));
  return { actor: ctx.actor, profile, mode: ctx.mode, practiceRole: ctx.practiceRole, userRole: ctx.user.role };
});
