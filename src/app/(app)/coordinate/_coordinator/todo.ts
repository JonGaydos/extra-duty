import type { CoordinatorTodo } from "@/domain/coordinator/views";
import { dollars } from "@/ui/components/PayLabel";

/** A detail's staff controls: the Manage tab of the shared detail page. */
export const manageHref = (job: string | number, hash = "") => `/jobs/${job}?tab=manage${hash}`;

/** Every item waiting on a coordinator; an open access review counts as one. */
export function todoCount(t: CoordinatorTodo): number {
  return (
    (t.accessReview ? 1 : 0) +
    t.lockedStarted.length +
    t.lockedSoon.length +
    t.requests.length +
    t.changes.length +
    t.notes.length +
    t.flagRequests.length +
    t.missingContract.length +
    t.invoices.length +
    t.issues.length +
    t.opsOverdue.length +
    t.opsWaiting.length +
    t.unfilled.length +
    t.locks.length +
    t.ratesOutOfRange.length +
    t.sendInvoices.length +
    t.departed.length +
    t.w9Reviews.length +
    t.offeredNotTaken.length +
    t.overdueAcks.length
  );
}

/** The To-do page's summary line, in To-do words (owner rule: never "needs you"). */
export function todoLine(total: number): string {
  if (total === 0) return "Your to-do list is clear.";
  return `To-do: ${total} ${total === 1 ? "item" : "items"}.`;
}

export type TodoItem = { key: string; text: string; href: string };

const TODO = "/coordinate";

/** The first few to-do items, most urgent first, in the To-do tab's own order, as one line and a link each. */
export function firstTodoItems(t: CoordinatorTodo, limit = 3): TodoItem[] {
  const items: TodoItem[] = [
    ...(t.accessReview ? [{ key: "review", text: `Access review: ${t.accessReview.decided} of ${t.accessReview.total} accounts reviewed`, href: "/admin" }] : []),
    ...t.lockedStarted.map((j) => ({ key: `ls-${j.jobId}`, text: `Locked detail started: #${j.number} ${j.title}, ${j.vendorName}`, href: manageHref(j.number) })),
    ...t.lockedSoon.map((j) => ({ key: `lsoon-${j.jobId}`, text: `Locked, starting soon: #${j.number} ${j.vendorName}`, href: manageHref(j.number) })),
    ...t.requests.map((r) => ({ key: `req-${r.jobId}`, text: `Vendor request: #${r.number} ${r.title}, ${r.vendorName}`, href: manageHref(r.number) })),
    ...t.changes.map((c) => ({ key: `chg-${c.requestId}`, text: `Change requested: #${c.number} ${c.title}, ${c.vendorName}`, href: manageHref(c.number) })),
    ...t.notes.map((n) => ({ key: `note-${n.id}`, text: `Deputy note to review: ${n.vendorName}, by ${n.authorName}`, href: TODO })),
    ...t.flagRequests.map((f) => ({ key: `flag-${f.id}`, text: `Flag request: ${f.userName}, ${f.qualificationName}`, href: TODO })),
    ...t.missingContract.map((m) => ({ key: `mc-${m.jobId}`, text: `Missing a contract: #${m.number} ${m.title}, ${m.vendorName}`, href: manageHref(m.number) })),
    ...t.invoices.map((i) => ({ key: `inv-${i.id}`, text: `Invoice to review: ${i.payeeName}, ${i.vendorName}, ${dollars(i.totalCents)}`, href: `/invoices/${i.id}` })),
    ...t.sendInvoices.map((b) => ({ key: `send-${b.vendorId}`, text: `Invoices to send: ${b.vendorName}`, href: `/coordinate/send-invoices#vendor-${b.vendorId}` })),
    ...t.issues.map((i) => ({ key: `iss-${i.issueId}`, text: `Payment issue: ${i.vendorName}, for ${i.payeeName}`, href: `/invoices/${i.invoiceId}` })),
    ...t.opsOverdue.map((o) => ({ key: `opso-${o.jobId}`, text: `Ops plan overdue: ${o.title}`, href: manageHref(o.jobId, "#ops-plan") })),
    ...t.opsWaiting.map((o) => ({ key: `opsw-${o.jobId}`, text: `Ops plan waiting for review: ${o.title}`, href: manageHref(o.jobId, "#ops-plan") })),
    ...t.unfilled.map((u) => ({ key: `unf-${u.jobId}`, text: `Unfilled, starting soon: #${u.number} ${u.title}, ${u.vendorName}`, href: manageHref(u.number) })),
    ...t.ratesOutOfRange.map((r) => ({ key: `rate-${r.jobId}`, text: `Rate outside the agency range: ${r.vendorName}, ${r.title}`, href: manageHref(r.jobId) })),
    ...t.w9Reviews.map((w) => ({ key: `w9-${w.w9Id}`, text: `W-9 to review: ${w.name}`, href: `/admin/users/${w.userId}#w9` })),
    ...t.departed.map((d) => ({ key: `dep-${d.assignmentId}`, text: `Left the agency, not billed: ${d.name}`, href: `/admin/users/${d.userId}` })),
    ...t.overdueAcks.map((m) => ({ key: `ack-${m.messageId}`, text: `Message not acknowledged: ${m.subject}, ${m.acknowledged} of ${m.total}`, href: `/messages/${m.messageId}#acknowledgements` })),
    ...t.locks.map((l) => ({ key: `lock-${l.userId}`, text: `Sign-up lock: ${l.name}`, href: TODO })),
  ];
  return items.slice(0, limit);
}
