"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { Audience } from "@/domain/messages/messages";
import { Button } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { FormField, Input, Select, TextArea } from "@/ui/components/FormField";
import { Icon } from "@/ui/icons";
import { sendMessageAction } from "../../_personnel/actions";
import { ActionStatus, useAction } from "../../_personnel/use-action";

type Option = { id: string; name: string };

type Props = {
  people: Option[];
  ranks: Option[];
  jobs: Option[];
  canMessageAll: boolean;
  initialJobId: string;
  reply: { id: string; subject: string; to: string } | null;
};

type Pick = { key: string; label: string; audience: Audience };

/** A reply's subject: "Re: " added once; blank for a new message. */
function replySubject(reply: Props["reply"]): string {
  if (!reply) return "";
  return reply.subject.startsWith("Re: ") ? reply.subject : `Re: ${reply.subject}`;
}

type Add = (pick: Pick) => void;

/** Find people by name and add them one at a time. */
function PersonAdder({ query, setQuery, matches, add }: Readonly<{ query: string; setQuery: (v: string) => void; matches: Option[]; add: Add }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <FormField label="Name">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" placeholder="Start typing a name" />
      </FormField>
      {matches.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Matching people">
          {matches.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                onClick={() => {
                  add({ key: `user:${x.id}`, label: x.name, audience: { kind: "users", userIds: [x.id] } });
                  setQuery("");
                }}
                className="flex min-h-11 w-full items-center rounded-sm px-3 text-left hover:bg-subtle"
              >
                Add {x.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Add everyone with a rank. */
function RankAdder({ ranks, rankId, setRankId, add }: Readonly<{ ranks: Option[]; rankId: string; setRankId: (v: string) => void; add: Add }>) {
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1">
        <FormField label="Rank">
          <Select value={rankId} onChange={(e) => setRankId(e.target.value)}>
            {ranks.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      <Button variant="secondary" onClick={() => { const r = ranks.find((x) => x.id === rankId); if (r) add({ key: `rank:${r.id}`, label: `Every ${r.name}`, audience: { kind: "rank", rankIds: [r.id] } }); }}>
        Add rank
      </Button>
    </div>
  );
}

/** Add everyone on one of the person's upcoming jobs. */
function RosterAdder({ jobs, rosterJob, setRosterJob, add }: Readonly<{ jobs: Option[]; rosterJob: string; setRosterJob: (v: string) => void; add: Add }>) {
  if (jobs.length === 0) return <p className="m-0 text-sm text-muted">You are not on any upcoming jobs.</p>;
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <FormField label="Job">
          <Select value={rosterJob} onChange={(e) => setRosterJob(e.target.value)}>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      <Button variant="secondary" onClick={() => { const j = jobs.find((x) => x.id === rosterJob); if (j) add({ key: `job:${j.id}`, label: `Everyone on ${j.name}`, audience: { kind: "job", jobId: j.id } }); }}>
        Add roster
      </Button>
    </div>
  );
}

/**
 * New message: recipients from everyone, people by name, ranks, a job's roster or the coordinators, an
 * optional job link, subject and body. Vendors are never offered.
 */
export function Compose(p: Readonly<Props>) {
  const router = useRouter();
  const [picks, setPicks] = useState<Pick[]>(() => {
    const job = p.jobs.find((j) => j.id === p.initialJobId);
    return job && !p.reply ? [{ key: `job:${job.id}`, label: `Everyone on ${job.name}`, audience: { kind: "job", jobId: job.id } }] : [];
  });
  const [kind, setKind] = useState<"person" | "rank" | "job" | "coordinators" | "all">("person");
  const [query, setQuery] = useState("");
  const [rankId, setRankId] = useState(p.ranks[0]?.id ?? "");
  const [rosterJob, setRosterJob] = useState(p.jobs[0]?.id ?? "");
  const [jobLink, setJobLink] = useState(p.initialJobId);
  const [subject, setSubject] = useState(replySubject(p.reply));
  const [body, setBody] = useState("");
  const { run, busy, result } = useAction();

  const matches = useMemo(() => {
    const t = query.trim().toLowerCase();
    if (!t) return [];
    return p.people.filter((x) => x.name.toLowerCase().includes(t) && !picks.some((k) => k.key === `user:${x.id}`)).slice(0, 6);
  }, [query, p.people, picks]);

  const add = (pick: Pick) => setPicks((list) => (list.some((x) => x.key === pick.key) ? list : [...list, pick]));
  const audiences = (): Audience[] => {
    const users = picks.flatMap((x) => (x.audience.kind === "users" ? x.audience.userIds : []));
    const rest = picks.filter((x) => x.audience.kind !== "users").map((x) => x.audience);
    return users.length ? [...rest, { kind: "users", userIds: users }] : rest;
  };

  // The control for the chosen kind of recipient (a render function, so it keeps its place in the form).
  const adder = () => {
    if (kind === "person") return <PersonAdder query={query} setQuery={setQuery} matches={matches} add={add} />;
    if (kind === "rank") return <RankAdder ranks={p.ranks} rankId={rankId} setRankId={setRankId} add={add} />;
    if (kind === "job") return <RosterAdder jobs={p.jobs} rosterJob={rosterJob} setRosterJob={setRosterJob} add={add} />;
    return (
      <Button variant="secondary" className="w-fit" onClick={() => add(kind === "all" ? { key: "all", label: "Everyone", audience: { kind: "all" } } : { key: "coordinators", label: "Coordinators", audience: { kind: "coordinators" } })}>
        {kind === "all" ? "Add everyone" : "Add the coordinators"}
      </Button>
    );
  };

  return (
    <form
      className="flex flex-col gap-4.5"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () => sendMessageAction({ audiences: audiences(), subject, body, jobId: jobLink || undefined, replyToMessageId: p.reply?.id }),
          (r) => router.push(r.value ? `/messages/${r.value}` : "/messages?tab=sent"),
          false,
        );
      }}
    >
      <Card>
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-2 text-title font-semibold md:text-base">To</legend>
          {p.reply ? <p className="m-0 text-sm">Your reply goes to {p.reply.to}. Add more people if you need to.</p> : null}
          {picks.length > 0 ? (
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Recipients">
              {picks.map((x) => (
                <li key={x.key} className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pr-0.5 pl-3 text-sm font-semibold text-link">
                  {x.label}
                  <button type="button" onClick={() => setPicks((l) => l.filter((y) => y.key !== x.key))} aria-label={`Remove ${x.label}`} className="flex size-8 items-center justify-center rounded-full hover:bg-surface pointer-coarse:size-11">
                    <Icon name="cross" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <FormField label="Add">
            <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="person">People by name</option>
              <option value="rank">Everyone with a rank</option>
              <option value="job">Everyone on a job</option>
              <option value="coordinators">The coordinators</option>
              {p.canMessageAll ? <option value="all">Everyone</option> : null}
            </Select>
          </FormField>
          {adder()}
          <p className="m-0 text-xs text-muted">Pick everyone, people by name, a rank, a job&apos;s roster, or coordinators. Vendors cannot be messaged here.</p>
        </fieldset>
      </Card>
      <Card>
        <FormField label="About a job" hint="Optional. Links the message to the job.">
          <Select value={jobLink} onChange={(e) => setJobLink(e.target.value)}>
            <option value="">No job</option>
            {p.jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} required />
        </FormField>
        <FormField label="Message">
          <TextArea value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} required className="min-h-36" />
        </FormField>
      </Card>
      <ActionStatus result={result} />
      <Button type="submit" size="lg" busy={busy} disabled={picks.length === 0 && !p.reply} className="md:w-fit">
        Send message
      </Button>
    </form>
  );
}
