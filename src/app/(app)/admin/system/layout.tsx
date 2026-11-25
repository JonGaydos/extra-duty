import { systemActor } from "../_admin/session";

/** System screens: admins only. Coordinators get 403. */
export default async function SystemLayout({ children }: { children: React.ReactNode }) {
  await systemActor();
  return children;
}
