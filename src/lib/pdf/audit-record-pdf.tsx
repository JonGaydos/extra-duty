/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import { keyedByContent } from "@/lib/list-keys";
import { TrainingMark } from "./training-mark";
import { AgencyHeader, type AgencyHeaderData } from "./invoice-pdf";

/**
 * The Audit Record (owner decision 2026-11-27): a formal printed record of audit log entries, suitable for
 * presentation, discipline or court. A cover block, then each entry with its changed fields, then signature lines.
 * Every page's footer carries the page number, the record ID and the integrity code.
 */

export type AuditPdfEntry = {
  id: string;
  /** Date and time with the zone written out. */
  when: string;
  who: string;
  action: string;
  subject: string;
  reason: string | null;
  changes: Array<{ field: string; before: string; after: string }>;
  context: string;
};

export type AuditPdfData = {
  agency: AgencyHeaderData;
  recordId: string;
  integrity: string;
  filters: string[];
  generatedBy: string;
  generatedAt: string;
  entries: AuditPdfEntry[];
};

export const AUDIT_STATEMENT =
  "This record was produced from the Signal 90 audit log. Entries are written when the action occurs and cannot be edited or deleted in the application.";

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 9.5, padding: 48, paddingBottom: 64, color: "#111111" },
  title: { fontSize: 22, fontFamily: "Helvetica-Bold", marginTop: 8 },
  cover: { borderWidth: 1, borderColor: "#888888", borderStyle: "solid", padding: 12, marginTop: 12, marginBottom: 6 },
  coverRow: { flexDirection: "row", marginBottom: 3 },
  coverLabel: { width: 120, color: "#444444" },
  coverValue: { flex: 1 },
  bold: { fontFamily: "Helvetica-Bold" },
  mono: { fontFamily: "Courier", fontSize: 8.5 },
  statement: { marginTop: 10, color: "#333333" },
  section: { fontSize: 12, fontFamily: "Helvetica-Bold", marginTop: 18, marginBottom: 6 },
  entry: { borderTopWidth: 0.75, borderTopColor: "#888888", borderTopStyle: "solid", paddingTop: 8, marginTop: 10 },
  entryHead: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  line: { flexDirection: "row", marginBottom: 2 },
  label: { width: 78, color: "#444444" },
  value: { flex: 1 },
  tableHead: { flexDirection: "row", backgroundColor: "#eeeeee", paddingVertical: 3, paddingHorizontal: 3, marginTop: 4 },
  tableRow: { flexDirection: "row", paddingVertical: 2.5, paddingHorizontal: 3, borderBottomWidth: 0.5, borderBottomColor: "#cccccc", borderBottomStyle: "solid" },
  field: { width: 120, paddingRight: 6 },
  cell: { flex: 1, paddingRight: 6 },
  muted: { color: "#555555" },
  signatures: { marginTop: 28, flexDirection: "row", gap: 24 },
  signature: { flex: 1 },
  sigLine: { flexDirection: "row", alignItems: "flex-end", marginTop: 16 },
  sigLabel: { width: 58, color: "#444444" },
  sigRule: { flex: 1, borderBottomWidth: 0.75, borderBottomColor: "#111111", borderBottomStyle: "solid", height: 12 },
  // No lineHeight here or on the page: react-pdf drops a render-prop text (Page X of Y) that has one.
  footer: { position: "absolute", bottom: 36, left: 48, right: 48, color: "#555555", fontSize: 7.5 },
  footerCode: { position: "absolute", bottom: 24, left: 48, right: 48, color: "#555555", fontFamily: "Courier", fontSize: 7.5 },
});

function CoverRow({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <View style={s.coverRow}>
      <Text style={s.coverLabel}>{label}</Text>
      <View style={s.coverValue}>{children}</View>
    </View>
  );
}

