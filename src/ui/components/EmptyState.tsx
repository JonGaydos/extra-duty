import type { ReactNode } from "react";

/** What an empty list means and what to do next. Says what will appear here, not just "nothing here". */
export function EmptyState({ title, children, action }: Readonly<{ title: string; children?: ReactNode; action?: ReactNode }>) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <h2 className="m-0 text-title font-semibold md:text-base">{title}</h2>
      {children ? <p className="m-0 max-w-[48ch] text-muted">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
