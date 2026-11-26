import { StatusProvider } from "../coordinate/_coordinator/status";
import { managementActor } from "./_admin/session";

/** Every Management screen: coordinators and admins only, with one shared status line. */
export default async function ManagementLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await managementActor();
  return <StatusProvider>{children}</StatusProvider>;
}
