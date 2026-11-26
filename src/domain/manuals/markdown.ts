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

/** For each position, the first index at or after it where `hit` holds (text.length when none does). */
function nextWhere(text: string, hit: (i: number) => boolean): (from: number) => number {
  const next = new Int32Array(text.length + 1).fill(text.length);
  for (let i = text.length - 1; i >= 0; i--) next[i] = hit(i) ? i : next[i + 1];
  return (from) => (from >= text.length ? text.length : next[from]);
}

type Finders = { n: number; stars: (from: number) => number; tick: (from: number) => number; bracket: (from: number) => number; paren: (from: number) => number; space: (from: number) => number; lineEnd: (from: number) => number };
type Hit = { end: number; item: Inline } | null;

/** `**bold**` at `i`, closed on the same line. */
function strongAt(text: string, i: number, f: Finders): Hit {
  const close = f.stars(i + 3);
  if (close < f.n && f.lineEnd(i + 2) >= close) return { end: close + 2, item: { t: "strong", v: text.slice(i + 2, close) } };
  return null;
}

/** `` `code` `` at `i`, not empty. */
function codeAt(text: string, i: number, f: Finders): Hit {
  const close = f.tick(i + 1);
  if (close < f.n && close > i + 1) return { end: close + 1, item: { t: "code", v: text.slice(i + 1, close) } };
  return null;
}

/** `[label](href)` at `i`, with a non-empty label and an href with no spaces. */
function linkAt(text: string, i: number, f: Finders): Hit {
  const close = f.bracket(i + 1);
  if (!(close < f.n && close > i + 1 && text[close + 1] === "(")) return null;
  const end = f.paren(close + 2);
  if (end < f.n && end > close + 2 && f.space(close + 2) >= end) return { end: end + 1, item: { t: "link", v: text.slice(i + 1, close), href: text.slice(close + 2, end) } };
  return null;
}

function inlineAt(text: string, i: number, f: Finders): Hit {
  if (text[i] === "*" && text[i + 1] === "*") return strongAt(text, i, f);
  if (text[i] === "`") return codeAt(text, i, f);
  if (text[i] === "[") return linkAt(text, i, f);
  return null;
}

/**
 * Inline **bold** (on one line), `code` and [label](href with no spaces), read left to right with the first match
 * winning. A single scan with lookup tables instead of one regex, so a long line with unclosed marks stays fast.
 */
export function parseInline(text: string): Inline[] {
  const n = text.length;
  const f: Finders = {
    n,
    stars: nextWhere(text, (i) => text[i] === "*" && text[i + 1] === "*"),
    tick: nextWhere(text, (i) => text[i] === "`"),
    bracket: nextWhere(text, (i) => text[i] === "]"),
    paren: nextWhere(text, (i) => text[i] === ")"),
    space: nextWhere(text, (i) => /\s/.test(text[i])),
    lineEnd: nextWhere(text, (i) => /[\n\r\u2028\u2029]/.test(text[i])),
  };

  const out: Inline[] = [];
  let last = 0;
  let i = 0;
  while (i < n) {
    const hit = inlineAt(text, i, f);
    if (hit) {
      if (i > last) out.push({ t: "text", v: text.slice(last, i) });
      out.push(hit.item);
      last = hit.end;
      i = hit.end;
    } else i++;
  }
  if (last < n) out.push({ t: "text", v: text.slice(last) });
  return out;
}

const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
// One whitespace character, not \s+: the rest of the line is trimmed later, and \s+ before .+ can backtrack.
const HEADING = /^(#{1,3})\s(.+)$/;
const ITEM = /^(\d+\.|-)\s(.*)$/;

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

type Read = { block: Block; next: number };

/** A `>` note: every consecutive `>` line from `i`. */
function readNote(lines: string[], i: number): Read {
  const text: string[] = [];
  while (i < lines.length && lines[i].startsWith(">")) text.push(lines[i++].replace(/^>\s?/, ""));
  return { block: { type: "note", inline: parseInline(text.join(" ").trim()) }, next: i };
}

/** Where the list goes on after the blank line at `i`, or null when the blank line ends it. */
function listResumes(lines: string[], i: number, ordered: boolean): number | null {
  // A blank line continues the list only when an indented line or another item follows.
  let j = i;
  while (j < lines.length && !lines[j].trim()) j++;
  const next = lines[j] ?? "";
  const nextItem = ITEM.exec(next);
  return /^\s+\S/.test(next) || (nextItem && (nextItem[1] !== "-") === ordered) ? j : null;
}

/** A list from its first item at `i`: items of the same kind, their indented lines and the blank lines between. */
function readList(lines: string[], i: number, ordered: boolean): Read {
  const items: string[][] = [];
  while (i < lines.length) {
    const l = lines[i];
    const m = ITEM.exec(l);
    if (m && (m[1] !== "-") === ordered) {
      items.push([m[2]]);
      i++;
    } else if (/^\s+\S/.test(l)) {
      items.at(-1)!.push(l);
      i++;
    } else if (l.trim()) break;
    else {
      const resume = listResumes(lines, i, ordered);
      if (resume === null) break;
      items.at(-1)!.push("");
      i = resume;
    }
  }
  return { block: { type: "list", ordered, items: items.map(parseFlat) }, next: i };
}

/** A paragraph: lines from `i` up to a blank line or the start of another block. */
function readParagraph(lines: string[], i: number): Read {
  const para: string[] = [];
  while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !ITEM.test(lines[i]) && !lines[i].startsWith(">") && !IMAGE.test(lines[i].trim())) {
    para.push(lines[i++].trim());
  }
  return { block: { type: "paragraph", inline: parseInline(para.join(" ")) }, next: i };
}

/** The block starting at the non-blank line `i`. */
function readBlock(lines: string[], i: number): Read {
  const line = lines[i];
  const heading = HEADING.exec(line);
  if (heading) return { block: { type: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2].trim() }, next: i + 1 };
  // An indented image here is not in a list (a list reads its own indented lines), so it is an image too.
  const img = IMAGE.exec(line.trim());
  if (img) return { block: { type: "image", alt: img[1], src: img[2] }, next: i + 1 };
  if (line.startsWith(">")) return readNote(lines, i);
  const item = ITEM.exec(line);
  if (item) return readList(lines, i, item[1] !== "-");
  return readParagraph(lines, i);
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim()) {
      const { block, next } = readBlock(lines, i);
      blocks.push(block);
      i = next;
    } else i++;
  }
  return blocks;
}

/** Every image `src`, in order, including those inside list items. */
export function imageRefs(blocks: Block[]): string[] {
  return blocks.flatMap(blockImages);
}

function blockImages(b: Block): string[] {
  if (b.type === "image") return [b.src];
  if (b.type === "list") return b.items.flatMap(imageRefs);
  return [];
}
