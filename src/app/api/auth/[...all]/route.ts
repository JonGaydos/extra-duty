import { getAuth } from "@/lib/auth";

export async function GET(req: Request): Promise<Response> {
  return (await getAuth()).handler(req);
}

export async function POST(req: Request): Promise<Response> {
  return (await getAuth()).handler(req);
}
