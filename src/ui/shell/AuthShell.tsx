import type { ReactNode } from "react";
import { AgencyLogo, type AgencyLogoData } from "../components/AgencyLogo";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /^[A-Z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join("");
}

/**
 * The signed-out frame (sign-in, code entry, invites, password resets): the
 * agency mark and name over one card, centered at phone width on every
 * screen. The agency logo shows in its square or wide slot; with no logo the
 * mark is a circle with the agency's initials.
 */
export function AuthShell({
  agencyName,
  logo,
  title,
  children,
  footer,
}: Readonly<{
  agencyName: string;
  logo?: AgencyLogoData | null;
  /** The page's h1, at the top of the card. */
  title: string;
  children: ReactNode;
  /** A muted line under the card. */
  footer?: ReactNode;
}>) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-110 flex-col gap-7 px-6 pt-14 pb-6 md:pt-20">
      <div className="flex flex-col items-center gap-3 text-center">
        {logo ? (
          <AgencyLogo logo={logo} place="signIn" />
        ) : (
          <div aria-hidden="true" className="flex size-19 items-center justify-center rounded-full border border-line bg-surface text-xl font-bold text-link">
            {initials(agencyName) || "ED"}
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          <p className="m-0 text-2xl font-bold">
            Signal 90 <span className="font-medium text-muted">· Extra Duty</span>
          </p>
          <p className="m-0 text-body text-muted">{agencyName}</p>
        </div>
      </div>
      <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5.5">
        <h1 className="m-0 text-xl font-bold">{title}</h1>
        {children}
      </section>
      {footer ? <p className="m-0 text-center text-xs text-muted">{footer}</p> : null}
    </main>
  );
}