function Entry({ e }: Readonly<{ e: AuditPdfEntry }>) {
  return (
    <View style={s.entry} minPresenceAhead={60}>
      <View style={s.entryHead} wrap={false}>
        <Text style={s.bold}>{e.action}</Text>
        <Text>{e.when}</Text>
      </View>
      <View style={s.line}>
        <Text style={s.label}>Entry ID</Text>
        <Text style={[s.value, s.mono]}>{e.id}</Text>
      </View>
      <View style={s.line}>
        <Text style={s.label}>Done by</Text>
        <Text style={s.value}>{e.who}</Text>
      </View>
      <View style={s.line}>
        <Text style={s.label}>About</Text>
        <Text style={s.value}>{e.subject}</Text>
      </View>
      <View style={s.line}>
        <Text style={s.label}>Reason</Text>
        <Text style={s.value}>{e.reason ?? "None given"}</Text>
      </View>
      {e.changes.length ? (
        <View>
          <View style={s.tableHead} wrap={false}>
            <Text style={[s.field, s.bold]}>Field</Text>
            <Text style={[s.cell, s.bold]}>Before</Text>
            <Text style={[s.cell, s.bold]}>After</Text>
          </View>
          {keyedByContent(e.changes, (c) => c.field).map(({ key, item: c }) => (
            <View key={key} style={s.tableRow} wrap={false}>
              <Text style={s.field}>{c.field}</Text>
              <Text style={s.cell}>{c.before}</Text>
              <Text style={s.cell}>{c.after}</Text>
            </View>
          ))}
        </View>
      ) : (
        <View style={s.line}>
          <Text style={s.label}>Changes</Text>
          <Text style={[s.value, s.muted]}>No field changes recorded</Text>
        </View>
      )}
      <View style={[s.line, { marginTop: 4 }]}>
        <Text style={s.label}>System context</Text>
        <Text style={[s.value, s.muted]}>{e.context}</Text>
      </View>
    </View>
  );
}

function Signature({ title }: Readonly<{ title: string }>) {
  return (
    <View style={s.signature}>
      <Text style={s.bold}>{title}</Text>
      {["Name", "Title", "Signature", "Date"].map((l) => (
        <View key={l} style={s.sigLine}>
          <Text style={s.sigLabel}>{l}</Text>
          <View style={s.sigRule} />
        </View>
      ))}
    </View>
  );
}

export async function renderAuditRecordPdf(d: AuditPdfData): Promise<Buffer> {
  return renderToBuffer(
    <Document title={`Audit Record ${d.recordId}`}>
      <Page size="LETTER" style={s.page}>
        <TrainingMark />
        <AgencyHeader agency={d.agency} />
        <Text style={s.title}>Audit Record</Text>
        <View style={s.cover}>
          <CoverRow label="Record ID">
            <Text style={s.bold}>{d.recordId}</Text>
          </CoverRow>
          <CoverRow label="Filters used">
            {d.filters.map((f) => (
              <Text key={f}>{f}</Text>
            ))}
          </CoverRow>
          <CoverRow label="Number of entries">
            <Text>{String(d.entries.length)}</Text>
          </CoverRow>
          <CoverRow label="Generated by">
            <Text>{d.generatedBy}</Text>
          </CoverRow>
          <CoverRow label="Generated at">
            <Text>{d.generatedAt}</Text>
          </CoverRow>
          <CoverRow label="Integrity code">
            <Text style={s.mono}>{d.integrity}</Text>
          </CoverRow>
          <Text style={s.statement}>{AUDIT_STATEMENT}</Text>
          <Text style={[s.statement, s.muted]}>
            The integrity code is a SHA-256 digest of the entries in this record. An admin can check a printed copy against the system under Management, Audit log, Verify a printed record.
          </Text>
        </View>
        <Text style={s.section}>Entries</Text>
        {d.entries.length === 0 ? <Text style={s.muted}>No entries.</Text> : null}
        {d.entries.map((e) => (
          <Entry key={e.id} e={e} />
        ))}
        <View wrap={false}>
          <Text style={s.section}>Signatures</Text>
          <View style={s.signatures}>
            <Signature title="Prepared by" />
            <Signature title="Reviewed by" />
          </View>
        </View>
        <Text style={s.footer} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        <Text style={[s.footer, { textAlign: "right" }]} fixed>{`Record ${d.recordId}`}</Text>
        <Text style={s.footerCode} fixed>{`Integrity ${d.integrity}`}</Text>
      </Page>
    </Document>,
  );
}
