import { eq } from "drizzle-orm";
import sharp from "sharp";
import type { Tx } from "@/db/client";
import { files } from "@/db/schema";
import { getStorage, type Storage } from "@/lib/storage";
import type { Actor } from "../actor";
import { assertCan } from "../auth/policy";
import { ValidationError } from "../errors";
import { storeFile, type FileRow } from "../files/files";
import { getSettings, setLogoBySystem, updateSettings } from "./settings";

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
/** SVG logos are drawn to a PNG this wide (or tall), so invoices and screens get one safe raster image. */
const LOGO_PX = 512;
/** The largest image side accepted before decoding (PNG pixels, or the size an SVG is drawn at). */
const MAX_SIDE = 5000;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isPng = (b: Buffer) => b.length >= 8 && PNG_MAGIC.every((x, i) => b[i] === x);
const isJpeg = (b: Buffer) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isWebp = (b: Buffer) => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
const isSvg = (b: Buffer) => /<svg[\s>]/i.test(b.subarray(0, 4096).toString("utf8"));

type Kind = "PNG" | "JPG" | "WebP" | "SVG";
const kindOf = (b: Buffer): Kind | null => (isPng(b) ? "PNG" : isJpeg(b) ? "JPG" : isWebp(b) ? "WebP" : isSvg(b) ? "SVG" : null);

/** Only same-document references (#id) and inline raster images may stay in an SVG. */
const INSIDE = String.raw`(?!#|data:image\/(?:png|jpeg|gif|webp)[;,])`;
const SVG_REFUSED: RegExp[] = [
  /<script[\s>/]/i,
  /<foreignObject[\s>/]/i,
  /<!ENTITY/i,
  /\son[a-z]+\s*=/i,
  /@import/i,
  new RegExp(String.raw`(?:xlink:)?href\s*=\s*["']\s*${INSIDE}`, "i"),
  new RegExp(String.raw`url\(\s*["']?\s*${INSIDE}`, "i"),
];

/** Refuses an SVG that could run code or load anything from outside itself; sharp then draws it with no fetches. */
function assertSafeSvg(body: Buffer): void {
  const text = body.toString("utf8");
  if (SVG_REFUSED.some((r) => r.test(text))) throw new ValidationError("That SVG has a script or a link to an outside file. Save it without them, or upload a PNG.");
}

export type ProcessedLogo = { png: Buffer; width: number; height: number; /** Any pixel not fully opaque, before trimming. */ transparent: boolean };

/** Whether any pixel of the image is not fully opaque. */
async function hasTransparency(image: Buffer): Promise<boolean> {
  return !(await sharp(image).ensureAlpha().stats()).isOpaque;
}

/**
 * Sets the agency logo shown on invoices and screens. Every upload (PNG, SVG, JPG or WebP) is redrawn as a PNG
 * with its margins trimmed, and its size and whether it has transparency are kept in settings, so layouts pick the
 * square or the wide slot, and the night plate, without opening the image. No script or external reference in an SVG ever reaches a browser or the PDF.
 */
export async function setAgencyLogo(
  actor: Actor,
  tx: Tx,
  input: { filename: string; body: Buffer },
  storage?: Storage,
): Promise<FileRow> {
  assertCan(actor, "settings.update.rules");
  if (input.body.length === 0) throw new ValidationError("The file is empty.");
  if (input.body.length > MAX_LOGO_BYTES) throw new ValidationError("The logo can be at most 2 MB.");
  const logo = await processLogo(input.body);
  const base = input.filename.replace(/\.[^.]*$/, "").trim() || "logo";
  const row = await storeFile(actor, tx, { kind: "attachment", filename: `${base}.png`, contentType: "image/png", body: logo.png }, { only: "png" }, storage);
  await updateSettings(actor, tx, { agency: { logoFileId: row.id, logoWidth: logo.width, logoHeight: logo.height, logoTransparent: logo.transparent } });
  return row;
}

/** The logo as a fresh PNG, at most 512 px a side. */
export async function logoPng(body: Buffer): Promise<Buffer> {
  return (await processLogo(body)).png;
}

/**
 * Decodes and redraws the upload as a fresh PNG: turned upright, uniform margins (transparent or a solid color)
 * trimmed, and fitted inside 512 px with its ratio kept. Transparency is read from the drawn image before
 * trimming, so a JPG or a PNG on an opaque background is not transparent. A corrupt or oversized file is refused
 * here instead of breaking invoice PDFs, and metadata is dropped.
 */
