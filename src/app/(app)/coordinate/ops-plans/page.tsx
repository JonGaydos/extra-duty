import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { opsPlanQueue, vendorDirectory } from "@/domain/coordinator/views";
import { LIBRARY_PAGE_SIZE, searchLibrary } from "@/domain/ops-plans/library";
import { ValidationError } from "@/domain/errors";
import { agencyDateParts } from "@/domain/time/agency-time";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { Input, Select } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";
import { Icon } from "@/ui/icons";
import { PageTitle } from "../../_personnel/TabLinks";
import { dateLabel, dateTime, prefixed } from "../../_personnel/format";
import { coordinatorActor } from "../_coordinator/session";
import { CountSection, Row, Rows } from "../_coordinator/ui";
import { OpsPlanReview } from "../../jobs/[id]/_manage/DetailActions";

export const metadata: Metadata = { title: "Ops plans" };

const icSentence = (icName: string | null) => (icName ? `Incident Commander ${icName}.` : "No Incident Commander yet.");

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Ops plans that need a coordinator (overdue, waiting for review) and the library of agreed plans from past details. */
export default async function OpsPlansPage({ searchParams }: Readonly<Props>) {
  const actor = await coordinatorActor();
  const sp = await searchParams;
  const text = one(sp.q).slice(0, 200);
  const vendorId = one(sp.vendor);
  const year = Number(one(sp.year)) || undefined;
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const now = new Date();
  const data = await withTx(async (tx) => {
    const queue = await opsPlanQueue(actor, tx, now);
    const vendors = await vendorDirectory(actor, tx, now);
    let library: Awaited<ReturnType<typeof searchLibrary>> = [];
    let error: string | null = null;
    try {
      library = await searchLibrary(actor, tx, { text: text || undefined, vendorId: vendorId || undefined, year }, page, now);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      error = e.message;
    }
    return { queue, vendors, library, error };
  });
  const thisYear = agencyDateParts(now).year;
  const pageHref = (p: number) => `/coordinate/ops-plans?${new URLSearchParams({ ...(text ? { q: text } : {}), ...(vendorId ? { vendor: vendorId } : {}), ...(year ? { year: String(year) } : {}), page: String(p) })}#library`;

  return (
    <div className="flex flex-col gap-5.5">
      <PageTitle sub="Plans due from Incident Commanders, plans to review, and agreed plans to start from.">Ops plans</PageTitle>

      <CountSection title="Overdue" count={data.queue.overdue.length}>
        {data.queue.overdue.length === 0 ? (
          <Card>
            <p className="m-0 text-sm text-muted">No plan is overdue.</p>
          </Card>
        ) : (
          <Rows>
            {data.queue.overdue.map((o) => (
              <Row
                key={o.jobId}
                title={o.title}
                href={`/jobs/${o.jobId}?tab=manage#ops-plan`}
                meta={`${o.vendorName}, starts ${dateTime(o.startAt)}. ${icSentence(o.icName)}`}
                actions={<Chip tone="danger">Due {o.dueAt ? dateTime(o.dueAt) : "before the start"}</Chip>}
              />
            ))}
          </Rows>
        )}
      </CountSection>

      <CountSection title="Waiting for review" count={data.queue.waiting.length}>
        {data.queue.waiting.length === 0 ? (
          <Card>
            <p className="m-0 text-sm text-muted">Nothing waiting for review.</p>
          </Card>
        ) : (
          <Rows>
            {data.queue.waiting.map((o) => (
              <Row
                key={o.jobId}
                title={`${o.title}, version ${o.version}`}
                href={`/jobs/${o.jobId}?tab=manage#ops-plan`}
                meta={`${o.vendorName}. Submitted ${o.waitingSince ? dateTime(o.waitingSince) : ""}${prefixed(" by IC ", o.icName)}.`}
                actions={o.canReview && o.opsPlanId && o.versionId ? <OpsPlanReview opsPlanId={o.opsPlanId} versionId={o.versionId} /> : <Chip>Another reviewer</Chip>}
              />
            ))}
          </Rows>
        )}
      </CountSection>

      <CountSection title="Library" id="library">
        <form role="search" action="/coordinate/ops-plans#library" className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_14rem_8rem_auto]">
          <Input name="q" defaultValue={text} aria-label="Search plans" placeholder="Event, place or vendor" maxLength={200} />
          <Select name="vendor" defaultValue={vendorId} aria-label="Vendor">
            <option value="">All vendors</option>
            {data.vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
          <Select name="year" defaultValue={year ? String(year) : ""} aria-label="Year">
            <option value="">Any year</option>
            {Array.from({ length: 6 }, (_, i) => thisYear - i).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
          <button type="submit" className="flex h-11 items-center justify-center gap-2 rounded-sm border border-line bg-surface px-4 font-semibold hover:bg-subtle">
            <Icon name="search" size={18} />
            Search
          </button>
        </form>
        {data.error ? <Notice tone="danger">{data.error}</Notice> : null}
        {data.library.length === 0 ? (
          <Card>
            <p className="m-0 text-sm text-muted">No agreed plans match. Plans appear here once their detail is over.</p>
          </Card>
        ) : (
          <Rows>
            {data.library.map((r) => (
              <Row
                key={r.opsPlanId}
                title={r.jobTitle}
                href={`/jobs/${r.jobId}?tab=manage#ops-plan`}
                meta={`${r.vendorName}${prefixed(", ", r.location)}. ${dateLabel(r.startAt)}${prefixed(". IC ", r.icName)}.`}
                actions={
                  <a href={`/api/v1/ops-plans/versions/${r.versionId}/file`} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold" aria-label={`Download ${r.filename}`} download>
                    <Icon name="download" size={16} />
                    Download
                  </a>
                }
              />
            ))}
          </Rows>
        )}
        <div className="flex gap-3">
          {page > 1 ? (
            <a href={pageHref(page - 1)} className="inline-flex min-h-11 items-center text-sm font-semibold">
              Newer plans
            </a>
          ) : null}
          {data.library.length === LIBRARY_PAGE_SIZE ? (
            <a href={pageHref(page + 1)} className="inline-flex min-h-11 items-center text-sm font-semibold">
              Older plans
            </a>
          ) : null}
        </div>
      </CountSection>
    </div>
  );
}
