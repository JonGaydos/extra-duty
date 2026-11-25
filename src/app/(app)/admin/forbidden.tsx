import { Card } from "@/ui/components/Card";
import { ButtonLink } from "@/ui/components/Button";
import { PageTitle } from "../_personnel/TabLinks";

/** What a coordinator sees on a System screen (served with HTTP 403). */
export default function Forbidden() {
  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle>Admins only</PageTitle>
      <Card>
        <p className="m-0 max-w-[70ch]">Email server and security settings can be changed only by an admin. Ask an admin if something here needs to change.</p>
        <ButtonLink href="/admin" variant="secondary" className="w-fit">
          Back to Management
        </ButtonLink>
      </Card>
    </div>
  );
}