export async function processLogo(body: Buffer): Promise<ProcessedLogo> {
  const kind = kindOf(body);
  if (!kind) throw new ValidationError("Upload a PNG, SVG, JPG or WebP file.");
  if (kind === "SVG") assertSafeSvg(body);
  const tooBig = `That ${kind} is too large. Use one at most ${MAX_SIDE.toLocaleString("en-US")} pixels a side.`;
  const unreadable = `That ${kind} file could not be read.`;
  const failure = (e: unknown) => new ValidationError(/pixel limit/i.test(String(e)) ? tooBig : unreadable);
  let density: number | undefined;
  try {
    // Reading metadata decodes nothing, so an SVG with a large declared size is fine here.
    const meta = await sharp(body, { limitInputPixels: kind === "SVG" ? false : MAX_SIDE * MAX_SIDE }).metadata();
    const side = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (!side) throw new ValidationError(unreadable);
    if (kind !== "SVG" && side > MAX_SIDE) throw new ValidationError(tooBig);
    // An SVG is drawn at twice the final size, so trimming its margins still leaves enough pixels.
    if (kind === "SVG") density = Math.min(2400, Math.max(1, (72 * 2 * LOGO_PX) / side));
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw failure(e);
  }
  let drawn: Buffer;
  try {
    drawn = await sharp(body, { limitInputPixels: MAX_SIDE * MAX_SIDE, ...(density ? { density } : {}) })
      .rotate()
      .ensureAlpha()
      .png()
      .toBuffer();
  } catch (e) {
    throw failure(e);
  }
  const transparent = await hasTransparency(drawn).catch(() => false);
  // A logo that is all one color has nothing to trim to; it is kept as drawn.
  const trimmed = await sharp(drawn)
    .trim({ threshold: 12 })
    .png()
    .toBuffer()
    .catch(() => drawn);
  try {
    const { data, info } = await sharp(trimmed)
      .resize(LOGO_PX, LOGO_PX, { fit: "inside", withoutEnlargement: kind !== "SVG" })
      .png()
      .toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height, transparent };
  } catch (e) {
    throw failure(e);
  }
}

export async function removeAgencyLogo(actor: Actor, tx: Tx): Promise<void> {
  assertCan(actor, "settings.update.rules");
  await updateSettings(actor, tx, { agency: { logoFileId: null, logoWidth: null, logoHeight: null, logoTransparent: null } });
}

export type AgencyLogoInfo = { fileId: string; width: number; height: number; transparent: boolean };

async function logoFile(tx: Tx, id: string) {
  const [file] = await tx.select().from(files).where(eq(files.id, id));
  if (!file || file.encrypted || file.kind === "w9" || file.contentType !== "image/png") return null;
  return file;
}

/**
 * The logo's file, size and transparency for layouts, or null when none is set. A logo saved before sizes were
 * kept is processed once here (trimmed, fitted, measured), stored as a new file and recorded in settings; one saved
 * with its size but before transparency was kept is only measured, keeping its file. Later calls read settings
 * without opening the image.
 */
export async function agencyLogoInfo(tx: Tx, storage?: Storage): Promise<AgencyLogoInfo | null> {
  const { agency } = await getSettings(tx);
  if (!agency.logoFileId) return null;
  const sized = agency.logoWidth && agency.logoHeight ? { width: agency.logoWidth, height: agency.logoHeight } : null;
  if (sized && agency.logoTransparent !== null) return { fileId: agency.logoFileId, ...sized, transparent: agency.logoTransparent };
  const file = await logoFile(tx, agency.logoFileId);
  if (!file) return null;
  const store = storage ?? getStorage();
  if (sized) {
    // The stored file is already a processed PNG: transparency is all that is missing.
    const transparent = await store
      .get(file.storageKey)
      .then(hasTransparency)
      .catch(() => null);
    if (transparent === null) return { fileId: file.id, ...sized, transparent: false };
    await setLogoBySystem(tx, { logoFileId: file.id, logoWidth: sized.width, logoHeight: sized.height, logoTransparent: transparent });
    return { fileId: file.id, ...sized, transparent };
  }
  let logo: ProcessedLogo;
  try {
    logo = await processLogo(await store.get(file.storageKey));
  } catch {
    return null;
  }
  const row = await storeFile("system", tx, { kind: "attachment", filename: file.filename, contentType: "image/png", body: logo.png }, { only: "png" }, store);
  await setLogoBySystem(tx, { logoFileId: row.id, logoWidth: logo.width, logoHeight: logo.height, logoTransparent: logo.transparent });
  return { fileId: row.id, width: logo.width, height: logo.height, transparent: logo.transparent };
}

/** The configured logo file and nothing else, or null when none is set. */
export async function readAgencyLogo(tx: Tx, storage?: Storage): Promise<{ id: string; body: Buffer; contentType: string; width: number; height: number } | null> {
  const info = await agencyLogoInfo(tx, storage);
  if (!info) return null;
  const file = await logoFile(tx, info.fileId);
  if (!file) return null;
  return { id: file.id, body: await (storage ?? getStorage()).get(file.storageKey), contentType: file.contentType, width: info.width, height: info.height };
}
