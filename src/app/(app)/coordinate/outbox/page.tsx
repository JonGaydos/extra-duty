import type { Metadata } from "next";
import { listOutbox, OUTBOX_PAGE_SIZE } from "@/domain/training/outbox";
import { Card } from "@/ui/components/Card";
import { Disclosure } from "@/ui/components/Disclosure";
import { EmptyState } from "@/ui/components/EmptyState";
import { loadShell } from "@/ui/shell/load-shell";
import { withTx } from "@/ui/shell/request";
import { PageTitle } from "../../_personnel/TabLinks";
import { dateTime } from "../../_personnel/format";
import { coordinatorActor } from "../_coordinator/session";
import { Row, Rows } from "../_coordinator/ui";
import { ResetTrainingButton } from "./ResetTrainingButton";

export const metadata: Metadata = { title: "Outbox" };

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Every email the app kept instead of sending: in training mode, and on the staging site. Nothing here was sent. */
export default async function OutboxPage() {
  const actor = await coordinatorActor();
  const shell = await loadShell();
  const training = shell?.mode === "training";
  const rows = await withTx((tx) => listOutbox(actor, tx));

  return (
    <div className="flex flex-col gap-5.5">
      <PageTitle
        sub={`Email the app would have sent ${training ? "in training" : "on this site"}. Nothing here was sent to anyone. The newest ${OUTBOX_PAGE_SIZE} are shown.`}
        action={training ? <ResetTrainingButton /> : null}
      >
        Outbox
      </PageTitle>
      {rows.length === 0 ? (
        <EmptyState title="No email yet">Invoices, alerts and other email show up here instead of being sent.</EmptyState>
      ) : (
        <Rows>
          {rows.map((m) => (
            <Row key={m.id} title={m.subject} meta={`${dateTime(m.createdAt)}. To ${m.to.join(", ")}`}>
              {m.attachments.length ? (
                <p className="m-0 text-sm text-muted">Attachments: {m.attachments.map((a) => `${a.filename} (${kb(a.size)})`).join(", ")}</p>
              ) : null}
              <Disclosure label="Show message" openLabel="Hide message">
                <Card>
                  <pre className="m-0 font-sans text-sm whitespace-pre-wrap">{m.text}</pre>
                </Card>
              </Disclosure>
            </Row>
          ))}
        </Rows>
      )}
    </div>
  );
}
