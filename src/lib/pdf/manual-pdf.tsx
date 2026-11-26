import { Document, Image, Link, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { Block, Inline } from "@/domain/manuals/markdown";
import { AgencyHeader, type AgencyHeaderData } from "./invoice-pdf";
import { keyedByContent } from "@/lib/list-keys";

/** A screenshot ready for the PDF: JPEG bytes and its pixel size, and whether it is a phone shot. */
export type PdfImage = { data: Buffer; width: number; height: number; phone: boolean };

export type ManualPdfData = {
  agency: AgencyHeaderData;
  title: string;
  summary: string;
  /** "November 25, 2026". */
  dated: string;
  chapters: Array<{ number: number; title: string; blocks: Block[] }>;
  /** Images by the `src` the chapters use. Missing ones are left out. */
  images: Map<string, PdfImage>;
};

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 10.5, lineHeight: 1.45, padding: 48, paddingBottom: 60, color: "#14181f" },
  coverTitle: { fontSize: 26, fontFamily: "Helvetica-Bold", marginTop: 60 },
  coverSub: { fontSize: 12, color: "#5b6472", marginTop: 8 },
  contentsHead: { fontSize: 13, fontFamily: "Helvetica-Bold", marginTop: 36, marginBottom: 8 },
  contentsRow: { flexDirection: "row", paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: "#e3e6eb" },
  contentsNum: { width: 26, color: "#5b6472" },
  chapterNum: { fontSize: 9.5, color: "#5b6472", marginBottom: 2 },
  h1: { fontSize: 19, fontFamily: "Helvetica-Bold", marginBottom: 10 },
  h2: { fontSize: 13, fontFamily: "Helvetica-Bold", marginTop: 12, marginBottom: 4 },
  h3: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 8, marginBottom: 2 },
  p: { marginBottom: 6 },
  bold: { fontFamily: "Helvetica-Bold" },
  key: { fontFamily: "Helvetica-Bold" },
  note: { backgroundColor: "#e8eefc", color: "#16328c", padding: 8, borderRadius: 4, marginVertical: 6 },
  step: { flexDirection: "row", marginBottom: 10 },
  stepNum: { width: 22, fontFamily: "Helvetica-Bold" },
  stepBody: { flex: 1 },
  bullet: { flexDirection: "row", marginBottom: 3 },
  bulletMark: { width: 12 },
  shot: { borderWidth: 0.75, borderColor: "#c9ced6", borderRadius: 4, marginTop: 4, marginBottom: 8, objectFit: "contain" },
  footer: { position: "absolute", bottom: 26, left: 48, right: 48, flexDirection: "row", justifyContent: "space-between", color: "#5b6472", fontSize: 8.5 },
});

/** Letter page width less the margins, in points. */
const COLUMN = 612 - 96;

function inlineNode(key: string, p: Inline) {
  if (p.t === "strong") {
    return (
      <Text key={key} style={s.bold}>
        {p.v}
      </Text>
    );
  }
  if (p.t === "code") {
    return (
      <Text key={key} style={s.key}>
        {p.v}
      </Text>
    );
  }
  if (p.t === "link" && /^https?:/.test(p.href)) {
    return (
      <Link key={key} src={p.href}>
        {p.v}
      </Link>
    );
  }
  return <Text key={key}>{p.v}</Text>;
}

function Inlines({ inline }: Readonly<{ inline: Inline[] }>) {
  return <>{keyedByContent(inline).map(({ key, item: p }) => inlineNode(key, p))}</>;
}

function Shot({ img, indent }: Readonly<{ img: PdfImage; indent: number }>) {
  // Phone shots are shown at about phone size; desktop shots use the column.
  const max = img.phone ? 190 : COLUMN - indent;
  // Never taller than the page's usable height (Letter less margins), so a tall picture shrinks instead of failing.
  const width = Math.min(max, img.width, (600 * img.width) / img.height);
  const height = (img.height / img.width) * width;
  // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image is a PDF primitive, not an HTML img.
  return <Image src={{ data: img.data, format: "jpg" }} style={[s.shot, { width, height }]} />;
}

function Blocks({ blocks, images, indent = 0 }: Readonly<{ blocks: Block[]; images: Map<string, PdfImage>; indent?: number }>) {
  return (
    <>
      {keyedByContent(blocks).map(({ key, item: b }) => {
        switch (b.type) {
          case "heading":
            return b.level === 1 ? null : (
              <Text key={key} style={b.level === 2 ? s.h2 : s.h3} minPresenceAhead={40}>
                {b.text}
              </Text>
            );
          case "paragraph":
            return (
              <Text key={key} style={s.p}>
                <Inlines inline={b.inline} />
              </Text>
            );
          case "note":
            return (
              <View key={key} style={s.note} wrap={false}>
                <Text>
                  <Inlines inline={b.inline} />
                </Text>
              </View>
            );
          case "image": {
            const img = images.get(b.src);
            return img ? <Shot key={key} img={img} indent={indent} /> : null;
          }
          case "list":
            return (
              <View key={key} style={{ marginBottom: 4 }}>
                {keyedByContent(b.items).map(({ key: inner, item, index: j }) => (
                  <View key={inner} style={b.ordered ? s.step : s.bullet}>
                    <Text style={b.ordered ? s.stepNum : s.bulletMark}>{b.ordered ? `${j + 1}.` : "-"}</Text>
                    <View style={s.stepBody}>
                      <Blocks blocks={item} images={images} indent={indent + 22} />
                    </View>
                  </View>
                ))}
              </View>
            );
        }
      })}
    </>
  );
}

function Footer({ title }: Readonly<{ title: string }>) {
  return (
    <View style={s.footer} fixed>
      <Text>{title}</Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

/** One manual as a PDF: a cover with the agency header and the contents, then one chapter per page onward. */
export async function renderManualPdf(d: ManualPdfData): Promise<Buffer> {
  return renderToBuffer(
    <Document title={d.title} author={d.agency.name}>
      <Page size="LETTER" style={s.page}>
        <AgencyHeader agency={d.agency} />
        <Text style={s.coverTitle}>{d.title}</Text>
        <Text style={s.coverSub}>{`Extra Duty. ${d.summary}`}</Text>
        <Text style={s.coverSub}>{`Updated ${d.dated}`}</Text>
        <Text style={s.contentsHead}>Contents</Text>
        {d.chapters.map((c) => (
          <View key={c.number} style={s.contentsRow}>
            <Text style={s.contentsNum}>{String(c.number)}</Text>
            <Text>{c.title}</Text>
          </View>
        ))}
        <Footer title={`${d.agency.name}. ${d.title}`} />
      </Page>
      {d.chapters.map((c) => (
        <Page key={c.number} size="LETTER" style={s.page}>
          <Text style={s.chapterNum}>{`Chapter ${c.number}`}</Text>
          <Text style={s.h1}>{c.title}</Text>
          <Blocks blocks={c.blocks} images={d.images} />
          <Footer title={`${d.agency.name}. ${d.title}`} />
        </Page>
      ))}
    </Document>,
  );
}
