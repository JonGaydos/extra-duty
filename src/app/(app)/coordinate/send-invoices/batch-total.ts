/** What the send confirmation adds up: a paid invoice goes out marked Paid and adds nothing to the total due. */
export function totalDue(invoices: Array<{ totalCents: number; paid: boolean }>): number {
  return invoices.reduce((n, i) => n + (i.paid ? 0 : i.totalCents), 0);
}
