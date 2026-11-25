import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import { TrainingMark } from "./training-mark";
import { AgencyHeader, formatDate, formatMoney, type AgencyHeaderData } from "./invoice-pdf";

export type BatchCoverRow = {
  /** Display number, for example ED-000001. */
  number: string;
  jobNumber: number;
  jobTitle: string;
  jobStartAt: Date;
  payeeName: string;
  totalCents: number;
  /** Already paid: marked Paid and left out of the total due. */
  paid?: boolean;
};

export type BatchCoverData = {
  agency: AgencyHeaderData;
  vendorName: string;
  sentAt: Date;
  replyTo: string;
  rows: BatchCoverRow[];
};

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 9.5, padding: 48, color: "#111111" },
  titleRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 18 },
  title: { fontSize: 20, fontFamily: "Helvetica-Bold" },
  muted: { color: "#444444", marginTop: 2 },
  bold: { fontFamily: "Helvetica-Bold" },
  right: { textAlign: "right" },
  head: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: "#111111", fontFamily: "Helvetica-Bold", fontSize: 8, textTransform: "uppercase" },
  row: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: "#cccccc" },
  number: { width: "17%" },
  detail: { width: "33%", paddingRight: 6, maxLines: 2, textOverflow: "ellipsis" },
  date: { width: "18%" },
  payee: { width: "18%", paddingRight: 6, maxLines: 2, textOverflow: "ellipsis" },
  amount: { width: "14%", textAlign: "right" },
  total: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, fontSize: 13, fontFamily: "Helvetica-Bold" },
  footer: { marginTop: 24, paddingTop: 10, borderTopWidth: 0.5, borderTopColor: "#cccccc" },
});

/** Lines a row takes: the detail and payee columns wrap (capped at two lines each). */
function rowLines(r: BatchCoverRow): number {
  const detail = Math.ceil(`#${r.jobNumber} ${r.jobTitle}`.length / 30);
  const payee = Math.ceil(r.payeeName.length / 16);
  return Math.min(2, Math.max(1, detail, payee));
}

/** Line budgets per page: the first page also holds the letterhead and title. Kept conservative so nothing overflows. */
const FIRST_PAGE_LINES = 24;
const LATER_PAGE_LINES = 32;
/** Room the total and the footer need on the last page. */
const CLOSING_LINES = 5;

/** Splits the rows into pages so each page carries its own table header and the total closes the last page. */
export function paginateCoverRows(rows: BatchCoverRow[]): BatchCoverRow[][] {
  const pages: BatchCoverRow[][] = [[]];
  let left = FIRST_PAGE_LINES;
  for (const r of rows) {
    const cost = rowLines(r);
    if (cost > left && pages[pages.length - 1].length > 0) {
      pages.push([]);
      left = LATER_PAGE_LINES;
    }
    pages[pages.length - 1].push(r);
    left -= cost;
  }
  if (left < CLOSING_LINES) pages.push([]);
  return pages;
}

function TableHeader() {
  return (
    <View style={s.head}>
      <Text style={s.number}>Invoice</Text>
      <Text style={s.detail}>Detail</Text>
      <Text style={s.date}>Date</Text>
      <Text style={s.payee}>Payee</Text>
      <Text style={s.amount}>Amount</Text>
    </View>
  );
}

function CoverDocument({ d }: { d: BatchCoverData }) {
  const total = d.rows.reduce((sum, r) => sum + (r.paid ? 0 : r.totalCents), 0);
  const count = `${d.rows.length} ${d.rows.length === 1 ? "invoice" : "invoices"}`;
  const pages = paginateCoverRows(d.rows);
  return (
    <Document title={`Invoice summary for ${d.vendorName}`}>
      {pages.map((rows, i) => {
        const last = i === pages.length - 1;
        return (
          <Page key={i} size="LETTER" style={s.page} wrap={false}>
            <TrainingMark />
            {i === 0 ? (
              <>
                <AgencyHeader agency={d.agency} />
                <View style={s.titleRow}>
                  <View>
                    <Text style={s.title}>Invoice summary</Text>
                    <Text style={s.muted}>{`Billed to ${d.vendorName}`}</Text>
                  </View>
                  <View style={s.right}>
                    <Text>{count}</Text>
                    <Text style={s.muted}>{`Sent ${formatDate(d.sentAt)}`}</Text>
                    {pages.length > 1 ? <Text style={s.muted}>{`Page 1 of ${pages.length}`}</Text> : null}
                  </View>
                </View>
              </>
            ) : (
              <View style={s.titleRow}>
                <Text style={s.bold}>{`Invoice summary for ${d.vendorName}, continued`}</Text>
                <Text style={s.muted}>{`Page ${i + 1} of ${pages.length}`}</Text>
              </View>
            )}
            {rows.length ? <TableHeader /> : null}
            {rows.map((r) => (
              <View key={r.number} style={s.row}>
                <Text style={s.number}>{r.number}</Text>
                <Text style={s.detail}>{`#${r.jobNumber} ${r.jobTitle}`}</Text>
                <Text style={s.date}>{formatDate(r.jobStartAt)}</Text>
                <Text style={s.payee}>{r.payeeName}</Text>
                <Text style={s.amount}>{r.paid ? `Paid ${formatMoney(r.totalCents)}` : formatMoney(r.totalCents)}</Text>
              </View>
            ))}
            {last ? (
              <>
                <View style={s.total}>
                  <Text>Total due</Text>
                  <Text>{formatMoney(total)}</Text>
                </View>
                <View style={s.footer}>
                  <Text>{`Each invoice is attached and is paid to the payee named on it. Payment questions or disputes: ${d.replyTo || "contact the agency"}`}</Text>
                </View>
              </>
            ) : null}
          </Page>
        );
      })}
    </Document>
  );
}

/** Server only. The cover (one page for most batches) listing every invoice in a vendor batch, with the grand total. */
export async function renderBatchCoverPdf(data: BatchCoverData): Promise<Buffer> {
  return renderToBuffer(<CoverDocument d={data} />);
}
