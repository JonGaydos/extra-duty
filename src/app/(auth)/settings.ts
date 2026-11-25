import { db } from "@/db/client";
import { agencyLogoInfo, type AgencyLogoInfo } from "@/domain/settings/logo";
import { getSettings, type AgencySettings } from "@/domain/settings/settings";

export function loadSettings(): Promise<AgencySettings> {
  return db.transaction((tx) => getSettings(tx));
}

/** The logo for the signed-out pages; a logo that cannot be read leaves the initials in its place. */
export async function loadLogo(): Promise<AgencyLogoInfo | null> {
  try {
    return await db.transaction((tx) => agencyLogoInfo(tx));
  } catch {
    return null;
  }
}
