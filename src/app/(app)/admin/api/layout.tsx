import { systemActor } from "../_admin/session";

/** API access is a security setting: admins only. Coordinators get 403. */
export default async function ApiLayout({ children }: { children: React.ReactNode }) {
  await systemActor();
  return children;
}
