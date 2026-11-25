import { Document, Image, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import { TrainingMark } from "./training-mark";
import { AGENCY_TZ } from "@/domain/time/agency-time";
import { containSize, logoSlot } from "@/lib/logo-fit";

export type InvoicePdfData = {
  /** Display number, for example ED-000001. */
  number: string;
  revision: number;
  kind: "detail" | "late_cancel";
  issuedAt: Date;
  vendor: { name: string; billingEmails: string[] };
  job: { number: number; title: string; location: string; startAt: Date; endAt: Date };
  payee: { name: string; mailingAddress: string; email: string };
  agency: {
    name: string;
    sheriffName: string;
    address: string;
    phone: string;
    website: string;
    /** width and height: the logo's size in pixels, for the square or wide header slot. */
    logo: { bytes: Buffer; mimeType: string; width?: number | null; height?: number | null } | null;
  };
  /** Actual minutes before rounding and the minimum. */
  workedMinutes: number;
  /** Billed minutes. */
  minutes: number;
  /** The resolved minimum (job, vendor, then agency), in minutes. */
  minimumMinutes: number;
  rateCents: number;
  totalCents: number;
  paid: { method: string; reference: string; paidAt: Date } | null;
  replyTo: string;
};

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

const dateFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: AGENCY_TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, hour: "numeric", minute: "2-digit" });
const clean = (s: string) => s.replace(/[  ]/g, " ");

export function formatDate(at: Date): string {
  return clean(dateFmt.format(at));
}

export function formatDateTime(at: Date): string {
  return `${formatDate(at)}, ${clean(timeFmt.format(at))}`;
}

/** "Fri, Dec 4, 2026, 5:30 PM to 9:30 PM"; both full stamps when the job crosses days. */
export function formatSpan(startAt: Date, endAt: Date): string {
  if (formatDate(startAt) === formatDate(endAt)) {
    return `${formatDateTime(startAt)} to ${clean(timeFmt.format(endAt))}`;
  }
  return `${formatDateTime(startAt)} to ${formatDateTime(endAt)}`;
}

/** Hours with up to two decimals: 4, 3.5, 4.25. */
export function formatHours(minutes: number): string {
  return String(Math.round((minutes / 60) * 100) / 100);
}

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 10, padding: 48, color: "#111111" },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 24 },
  logo: { marginRight: 14, objectFit: "contain" },
  agencyName: { fontSize: 15, fontFamily: "Helvetica-Bold" },
  muted: { color: "#444444", marginTop: 2 },
  titleRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 18 },
  title: { fontSize: 20, fontFamily: "Helvetica-Bold" },
  right: { textAlign: "right" },
  section: { marginBottom: 16 },
  label: { fontSize: 8, color: "#666666", textTransform: "uppercase", marginBottom: 3 },
  bold: { fontFamily: "Helvetica-Bold" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: "#cccccc" },
  total: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, fontSize: 13, fontFamily: "Helvetica-Bold" },
  paid: { marginTop: 12, padding: 8, borderWidth: 1.5, borderColor: "#1a7f37", color: "#1a7f37", fontFamily: "Helvetica-Bold", fontSize: 14 },
  footer: { marginTop: 24, paddingTop: 10, borderTopWidth: 0.5, borderTopColor: "#cccccc" },
});

function logoSource(logo: { bytes: Buffer; mimeType: string }) {
  const format = logo.mimeType === "image/png" ? "png" : "jpg";
  return { data: logo.bytes, format } as const;
}

export type AgencyHeaderData = InvoicePdfData["agency"];

/** The logo's drawn size: contained in the square slot, or the wide one for logos about 1.3:1 and wider. */
export function pdfLogoBox(logo: { width?: number | null; height?: number | null }): { width: number; height: number } {
  const slot = logoSlot("pdf", logo.width, logo.height);
  return logo.width && logo.height ? containSize(logo.width, logo.height, slot) : { width: slot.width, height: slot.height };
}

