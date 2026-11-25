import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { staffDirectory, vendorDirectory } from "@/domain/coordinator/views";
import { DATASETS } from "@/domain/reports/datasets";
import { LABEL } from "@/domain/reports/engine";
import { listSavedReports } from "@/domain/reports/saved";
import { agencyDateParts } from "@/domain/time/agency-time";
import { PageTitle } from "../../_personnel/TabLinks";
import { coordinatorActor } from "../_coordinator/session";
import { ReportBuilder, type DatasetInfo, type SavedInfo } from "./ReportBuilder";

export const metadata: Metadata = { title: "Reports" };

const pad = (n: number) => String(n).padStart(2, "0");

/** Built-in and saved reports, the report builder, and the way into any deputy's earnings. */
export default async function ReportsPage() {
  const actor = await coordinatorActor();
  const data = await withTx(async (tx) => ({
    saved: await listSavedReports(actor, tx),
    people: await staffDirectory(actor, tx),
    vendors: await vendorDirectory(actor, tx),
  }));
  // Personnel activity has its own page (presets, rank and flag filters, leaderboards, sorting).
  const datasets: DatasetInfo[] = Object.entries(DATASETS).filter(([name]) => name !== "activity").map(([name, d]) => ({ name, title: d.title, groupings: [...d.groupings], measures: [...d.measures], filters: [...d.filters] }));
  const saved: SavedInfo[] = data.saved.map((r) => ({ id: r.id, name: r.name, builtIn: r.builtIn, spec: r.spec as SavedInfo["spec"] }));
  const p = agencyDateParts(new Date());
  const lastDay = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle>Reports</PageTitle>
      <ReportBuilder
        datasets={datasets}
        saved={saved}
        labels={LABEL}
        deputies={data.people.filter((u) => u.role !== "vendor").map((u) => ({ id: u.id, name: u.name }))}
        vendors={data.vendors.map((v) => ({ id: v.id, name: v.name }))}
        defaultFrom={`${p.year}-01-01`}
        defaultTo={`${p.year}-${pad(p.month)}-${pad(lastDay)}`}
      />
    </div>
  );
}
