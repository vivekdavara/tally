// The Kubernetes manifests (deploy/k8s) describe one release: the three images share one tag, the package's version,
// and the migration Job's name carries that version. A Job's pod template can't change, so a release that bumped the
// tags and kept the Job's name would be refused, and one that kept both would skip its migration while `kubectl wait`
// returned at once on the old Job (review rounds 4 and 5 of day 5). This keeps the three in step.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const dir = join(root, "deploy", "k8s");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const text = readdirSync(dir)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .join("\n");

it("uses the package's version as the tag of every Tally image", () => {
  const images = [...text.matchAll(/^\s*image:\s*(tally-[a-z]+):(\S+)\s*$/gm)].map((m) => [m[1], m[2]]);
  expect(images.map(([name]) => name).sort()).toEqual(["tally-migrate", "tally-web", "tally-worker"]);
  for (const [name, tag] of images) expect(`${name}:${tag}`).toBe(`${name}:${version}`);
});

it("names the migration Job after that version", () => {
  const jobs = [...text.matchAll(/kind: Job\nmetadata:\n\s+name:\s*(\S+)/g)].map((m) => m[1]);
  expect(jobs).toEqual([`tally-migrate-v${version.replaceAll(".", "-")}`]);
});
