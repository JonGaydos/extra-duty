import { StatusProvider } from "../coordinate/_coordinator/status";

/**
 * Details and every detail page: one status line for staff actions (bulk edit, New detail, Manage this detail), kept
 * across a move from New detail to the detail it made.
 */
export default function JobsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <StatusProvider>{children}</StatusProvider>;
}
