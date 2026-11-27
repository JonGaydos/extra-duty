import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { withTx } from "@/ui/shell/request";
import { unreadAlertCount } from "@/domain/notifications/inbox";
import { loadShell } from "@/ui/shell/load-shell";
import { navFor } from "@/ui/shell/nav";
import { PhoneHeader } from "@/ui/shell/PhoneHeader";
import { ScrollMemory } from "@/ui/shell/ScrollMemory";
import { TabBar } from "@/ui/shell/TabBar";
import { TopNav } from "@/ui/shell/TopNav";
import { MapsPreferenceProvider } from "@/ui/components/MapsLink";
import { MapConfigProvider } from "@/ui/components/MapConfig";
import { getSettings } from "@/domain/settings/settings";
import { agencyLogoInfo } from "@/domain/settings/logo";
import { THEME_COOKIE, ThemeSync, parseTheme } from "@/ui/theme";
import { trainingConfigured } from "@/db/client";
import { appEnvFromProcess } from "@/lib/env";
import { PRACTICE_ROLE_LABELS } from "@/domain/training/mode";
import { TrainingBanner } from "@/ui/shell/TrainingSwitch";
import { backToLiveAction, switchToTrainingAction } from "@/ui/shell/training-actions";

/**
 * The signed-in shell: top nav from 768 px, a bottom tab bar below it, both
 * built from the person's role. The profile's theme wins over this device's
 * cookie. Under 768 px it is an app shell: fixed to the viewport height, with
 * the header and tab bar as static rows and only main scrolling, so the
 * document never scrolls and mobile browser toolbars stay put.
 */
export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const shell = await loadShell();
  if (!shell) redirect("/sign-in");
  const { actor, profile, mode, practiceRole, userRole } = shell;
  const training = mode === "training";
  // Coordinators and admins switch from the top bar while live; in training the banner takes them back.
  const canSwitch = !training && (userRole === "coordinator" || userRole === "admin") && trainingConfigured();
  const cookieTheme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const nav = navFor(actor.role, { outbox: mode === "training" || appEnvFromProcess() === "staging" });
  const staff = actor.role === "coordinator" || actor.role === "admin";
  const { unreadAlerts, settings, logo } = await withTx(async (tx) => ({
    unreadAlerts: await unreadAlertCount(actor, tx),
    settings: await getSettings(tx),
    // A logo that cannot be read leaves the header as text.
    logo: await agencyLogoInfo(tx).catch(() => null),
  }));
  const mapConfig = { tileUrl: settings.mapTileUrl, attribution: settings.mapAttribution, center: settings.mapDefaultCenter };

  return (
    <MapsPreferenceProvider initial={profile.mapsApp}>
      <MapConfigProvider value={mapConfig}>
        <div data-shell="app" className="relative flex flex-col max-md:h-dvh max-md:overflow-hidden">
          {profile.themePreference !== cookieTheme ? <ThemeSync theme={profile.themePreference} /> : null}
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2.5 focus:font-semibold focus:shadow-float"
          >
            Skip to content
          </a>
          {training ? <TrainingBanner roleLabel={practiceRole ? PRACTICE_ROLE_LABELS[practiceRole] : "Deputy"} backToLive={backToLiveAction} /> : null}
          <TopNav
            home={nav.home}
            items={nav.desktop}
            personal={nav.personal}
            name={profile.name}
            initials={profile.initials}
            coordinator={staff}
            theme={profile.themePreference}
            unreadAlerts={unreadAlerts}
            logo={logo}
            switchMode={canSwitch ? switchToTrainingAction : undefined}
          />
          {staff ? <PhoneHeader home={nav.home} unreadAlerts={unreadAlerts} logo={logo} /> : null}
          <main
            id="main"
            className="relative mx-auto w-full max-w-310 px-5 pt-5 pb-7 max-md:min-h-0 max-md:flex-1 max-md:overflow-y-auto max-md:overscroll-contain md:px-6 md:pt-6.5 md:pb-12"
          >
            {children}
          </main>
          <TabBar nav={nav} />
          {/* useSearchParams needs a Suspense boundary so pages can still render on the server. */}
          <Suspense fallback={null}>
            <ScrollMemory />
          </Suspense>
        </div>
      </MapConfigProvider>
    </MapsPreferenceProvider>
  );
}
