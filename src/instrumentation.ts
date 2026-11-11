// Runs once when the server starts (DESIGN.md, "Layer 3"). The check lives in a Node-only module because
// Next.js also compiles this file for the Edge runtime, which has no process.exit.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
