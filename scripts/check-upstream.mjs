import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  githubClient,
  upstreamHead,
  deploymentState,
  makePlan,
  siteConfiguration,
  root,
  uiRepository,
  upstreamRepository,
  isRevision,
} from "./sync-lib.mjs";

export async function checkUpstream(
  env = process.env,
  api = githubClient(env.GH_TOKEN),
) {
  const { state, commit } = await deploymentState(
    api,
    env.GITHUB_REPOSITORY || uiRepository,
  );
  const head = await upstreamHead(api);
  let events = [];
  try {
    events = await api(`/repos/${upstreamRepository}/events?per_page=100`);
    if (!Array.isArray(events)) throw new Error("Invalid events");
  } catch {
    console.warn(
      "Event feed unavailable; verified default-branch HEAD remains authoritative.",
    );
    events = [];
  }
  const result = makePlan({
    head,
    state,
    stateCommit: commit,
    uiRevision: env.GITHUB_SHA,
    site: siteConfiguration(env),
    force: env.FORCE_REBUILD === "true",
    resume: env.RESUME_UPSTREAM === "true",
    revision: env.UPSTREAM_REVISION || undefined,
    events,
  });
  // A held/manual snapshot must also exist in the canonical source repository.
  if (result.plan.upstream.revision !== head.revision) {
    const source = await api(
      `/repos/${upstreamRepository}/commits/${result.plan.upstream.revision}`,
    );
    if (!isRevision(source.sha) || source.sha !== result.plan.upstream.revision)
      throw new Error("Pinned source revision does not exist");
  }
  return result;
}

async function main() {
  const { plan, changed } = await checkUpstream();
  await mkdir(resolve(root, ".sync"), { recursive: true });
  await writeFile(
    resolve(root, ".sync/plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  const output = `revision=${plan.upstream.revision}\nbranch=${plan.upstream.branch}\nchanged=${changed}\nsite_url=${plan.site.url}\nsite_base=${plan.site.base}\n`;
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, output);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Upstream synchronization\n\n${changed ? "Rebuild" : "Skip"}: ${plan.reason}.\n\nUI: \`${plan.uiRevision}\`\n\nUpstream: \`${plan.upstream.revision}\` (${plan.upstream.branch})\n\nPinned hold: **${plan.hold}**. Matching merge events observed: ${plan.mergeEventIds.length}.\n`,
    );
  console.log(
    `${changed ? "Rebuild" : "Skip"} (${plan.reason}): ${plan.upstream.repository}@${plan.upstream.revision}; hold=${plan.hold}`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
