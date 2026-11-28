import type { listMessages } from "@/domain/email-messages/store";
import { Chip } from "@/ui/components/Chip";
import { CountSection, Row, Rows } from "../../coordinate/_coordinator/ui";

type Groups = Awaited<ReturnType<typeof listMessages>>;

/**
 * Email messages (owner decision 2026-11-27): every email the app sends, in plain-language groups, each with who gets
 * it and when it goes out. Opening one edits its subject and text.
 */
export function EmailMessages({ groups, admin }: Readonly<{ groups: Groups; admin: boolean }>) {
  return (
    <section aria-labelledby="email-messages" className="flex max-w-240 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="email-messages" className="m-0 text-xl font-bold">
          Email messages
        </h2>
        <p className="m-0 text-sm text-muted">
          The words of every email the app sends. Each starts with the built-in wording; change a subject or message and it is used from the next email on. Push and in-app alerts keep their own short wording.
        </p>
      </div>
      {groups.map((g) => (
        <CountSection key={g.group} title={g.group} id={`messages-${g.group.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`}>
          <Rows>
            {g.messages.map((m) => (
              <Row
                key={m.key}
                title={m.label}
                href={`/admin/settings/reminders/email/${encodeURIComponent(m.key)}`}
                meta={`To ${m.who.charAt(0).toLowerCase()}${m.who.slice(1)}. ${m.when}`}
                actions={
                  <span className="flex flex-wrap gap-1.5">
                    {m.custom ? <Chip tone="info">Changed</Chip> : null}
                    {m.adminOnly && !admin ? <Chip>Admins only</Chip> : null}
                  </span>
                }
              />
            ))}
          </Rows>
        </CountSection>
      ))}
    </section>
  );
}
