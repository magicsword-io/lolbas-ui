import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { root, validatePlan } from "./sync-lib.mjs";
export async function writeBuildInfo(
  directory = resolve(root, "website/dist"),
  planFile = resolve(root, ".sync/plan.json"),
) {
  const plan = validatePlan(JSON.parse(await readFile(planFile, "utf8")));
  const gitRevision = (path) =>
    execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  if (
    gitRevision(root) !== plan.uiRevision ||
    gitRevision(resolve(root, ".upstream")) !== plan.upstream.revision
  )
    throw new Error(
      "Checked-out UI/upstream revisions do not match the deployment plan",
    );
  const info = {
    schema: 1,
    ui: { repository: "magicsword-io/lolbas-ui", revision: plan.uiRevision },
    upstream: plan.upstream,
    site: plan.site,
    hold: plan.hold,
    builtAt: new Date().toISOString(),
  };
  await writeFile(
    resolve(directory, "build-info.json"),
    `${JSON.stringify(info, null, 2)}\n`,
  );
  await writeFile(
    resolve(directory, "source-revision.txt"),
    `${plan.uiRevision}\n`,
  );
  await writeFile(
    resolve(directory, "upstream-revision.txt"),
    `${plan.upstream.revision}\n`,
  );
  console.log(
    `Recorded both UI and upstream provenance: ${plan.upstream.revision}`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await writeBuildInfo();
