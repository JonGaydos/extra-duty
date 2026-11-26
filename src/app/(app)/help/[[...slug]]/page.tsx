import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { MANUALS, canReadManual, loadChapters, loadImageSizes, manualsFor, type Chapter, type ManualId } from "@/domain/manuals/manuals";
import { Card } from "@/ui/components/Card";
import { ManualBlocks } from "@/ui/help/ManualBlocks";
import { Icon } from "@/ui/icons";
import { loadShell } from "@/ui/shell/load-shell";

type Params = { slug?: string[] };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const [manual, chapter] = (await params).slug ?? [];
  const m = MANUALS.find((x) => x.id === manual);
  if (!m) return { title: "Help" };
  if (!chapter) return { title: m.title };
  const c = (await loadChapters(m.id)).find((x) => x.slug === chapter);
  return { title: c ? `${c.title} | ${m.title}` : m.title };
}

const back = (href: string, label: string) => (
  <Link href={href} className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
    <Icon name="chevronLeft" size={18} />
    {label}
  </Link>
);

/** One row per chapter, numbered, the whole row a link. */
function Contents({ manual, chapters, current }: Readonly<{ manual: ManualId; chapters: Chapter[]; current?: string }>) {
  return (
    <ol role="list" className="m-0 list-none p-0">
      {chapters.map((c) => (
        <li key={c.slug} className="border-t border-divider first:border-t-0">
          <Link
            href={`/help/${manual}/${c.slug}`}
            aria-current={c.slug === current ? "page" : undefined}
            data-nav-item
            className="flex min-h-12 items-center gap-3 px-4 py-2.5 text-body text-ink no-underline hover:bg-subtle hover:text-ink aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold aria-[current=page]:text-link"
          >
            <span className="w-6 shrink-0 text-right text-sm text-muted" data-numeric>
              {c.number}
            </span>
            <span className="flex-1">{c.title}</span>
            <Icon name="chevronRight" size={16} className="shrink-0 text-muted" />
          </Link>
        </li>
      ))}
    </ol>
  );
}

/**
 * Help: the user manuals in the app, rendered from the same Markdown as the PDFs (docs/manuals). Each role sees only
 * its own manuals (coordinators and admins also see the deputy and vendor manuals); any other manual is a 404.
 */
export default async function HelpPage({ params }: Readonly<{ params: Promise<Params> }>) {
  const shell = await loadShell();
  if (!shell) redirect("/sign-in");
  const role = shell.actor.role;
  const [manual, chapter, ...rest] = (await params).slug ?? [];

  if (!manual) {
    const mine = MANUALS.filter((m) => manualsFor(role).includes(m.id));
    const counts = await Promise.all(mine.map(async (m) => (await loadChapters(m.id)).length));
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-2xl font-bold md:text-3xl">Help</h1>
          <p className="m-0 max-w-[70ch] text-muted">Step-by-step guides with pictures. Each chapter covers one task.</p>
        </div>
        <ul role="list" className="m-0 grid list-none gap-3 p-0 md:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
          {mine.map((m, i) => (
            <li key={m.id} className="flex">
              <Card as="div" className="flex-1">
                <h2 className="m-0 text-title font-semibold md:text-base">
                  <Link href={`/help/${m.id}`}>{m.title}</Link>
                </h2>
                <p className="m-0 text-sm text-muted">{m.summary}</p>
                <p className="m-0 mt-auto text-xs font-semibold text-muted" data-numeric>
                  {counts[i]} chapters
                </p>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!canReadManual(role, manual) || rest.length) notFound();
  const m = MANUALS.find((x) => x.id === manual)!;
  const chapters = await loadChapters(m.id);

  if (!chapter) {
    return (
      <div className="flex flex-col gap-4">
        {back("/help", "Help")}
        <h1 className="m-0 text-2xl font-bold md:text-3xl">{m.title}</h1>
        <p className="m-0 max-w-[70ch] text-muted">{m.summary}</p>
        <Card pad={false} className="max-w-180 overflow-hidden">
          <Contents manual={m.id} chapters={chapters} />
        </Card>
      </div>
    );
  }

  const index = chapters.findIndex((c) => c.slug === chapter);
  if (index < 0) notFound();
  const c = chapters[index];
  const sizes = await loadImageSizes();
  const prev = chapters[index - 1];
  const next = chapters[index + 1];

  return (
    <div className="grid gap-6 md:grid-cols-[260px_minmax(0,1fr)] md:items-start">
      <nav aria-label="Chapters" className="hidden md:sticky md:top-4 md:flex md:flex-col md:gap-2">
        <Link href={`/help/${m.id}`} className="text-sm font-semibold">
          {m.title}
        </Link>
        <Card pad={false} className="max-h-[calc(100dvh-140px)] overflow-y-auto">
          <Contents manual={m.id} chapters={chapters} current={c.slug} />
        </Card>
      </nav>
      <article className="flex min-w-0 flex-col gap-4">
        {back(`/help/${m.id}`, m.title)}
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-2xl font-bold md:text-3xl">{c.title}</h1>
          <p className="m-0 text-sm text-muted" data-numeric>
            Chapter {c.number} of {chapters.length}
          </p>
        </div>
        <ManualBlocks blocks={c.blocks} manual={m.id} sizes={sizes} />
        <nav aria-label="Next and previous chapter" className="mt-4 flex flex-wrap justify-between gap-3 border-t border-divider pt-4">
          {prev ? (
            <Link href={`/help/${m.id}/${prev.slug}`} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold">
              <Icon name="chevronLeft" size={18} />
              {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={`/help/${m.id}/${next.slug}`} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold">
              {next.title}
              <Icon name="chevronRight" size={18} />
            </Link>
          ) : null}
        </nav>
      </article>
    </div>
  );
}
