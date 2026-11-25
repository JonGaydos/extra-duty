import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import { TrainingMark } from "./training-mark";
import { AgencyHeader, formatMoney, type AgencyHeaderData } from "./invoice-pdf";

export type PdfColumn = { label: string; /** Relative width; defaults to 1. */ weight?: number; right?: boolean };

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 9, padding: 40, paddingBottom: 56, color: "#111111" },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold" },
  sub: { color: "#444444", marginTop: 3, marginBottom: 12 },
  heading: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 14, marginBottom: 4 },
  head: { flexDirection: "row", backgroundColor: "#eeeeee", paddingVertical: 4, paddingHorizontal: 3, borderBottomWidth: 0.75, borderBottomColor: "#888888" },
  row: { flexDirection: "row", paddingVertical: 3, paddingHorizontal: 3, borderBottomWidth: 0.5, borderBottomColor: "#cccccc" },
  bold: { fontFamily: "Helvetica-Bold" },
  right: { textAlign: "right" },
  note: { marginTop: 12, color: "#444444" },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, flexDirection: "row", justifyContent: "space-between", color: "#666666", fontSize: 8 },
});

/** Rows never split across pages, and the header row repeats on each page. */
function Table({ columns, rows }: { columns: PdfColumn[]; rows: string[][] }) {
  const cell = (c: PdfColumn) => ({ flex: c.weight ?? 1, paddingRight: 4 });
  return (
    <View>
      <View style={s.head} fixed>
        {columns.map((c, i) => (
          <Text key={i} style={[cell(c), s.bold, c.right ? s.right : {}]}>
            {c.label}
          </Text>
        ))}
      </View>
      {rows.map((r, ri) => (
        <View key={ri} style={s.row} wrap={false}>
          {columns.map((c, i) => (
            <Text key={i} style={[cell(c), c.right ? s.right : {}]}>
              {r[i] ?? ""}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function PageFooter({ label }: { label: string }) {
  return (
    <View style={s.footer} fixed>
      <Text>{label}</Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

export type ReportPdfData = {
  agency: AgencyHeaderData;
  name: string;
  /** For example "2026-01-01 to 2027-12-31". */
  period: string;
  columns: PdfColumn[];
  rows: string[][];
  /** A final totals row, when the report has one. */
  totals: string[] | null;
};

export async function renderReportPdf(d: ReportPdfData): Promise<Buffer> {
  return renderToBuffer(
    <Document title={d.name}>
      <Page size="LETTER" orientation="landscape" style={s.page}>
        <TrainingMark />
        <AgencyHeader agency={d.agency} />
        <Text style={s.title}>{d.name}</Text>
        <Text style={s.sub}>{`Period: ${d.period}`}</Text>
        <Table columns={d.columns} rows={d.totals ? [...d.rows, d.totals] : d.rows} />
        {d.rows.length === 0 ? <Text style={s.note}>No records in this period.</Text> : null}
        <PageFooter label={d.name} />
      </Page>
    </Document>,
  );
}

export type TaxPdfData = {
  agency: AgencyHeaderData;
  year: number;
  payee: { name: string; mailingAddress: string };
  byVendor: Array<{ vendorId: string; vendorName: string; paidCents: number; details: number }>;
  totalPaidCents: number;
  unpaidBilledCents: number;
  rows: string[][];
};

const TAX_COLUMNS: PdfColumn[] = [
  { label: "Invoice", weight: 1.1 },
  { label: "Job", weight: 2.2 },
  { label: "Vendor", weight: 2 },
  { label: "Job date", weight: 1.2 },
  { label: "Total", weight: 1.1, right: true },
  { label: "Date counted", weight: 1.2 },
  { label: "Vendor reported", weight: 1.2 },
  { label: "Notes", weight: 1.6 },
];

export async function renderTaxSummaryPdf(d: TaxPdfData): Promise<Buffer> {
  const title = `Payment summary for ${d.year}`;
  return renderToBuffer(
    <Document title={title}>
      <Page size="LETTER" orientation="landscape" style={s.page}>
        <TrainingMark />
        <AgencyHeader agency={d.agency} />
        <Text style={s.title}>{title}</Text>
        <Text style={s.sub}>{`Prepared for ${d.payee.name}. Counted in the year payment was received (cash basis).`}</Text>
        {d.payee.mailingAddress.split("\n").filter((l) => l.trim()).map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}

        <Text style={s.heading}>Paid in {d.year}, by vendor</Text>
        <Table
          columns={[{ label: "Vendor", weight: 4 }, { label: "Details", weight: 1, right: true }, { label: "Paid", weight: 1.5, right: true }]}
          rows={[...d.byVendor.map((v) => [v.vendorName, String(v.details), formatMoney(v.paidCents)]), ["Total paid", "", formatMoney(d.totalPaidCents)]]}
        />
        <Text style={s.note}>{`Billed but not yet paid at the end of ${d.year}: ${formatMoney(d.unpaidBilledCents)} (not included in the total above).`}</Text>

        <Text style={s.heading}>Every invoice</Text>
        <Table columns={TAX_COLUMNS} rows={d.rows} />
        <Text style={s.note}>This summary is not tax advice.</Text>
        <Text>
          It lists payments recorded in the app. A flag in Notes means the vendor reported payment in a different calendar year than you did; compare it with the vendor&apos;s 1099.
        </Text>
        <PageFooter label={title} />
      </Page>
    </Document>,
  );
}
