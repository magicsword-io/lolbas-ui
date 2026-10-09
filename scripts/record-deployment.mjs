import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  root,
  githubClient,
  uiRepository,
  stateBranch,
  deploymentState,
  validatePlan,
} from "./sync-lib.mjs";

// UI-REL-001: called only after successful Pages deployment, with a same-run plan.
export async function recordDeployment(
  plan,
  env = process.env,
  api = githubClient(env.GH_TOKEN),
) {
  validatePlan(plan);
  if (
    env.GITHUB_REPOSITORY !== uiRepository ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_SHA !== plan.uiRevision ||
    !["push", "schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME)
  )
    throw new Error(
      "Deployment state writes require this UI repository main release context",
    );
  const existing = await deploymentState(api, uiRepository);
  if (existing.commit !== plan.stateCommit)
    throw new Error(
      "Deployment state changed since resolution; refusing to overwrite",
    );
  const state = {
    ...plan,
    deployedAt: new Date().toISOString(),
    runId: env.GITHUB_RUN_ID || null,
  };
  const prefix = `/repos/${uiRepository}`;
  const blob = await api(`${prefix}/git/blobs`, {
    method: "POST",
    body: { content: `${JSON.stringify(state, null, 2)}\n`, encoding: "utf-8" },
  });
  const base = existing.commit
    ? await api(`${prefix}/git/commits/${existing.commit}`)
    : null;
  const tree = await api(`${prefix}/git/trees`, {
    method: "POST",
    body: {
      ...(base ? { base_tree: base.tree.sha } : {}),
      tree: [
        {
          path: "deployment.json",
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        },
      ],
    },
  });
  const commit = await api(`${prefix}/git/commits`, {
    method: "POST",
    body: {
      message: `Record deployment of ${plan.upstream.revision}`,
      tree: tree.sha,
      parents: existing.commit ? [existing.commit] : [],
    },
  });
  await api(
    `${prefix}/git/${existing.commit ? `refs/heads/${stateBranch}` : "refs"}`,
    {
      method: existing.commit ? "PATCH" : "POST",
      body: existing.commit
        ? { sha: commit.sha, force: false }
        : { ref: `refs/heads/${stateBranch}`, sha: commit.sha },
    },
  );
  console.log(
    `Deployment state recorded: UI ${plan.uiRevision}, upstream ${plan.upstream.revision}`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await recordDeployment(
    JSON.parse(await readFile(resolve(root, ".sync/plan.json"), "utf8")),
  );
