import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Role } from "@/domain/actor";
import { parseMarkdown, type Block } from "./markdown";
import { byText } from "@/lib/sort";

/**
 * The user manuals: Markdown chapters in docs/manuals/<manual>/NN-slug.md with screenshots in
 * docs/manuals/images/<manual>/. Each role reads only its own manual; coordinators and admins also read the deputy and
 * vendor manuals, since they hold those powers and help those people. Read-only, so nothing here is audited.
 */
export const MANUALS = [
  { id: "deputy", title: "Deputy manual", summary: "Finding, signing up for, working and billing details." },
  { id: "coordinator-admin", title: "Coordinator and admin manual", summary: "Posting details, vendors, invoices, reports and settings." },
  { id: "vendor", title: "Vendor manual", summary: "Requesting details, changes and cancellations, and invoices." },
] as const;

export type ManualId = (typeof MANUALS)[number]["id"];

const ACCESS: Record<Role, ManualId[]> = {
  personnel: ["deputy"],
  coordinator: ["deputy", "coordinator-admin", "vendor"],
  admin: ["deputy", "coordinator-admin", "vendor"],
  vendor: ["vendor"],
};

export function manualsFor(role: Role): ManualId[] {
  return ACCESS[role];
}

export function canReadManual(role: Role, id: string): id is ManualId {
  return (ACCESS[role] as string[]).includes(id);
}

/** docs/manuals under the app's folder (the image copies it there; see the Dockerfile). */
export function manualsRoot(): string {
  return process.env.MANUALS_DIR ?? join(process.cwd(), "docs", "manuals");
}

const CHAPTER_FILE = /^\d{2}-[a-z0-9-]+\.md$/;

/** The chapter files of a manual, in order. */
export function chapterFiles(root: string, id: ManualId): string[] {
  const dir = join(root, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => CHAPTER_FILE.test(f))
    .sort(byText);
}

/** "03-profile-and-w9.md" is at /help/<manual>/profile-and-w9. */
export function chapterSlug(file: string): string {
  return file.replace(/^\d+-/, "").replace(/\.md$/, "");
}

/** An image file name inside one manual's image folder: no path parts, only the formats the capture writes. */
export function safeImageName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.(webp|png)$/.test(name);
}

export type Chapter = { number: number; slug: string; file: string; title: string; blocks: Block[] };

export async function loadChapters(id: ManualId, root: string = manualsRoot()): Promise<Chapter[]> {
  return Promise.all(
    chapterFiles(root, id).map(async (file) => {
      const blocks = parseMarkdown(await readFile(join(root, id, file), "utf8"));
      const first = blocks[0];
      return { number: Number(file.slice(0, 2)), slug: chapterSlug(file), file, title: first?.type === "heading" ? first.text : chapterSlug(file), blocks };
    }),
  );
}

/** An image of a manual the role may read, or null (unknown, not allowed, or not a plain image name). */
export async function readManualImage(role: Role, manual: string, name: string, root: string = manualsRoot()): Promise<Buffer | null> {
  if (!canReadManual(role, manual) || !safeImageName(name)) return null;
  const path = join(root, "images", manual, name);
  return existsSync(path) ? readFile(path) : null;
}

/**
 * The URL of a chapter's image in the app. Chapters name images relative to themselves ("../images/deputy/x.webp");
 * the app serves them at /help-images/deputy/x.webp. Null for anything else.
 */
export function helpImageUrl(src: string): string | null {
  const m = /^\.\.\/images\/([a-z-]+)\/([^/]+)$/.exec(src);
  return m && safeImageName(m[2]) ? `/help-images/${m[1]}/${m[2]}` : null;
}

/** The desktop shot that may stand beside a phone shot ("x-1-phone.webp" and "x-1-desktop.webp"). */
export function desktopVariant(src: string): string | null {
  return /-phone\.webp$/.test(src) ? src.replace(/-phone\.webp$/, "-desktop.webp") : null;
}

export type ShotRecord = { file: string; source: "staging" | "training"; role: string; path: string; size: "phone" | "desktop"; width: number; height: number };
export type ShotManifest = { capturedAt: string; source: "staging" | "training"; shots: ShotRecord[] };

/** Pixel sizes of the captured screenshots, by "manual/file", from images/manifest.json (empty when there is none). */
export async function loadImageSizes(root: string = manualsRoot()): Promise<Record<string, { width: number; height: number }>> {
  const path = join(root, "images", "manifest.json");
  if (!existsSync(path)) return {};
  const manifest = JSON.parse(await readFile(path, "utf8")) as ShotManifest;
  return Object.fromEntries(manifest.shots.map((s) => [s.file, { width: s.width, height: s.height }]));
}
