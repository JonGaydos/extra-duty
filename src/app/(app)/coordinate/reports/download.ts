import type { ActionResult } from "../../_personnel/result";

const FALLBACK = "The download did not work. Try again.";

/** The message a failed export sent back, or a plain fallback when it sent none. */
export async function downloadError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } } | null;
    const message = body?.error?.message;
    return typeof message === "string" && message ? message : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/** Posts a report spec to the export route and saves the file; a failure comes back as the route's message. */
export async function downloadReport(spec: unknown, format: "csv" | "pdf", filename: string): Promise<ActionResult> {
  let res: Response;
  try {
    res = await fetch("/api/v1/reports/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec, format }) });
  } catch {
    return { ok: false, error: "The download did not work. Check your connection and try again." };
  }
  if (!res.ok) return { ok: false, error: await downloadError(res) };
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return { ok: true, message: `Downloaded ${filename}.` };
}
