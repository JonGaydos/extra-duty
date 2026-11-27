export type Role = "admin" | "coordinator" | "personnel" | "vendor";

export type Actor = {
  userId: string;
  role: Role;
  rankId: string | null;
  vendorId: string | null;
  /**
   * The vendors a deputy manages (owner decision 2026-11-27). For these only, the scoped staff actions in the policy
   * are theirs too. Loaded for personnel; absent or empty for everyone else.
   */
  managedVendorIds?: readonly string[];
};
