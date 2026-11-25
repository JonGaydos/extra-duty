/**
 * The small Markdown subset the user manuals use (docs/manuals): `#` to `###` headings, paragraphs, numbered and
 * bulleted lists whose items may hold indented paragraphs and images, images on their own line, `>` notes, and inline
 * **bold**, `code` and [links](href). One parser feeds both the in-app Help pages and the PDF build, so they always
 * show the same text.
 */
export type Inline = { t: "text"; v: string } | { t: "strong"; v: string } | { t: "code"; v: string } | { t: "link"; v: string; href: string };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; inline: Inline[] }
  | { type: "list"; ordered: boolean; items: Block[][] }
  | { type: "image"; alt: string; src: string }
  | { type: "note"; inline: Inline[] };

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "strong", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "code", v: m[2] });
    else out.push({ t: "link", v: m[3], href: m[4] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const HEADING = /^(#{1,3})\s+(.+)$/;
const ITEM = /^(\d+\.|-)\s+(.*)$/;

/** Paragraph-level blocks from lines that hold no list (list item bodies, after their indent is removed). */
function parseFlat(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "paragraph", inline: parseInline(para.join(" ")) });
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    const img = IMAGE.exec(line);
    if (!line) flush();
    else if (img) {
      flush();
      blocks.push({ type: "image", alt: img[1], src: img[2] });
    } else para.push(line);
  }
  flush();
  return blocks;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2].trim() });
      i++;
      continue;
    }
    const img = IMAGE.exec(trimmed);
    if (img && !/^\s/.test(line)) {
      blocks.push({ type: "image", alt: img[1], src: img[2] });
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const text: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) text.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ type: "note", inline: parseInline(text.join(" ").trim()) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = item[1] !== "-";
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = ITEM.exec(l);
        if (m && (m[1] !== "-") === ordered) {
          items.push([m[2]]);
          i++;
        } else if (/^\s+\S/.test(l)) {
          items[items.length - 1].push(l);
          i++;
        } else if (!l.trim()) {
          // A blank line continues the list only when an indented line or another item follows.
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          const next = lines[j] ?? "";
          const nextItem = ITEM.exec(next);
          if (/^\s+\S/.test(next) || (nextItem && (nextItem[1] !== "-") === ordered)) {
            items[items.length - 1].push("");
            i = j;
          } else break;
        } else break;
      }
      blocks.push({ type: "list", ordered, items: items.map(parseFlat) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !ITEM.test(lines[i]) && !lines[i].startsWith(">") && !IMAGE.test(lines[i].trim())) {
      para.push(lines[i++].trim());
    }
    blocks.push({ type: "paragraph", inline: parseInline(para.join(" ")) });
  }
  return blocks;
}

/** Every image `src`, in order, including those inside list items. */
export function imageRefs(blocks: Block[]): string[] {
  return blocks.flatMap((b) => (b.type === "image" ? [b.src] : b.type === "list" ? b.items.flatMap(imageRefs) : []));
}

/** Plain text of inline content. */
export function inlineText(inline: Inline[]): string {
  return inline.map((p) => p.v).join("");
}