/** Logo, agency name and Sheriff. Shared by the invoice, the tax summary and the report PDFs. */
export function AgencyHeader({ agency }: { agency: AgencyHeaderData }) {
  return (
    <View style={s.header}>
      {/* react-pdf Image is a PDF primitive, not an HTML img. */}
      {/* eslint-disable-next-line jsx-a11y/alt-text */}
      {agency.logo ? <Image style={[s.logo, pdfLogoBox(agency.logo)]} src={logoSource(agency.logo)} /> : null}
      <View>
        <Text style={s.agencyName}>{agency.name}</Text>
        {agency.sheriffName ? <Text style={s.muted}>{`Sheriff ${agency.sheriffName}`}</Text> : null}
        {agency.address ? <Text style={s.muted}>{agency.address}</Text> : null}
        {agency.phone ? <Text style={s.muted}>{agency.phone}</Text> : null}
        {agency.website ? <Text style={s.muted}>{agency.website}</Text> : null}
      </View>
    </View>
  );
}

function InvoiceDocument({ d }: { d: InvoicePdfData }) {
  const lateCancel = d.kind === "late_cancel";
  const minimumApplied = !lateCancel && d.minutes > d.workedMinutes && d.minutes === d.minimumMinutes;
  const paidLine = d.paid
    ? [`PAID ${formatDate(d.paid.paidAt)}`, d.paid.method, d.paid.reference ? `reference ${d.paid.reference}` : ""].filter(Boolean).join(", ")
    : "";
  const questions = d.replyTo || "contact the agency";
  return (
    <Document title={`Invoice ${d.number}`}>
      <Page size="LETTER" style={s.page}>
        <TrainingMark />
        <AgencyHeader agency={d.agency} />

        <View style={s.titleRow}>
          <View>
            <Text style={s.title}>Invoice</Text>
            <Text style={s.muted}>{`Billed to ${d.vendor.name}`}</Text>
          </View>
          <View style={s.right}>
            <Text style={s.bold}>{d.number}</Text>
            {d.revision > 0 ? <Text>Revised</Text> : null}
            {d.revision > 0 ? <Text>{`Revision ${d.revision}`}</Text> : null}
            <Text style={s.muted}>{`Issued ${formatDate(d.issuedAt)}`}</Text>
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.label}>Pay to</Text>
          <Text style={s.bold}>{d.payee.name}</Text>
          {d.payee.mailingAddress.split("\n").filter((l) => l.trim()).map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          <Text>{d.payee.email}</Text>
        </View>

        <View style={s.section}>
          <Text style={s.label}>Job</Text>
          <Text style={s.bold}>{`#${d.job.number} ${d.job.title}`}</Text>
          {d.job.location ? <Text>{d.job.location}</Text> : null}
          <Text>{formatSpan(d.job.startAt, d.job.endAt)}</Text>
        </View>

        <View style={s.section}>
          {lateCancel ? (
            <Text style={s.bold}>Late cancellation by the vendor</Text>
          ) : (
            <View style={s.row}>
              <Text>Hours worked</Text>
              <Text>{formatHours(d.workedMinutes)}</Text>
            </View>
          )}
          <View style={s.row}>
            <Text>Hours billed</Text>
            <Text>{formatHours(d.minutes)}</Text>
          </View>
          {minimumApplied ? <Text style={s.muted}>{`${formatHours(d.minimumMinutes)}-hour minimum applied`}</Text> : null}
          <View style={s.row}>
            <Text>Rate</Text>
            <Text>{`${formatMoney(d.rateCents)}/hr`}</Text>
          </View>
          <View style={s.total}>
            <Text>{d.paid ? "Total" : "Total due"}</Text>
            <Text>{formatMoney(d.totalCents)}</Text>
          </View>
          {d.paid ? (
            <View style={s.row}>
              <Text>Amount due</Text>
              <Text>{formatMoney(0)}</Text>
            </View>
          ) : null}
        </View>

        {d.paid ? <Text style={s.paid}>{paidLine}</Text> : null}

        <View style={s.footer}>
          <Text>{`Make payment to the payee named above. Payment questions or disputes: ${questions}`}</Text>
        </View>
      </Page>
    </Document>
  );
}

/** Server only. Uses the built-in Helvetica, so it makes no network requests. */
export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return renderToBuffer(<InvoiceDocument d={data} />);
}
