import { StatusProvider } from "../coordinate/_coordinator/status";
import { vendorManagerActor } from "./session";

/** Manage: vendor managers only, with one shared status line for the location and contact actions. */
export default async function ManageLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await vendorManagerActor();
  return <StatusProvider>{children}</StatusProvider>;
}
