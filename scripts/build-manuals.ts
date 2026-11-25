/**
 * Builds the three user manuals as PDFs from docs/manuals (the same Markdown the in-app Help pages render at /help):
 *
 *   npx tsx scripts/build-manuals.ts [--out docs/manuals/pdf]
 *
 * Each PDF opens with the agency header (name, Sheriff, contact lines and logo) from the agency settings when
 * DATABASE_URL is set, else the built-in defaults. Screenshots are embedded as JPEG. The PDFs are not committed
 * (docs/manuals/pdf is ignored); build them for printing or emailing. The script also fails on a chapter that names
 * a missing image, so a broken manual never ships.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import sharp from "sharp";
import { createDb } from "../src/db/client";
import { loadAgencyHeader } from "../src/domain/invoices/invoices";
import { imageRefs } from "../src/domain/manuals/markdown";
import { MANUALS, loadChapters, manualsRoot } from "../src/domain/manuals/manuals";
import { DEFAULT_SETTINGS } from "../src/domain/settings/defaults";
import type { AgencyHeaderData } from "../src/lib/pdf/invoice-pdf";
import { renderManualPdf, type PdfImage } from "../src/lib/pdf/manual-pdf";

// tsx compiles the PDF components with the classic JSX transform (the tsconfig keeps JSX for Next), which calls
// React.createElement at render time.
Object.assign(globalThis, { React });

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const OUT = outIndex >= 0 ? args[outIndex + 1] : join(manualsRoot(), "pdf");

async function agencyHeader(): Promise<AgencyHeaderData> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const db = createDb(url);
    try {
      return await db.transaction((tx) => loadAgencyHeader(tx));
    } finally {
      await db.$client.end();
    }
  }
  const a = DEFAULT_SETTINGS.agency;
  return { name: a.name, sheriffName: a.sheriffName, address: a.address, phone: a.phone, website: a.website, logo: null };
}

const dated = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
const isoDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

async function main(): Promise<void> {
  const root = manualsRoot();
  const agency = await agencyHeader();
  const now = new Date();
  mkdirSync(OUT, { recursive: true });
  for (const m of MANUALS) {
    const chapters = await loadChapters(m.id, root);
    const images = new Map<string, PdfImage>();
    for (const c of chapters) {
      for (const src of imageRefs(c.blocks)) {
        const path = join(root, m.id, src);
        if (!existsSync(path)) throw new Error(`${m.id}/${c.file} names a missing image: ${src}`);
        if (images.has(src)) continue;
        const { data, info } = await sharp(readFileSync(path)).flatten({ background: "#ffffff" }).jpeg({ quality: 72 }).toBuffer({ resolveWithObject: true });
        // Phone shots are taken at twice the pixels; their drawn size comes from the CSS width.
        const phone = src.endsWith("-phone.webp");
        images.set(src, { data, width: phone ? info.width / 2 : info.width, height: phone ? info.height / 2 : info.height, phone });
      }
    }
    const pdf = await renderManualPdf({ agency, title: m.title, summary: m.summary, dated: dated(now), chapters, images });
    const name = `Extra Duty Manual - ${m.title.replace(/ manual$/, "")} - ${isoDay(now)}.pdf`;
    writeFileSync(join(OUT, name), pdf);
    console.log(`${name}: ${chapters.length} chapters, ${images.size} pictures, ${(pdf.length / 1024 / 1024).toFixed(1)} MB`);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
