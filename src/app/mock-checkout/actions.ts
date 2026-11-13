"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { mockProvider } from "@/server/billing/runtime";
import type { FormState } from "../actions";

// The simulated customer on the mock checkout page. Each action makes the mock provider send the signed event
// Stripe would send, to the same webhook handler a real delivery reaches. Only exists in mock mode.

async function act(id: string, fn: (mock: NonNullable<ReturnType<typeof mockProvider>>) => Promise<unknown>): Promise<FormState> {
  const mock = mockProvider();
  if (!mock || !mock.session(id)) notFound();
  try {
    await fn(mock);
    return {};
  } catch (error) {
    return { error: (error as Error).message };
  } finally {
    // Also after a refusal: paying a session that ran out sends its expiry, which the page should show.
    revalidatePath(`/mock-checkout/${id}`);
  }
}

export async function payByCardAction(id: string): Promise<FormState> {
  return act(id, (mock) => mock.pay(id, "card"));
}

export async function payByBankAction(id: string): Promise<FormState> {
  return act(id, (mock) => mock.pay(id, "bank"));
}

export async function settleAction(id: string, succeeded: boolean): Promise<FormState> {
  return act(id, (mock) => mock.settle(id, succeeded));
}

export async function lapseAction(id: string): Promise<FormState> {
  return act(id, (mock) => mock.lapse(id));
}

export async function redeliverAction(id: string): Promise<FormState> {
  return act(id, (mock) => mock.redeliver(id));
}
