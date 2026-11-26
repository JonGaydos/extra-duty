import Link from "next/link";
import type { ReactNode } from "react";
import type { Block, Inline } from "@/domain/manuals/markdown";
import { chapterSlug, desktopVariant, helpImageUrl } from "@/domain/manuals/manuals";
import { Notice } from "@/ui/components/Notice";
import { keyedByContent } from "@/lib/list-keys";

export type ImageSizes = Record<string, { width: number; height: number }>;

type Ctx = {
  manual: string;
  /** Pixel sizes by image path ("deputy/x-1-phone.webp"), so pictures keep their space while loading. */
  sizes: ImageSizes;
};

/** A link inside a chapter: another chapter ("billing.md" or "03-billing.md") stays in Help; anything else is a plain link. */
function href(target: string, manual: string): string {
  if (/^https?:\/\//.test(target)) return target;
  const m = /^(?:\.\.\/([a-z-]+)\/)?([0-9a-z-]+)\.md(#.*)?$/.exec(target);
  if (!m) return target;
  const chapter = chapterSlug(`${m[2]}.md`);
  return `/help/${m[1] ?? manual}/${chapter}${m[3] ?? ""}`;
}

function textNode(key: string, p: Inline, ctx: Ctx) {
  if (p.t === "strong") {
    return (
      <strong key={key} className="font-semibold">
        {p.v}
      </strong>
    );
  }
  if (p.t === "code") {
    return (
      <kbd key={key} className="rounded-xs border border-line bg-subtle px-1.5 py-px font-sans text-sm font-semibold">
        {p.v}
      </kbd>
    );
  }
  if (p.t === "link" && /^https?:/.test(p.href)) {
    return (
      <a key={key} href={p.href} target="_blank" rel="noreferrer">
        {p.v}
      </a>
    );
  }
  if (p.t === "link") {
    return (
      <Link key={key} href={href(p.href, ctx.manual)}>
        {p.v}
      </Link>
    );
  }
  return <span key={key}>{p.v}</span>;
}

function Text({ inline, ctx }: Readonly<{ inline: Inline[]; ctx: Ctx }>) {
  return <>{keyedByContent(inline).map(({ key, item: p }) => textNode(key, p, ctx))}</>;
}

/** A phone shot is phone sized unless a desktop twin takes over from 768 px; a desktop shot fills the column. */
function shotWidth(phone: boolean, hasTwin: boolean): string {
  if (!phone) return "w-full";
  return hasTwin ? "w-full max-w-70 md:max-w-full" : "w-full max-w-70";
}

/**
 * A screenshot. A phone shot with a desktop twin shows the desktop picture from 768 px up; a lone phone shot stays
 * phone sized; a desktop shot fills the column.
 */
function Shot({ alt, src, ctx }: Readonly<{ alt: string; src: string; ctx: Ctx }>) {
  const url = helpImageUrl(src);
  if (!url) return null;
  const key = url.replace(/^\/help-images\//, "");
  const size = ctx.sizes[key];
  const twin = desktopVariant(key);
  const twinSize = twin ? ctx.sizes[twin] : undefined;
  const phone = /-phone\.webp$/.test(key);
  const frame = "block h-auto rounded-md border border-line bg-surface";
  const img = (
    // eslint-disable-next-line @next/next/no-img-element -- served by our own route with a role check, sized from the manifest
    <img
      src={url}
      // The caption below says the same, so screen readers hear it once.
      alt=""
      width={size?.width}
      height={size?.height}
      loading="lazy"
      decoding="async"
      className={`${frame} ${shotWidth(phone, Boolean(twinSize))}`}
    />
  );
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      {twin && twinSize ? (
        <picture>
          <source media="(min-width: 768px)" srcSet={`/help-images/${twin}`} width={twinSize.width} height={twinSize.height} />
          {img}
        </picture>
      ) : (
        img
      )}
      <figcaption className="text-xs text-muted">{alt}</figcaption>
    </figure>
  );
}

function BlockView({ block, ctx, nested = false }: Readonly<{ block: Block; ctx: Ctx; nested?: boolean }>): ReactNode {
  switch (block.type) {
    case "heading":
      // The chapter's own title is the page h1; headings inside a chapter start at h2.
      if (block.level === 1) return null;
      if (block.level === 2) return <h2 className="m-0 mt-4 text-title font-semibold md:text-base">{block.text}</h2>;
      return <h3 className="m-0 mt-2 text-body font-semibold">{block.text}</h3>;
    case "paragraph":
      return (
        <p className={`m-0 max-w-[70ch]${nested ? "" : " text-body"}`}>
          <Text inline={block.inline} ctx={ctx} />
        </p>
      );
    case "note":
      return (
        <div className="max-w-[70ch]">
          <Notice tone="info" as="div">
            <Text inline={block.inline} ctx={ctx} />
          </Notice>
        </div>
      );
    case "image":
      return <Shot alt={block.alt} src={block.src} ctx={ctx} />;
    case "list":
      return block.ordered ? (
        <ol role="list" className="m-0 flex list-none flex-col gap-6 p-0">
          {keyedByContent(block.items).map(({ key, item, index: i }) => (
            <li key={key} className="grid grid-cols-[28px_1fr] gap-x-3 gap-y-3">
              <span className="flex size-7 items-center justify-center rounded-full bg-sunken text-sm font-bold text-ink" data-numeric>
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-3 pt-0.5">
                {keyedByContent(item).map(({ key: inner, item: b }) => (
                  <BlockView key={inner} block={b} ctx={ctx} nested />
                ))}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <ul className="m-0 flex max-w-[70ch] list-disc flex-col gap-1.5 pl-5">
          {keyedByContent(block.items).map(({ key, item }) => (
            <li key={key} className="pl-1">
              {keyedByContent(item).map(({ key: inner, item: b }) => (
                <BlockView key={inner} block={b} ctx={ctx} nested />
              ))}
            </li>
          ))}
        </ul>
      );
  }
}

export function ManualBlocks({ blocks, manual, sizes }: Readonly<{ blocks: Block[]; manual: string; sizes: ImageSizes }>) {
  const ctx = { manual, sizes };
  return (
    <div className="flex flex-col gap-4">
      {keyedByContent(blocks).map(({ key, item: b }) => (
        <BlockView key={key} block={b} ctx={ctx} />
      ))}
    </div>
  );
}
