export type Role = "admin" | "coordinator" | "personnel" | "vendor";

export type Actor = {
  userId: string;
  role: Role;
  rankId: string | null;
  vendorId: string | null;
};
