import { billing } from "@/server/billing/runtime";
import { handleStripeWebhook } from "@/server/billing/webhook";

// Stripe's webhook endpoint. The body is read as raw bytes (the signature covers them exactly) and capped: a
// checkout-session event is a few kilobytes, so anything past 256 KiB is refused before it's buffered.

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

async function readCapped(request: Request): Promise<Buffer | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function POST(request: Request): Promise<Response> {
  const body = await readCapped(request);
  if (body === null) return Response.json({ result: "rejected", reason: "body too large" }, { status: 413 });
  const { status, body: answer } = await handleStripeWebhook(body, request.headers.get("stripe-signature"), billing().webhook);
  return Response.json(answer, { status });
}
