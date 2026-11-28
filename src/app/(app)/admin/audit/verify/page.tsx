import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/ui/icons";
import { PageTitle } from "../../../_personnel/TabLinks";
import { systemActor } from "../../_admin/session";
import { VerifyForm } from "./VerifyForm";

export const metadata: Metadata = { title: "Verify an audit record" };

/** Admins check a printed Audit Record: its record ID, and optionally its integrity code, against the audit data now. */
export default async function VerifyPage() {
  await systemActor();
  return (
    <div className="mx-auto flex w-full max-w-200 flex-col gap-4.5">
      <Link href="/admin/audit" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to the audit log
      </Link>
      <PageTitle sub="Check that a printed Audit Record still matches the audit log.">Verify a printed record</PageTitle>
      <VerifyForm />
    </div>
  );
}
