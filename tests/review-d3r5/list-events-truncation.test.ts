// Review d3r5: StripeProvider.listEvents treats "has_more: true" with an empty page (or a 200 without a data array)
// as the end of the log and returns a partial (or empty) list as if complete. createCheckoutSession throws
// bad_response for an answer it can't read; reconciliation would instead report success having fetched nothing.
import { describe, expect, it } from "vitest";
import { ProviderError } from "@/server/billing/provider";
import { StripeProvider } from "@/server/billing/stripe-provider";

const KEY = ["sk", "test", "x".repeat(24)].join("_");

function stripeAnswering(pages: (url: URL) => unknown) {
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input));
    return new Response(JSON.stringify(pages(url)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return new StripeProvider({ secretKey: KEY, apiBase: "http://stripe.invalid", fetch: fetchFn });
}

describe("StripeProvider.listEvents with an answer it can't follow", () => {
  it("doesn't return a partial list when Stripe says has_more but the page is empty", async () => {
    const stripe = stripeAnswering((url) =>
      url.searchParams.get("starting_after") === "evt_3"
        ? { object: "list", has_more: true, data: [] }
        : { object: "list", has_more: true, data: [{ id: "evt_3", object: "event" }] },
    );
    const outcome = await stripe.listEvents(new Date(1_763_000_000_000)).then(
      (events) => ({ returned: (events as { id: string }[]).map((e) => e.id) }),
      (error: unknown) => ({ threw: error instanceof ProviderError ? error.code : String(error) }),
    );
    // Current code: { returned: ["evt_3"] }, reported as the whole log.
    expect(outcome).not.toHaveProperty("returned");
  });

  it("doesn't read a 200 without a data array as an empty event log", async () => {
    const stripe = stripeAnswering(() => ({ object: "list", has_more: false }));
    await expect(stripe.listEvents(new Date(1_763_000_000_000))).rejects.toBeInstanceOf(ProviderError);
  });
});
