import { db } from "@/server/db/client";
import { checkHealth } from "@/server/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const { httpStatus, body } = await checkHealth(db());
  return Response.json(body, { status: httpStatus, headers: { "Cache-Control": "no-store" } });
}
