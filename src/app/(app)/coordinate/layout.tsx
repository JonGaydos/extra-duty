import { coordinatorActor } from "./_coordinator/session";
import { StatusProvider } from "./_coordinator/status";

/** Every coordinator screen: coordinators and admins only, with one shared status line. */
export default async function CoordinateLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await coordinatorActor();
  return <StatusProvider>{children}</StatusProvider>;
}
