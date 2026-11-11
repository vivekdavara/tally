// Liveness only for now; the database check arrives with the Prisma client.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
