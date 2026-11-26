import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { users } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { NotFoundError, ValidationError } from "../errors";
import { isMapsApp, type MapsApp } from "@/lib/maps";

/** A day or night override; null follows the device setting. */
export type ThemePreference = "day" | "night" | null;

export type ShellProfile = { name: string; initials: string; themePreference: ThemePreference; mapsApp: MapsApp | null };

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts.at(-1)!] : parts;
  return letters.map((p) => p[0]!.toUpperCase()).join("");
}

/** What the app shell shows for the signed-in person. */
export async function getShellProfile(actor: Actor, tx: Tx): Promise<ShellProfile> {
  const [u] = await tx
    .select({ name: users.name, themePreference: users.themePreference, mapsApp: users.preferredMapsApp })
    .from(users)
    .where(eq(users.id, actor.userId));
  if (!u) throw new NotFoundError("User not found.");
  return { name: u.name, initials: initialsOf(u.name), themePreference: u.themePreference, mapsApp: u.mapsApp };
}

/** Saves the signed-in person's own theme override. */
export async function setThemePreference(actor: Actor, tx: Tx, theme: ThemePreference): Promise<void> {
  if (theme !== null && theme !== "day" && theme !== "night") {
    throw new ValidationError("Theme must be day, night or null.");
  }
  const [before] = await tx
    .select({ themePreference: users.themePreference })
    .from(users)
    .where(eq(users.id, actor.userId));
  if (!before) throw new NotFoundError("User not found.");
  await tx.update(users).set({ themePreference: theme, updatedAt: new Date() }).where(eq(users.id, actor.userId));
  await recordAudit(tx, {
    actor,
    action: "user.theme_set",
    entityType: "user",
    entityId: actor.userId,
    before,
    after: { themePreference: theme },
  });
}

/** Saves the signed-in person's own maps app for "Open in Maps"; null goes back to asking each time. */
export async function setMapsPreference(actor: Actor, tx: Tx, app: MapsApp | null): Promise<void> {
  if (app !== null && !isMapsApp(app)) throw new ValidationError("Choose Google Maps, Apple Maps, OpenStreetMap or ask each time.");
  const [before] = await tx.select({ preferredMapsApp: users.preferredMapsApp }).from(users).where(eq(users.id, actor.userId));
  if (!before) throw new NotFoundError("User not found.");
  await tx.update(users).set({ preferredMapsApp: app, updatedAt: new Date() }).where(eq(users.id, actor.userId));
  await recordAudit(tx, { actor, action: "user.maps_app_set", entityType: "user", entityId: actor.userId, before, after: { preferredMapsApp: app } });
}
