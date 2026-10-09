import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const upstreamRepository = "LOLBAS-Project/LOLBAS";
export const uiRepository = "magicsword-io/lolbas-ui";
export const stateBranch = "deployment-state";
export const isRevision = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const requireRevision = (value) => {
  if (!isRevision(value))
    throw new Error("Expected an immutable 40-character commit SHA");
  return value;
};
export function validateRepository(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
  )
    throw new Error("Invalid repository identity");
  return value;
}
export function validateBranch(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.endsWith(".lock")
  )
    throw new Error("Invalid upstream default branch");
  return value;
}
export function siteConfiguration(env = process.env) {
  const url = new URL(env.SITE_URL || "https://magicsword-io.github.io");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "SITE_URL must be an HTTPS origin without credentials, path or query",
    );
  const base = (env.SITE_BASE || "/lolbas-ui").replace(/\/$/, "") || "/";
  if (
    !/^\/(?:[A-Za-z0-9_.-]+\/?)*$/.test(base) ||
    base.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("SITE_BASE must be a safe absolute path");
  return { url: url.origin, base };
}

// Tokens are sent only to GitHub's API. Redirects and response bodies are not logged.
export function githubClient(token = process.env.GH_TOKEN, fetcher = fetch) {
  return async (path, { method = "GET", body, allow404 = false } = {}) => {
    if (!path.startsWith("/repos/"))
      throw new Error("Unsupported GitHub API path");
    const response = await fetcher(`https://api.github.com${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lolbas-ui-sync",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        `GitHub ${method} request failed (HTTP ${response.status})`,
      );
    return response.json();
  };
}

export async function upstreamHead(api) {
  const repo = await api(`/repos/${upstreamRepository}`);
  if (repo.full_name !== upstreamRepository)
    throw new Error("Unexpected upstream repository");
  const branch = validateBranch(repo.default_branch);
  const commit = await api(
    `/repos/${upstreamRepository}/commits/${encodeURIComponent(branch)}`,
  );
  return {
    repository: upstreamRepository,
    branch,
    revision: requireRevision(commit.sha),
  };
}

export function validatePlan(value) {
  if (
    !value ||
    value.schema !== 1 ||
    !isRevision(value.uiRevision) ||
    value.upstream?.repository !== upstreamRepository ||
    !isRevision(value.upstream.revision) ||
    typeof value.hold !== "boolean" ||
    typeof value.reason !== "string" ||
    !Number.isFinite(Date.parse(value.checkedAt)) ||
    (value.stateCommit != null && !isRevision(value.stateCommit))
  )
    throw new Error("Invalid deployment state or plan");
  validateBranch(value.upstream.branch);
  const expected = siteConfiguration({
    SITE_URL: value.site?.url,
    SITE_BASE: value.site?.base,
  });
  if (
    !value.site ||
    expected.url !== value.site.url ||
    expected.base !== value.site.base
  )
    throw new Error("Invalid deployment site configuration");
  return value;
}

// A missing state branch is a first deployment; inaccessible/corrupt state is an error.
export async function deploymentState(api, repository) {
  validateRepository(repository);
  const repo = await api(`/repos/${repository}`);
  if (repo.full_name.toLowerCase() !== repository.toLowerCase())
    throw new Error("Unexpected UI repository");
  const ref = await api(`/repos/${repository}/git/ref/heads/${stateBranch}`, {
    allow404: true,
  });
  if (!ref) return { state: null, commit: null };
  const commit = requireRevision(ref.object?.sha);
  const file = await api(
    `/repos/${repository}/contents/deployment.json?ref=${commit}`,
  );
  if (file.type !== "file" || file.encoding !== "base64" || file.size > 64_000)
    throw new Error("Invalid deployment-state file");
  const state = validatePlan(
    JSON.parse(Buffer.from(file.content, "base64").toString("utf8")),
  );
  return { state, commit };
}

export function mergeEvents(events, branch) {
  if (!Array.isArray(events)) throw new Error("Invalid event feed");
  return events
    .filter(
      (event) =>
        event.repo?.name === upstreamRepository &&
        event.type === "PullRequestEvent" &&
        event.payload?.action === "closed" &&
        event.payload.pull_request?.merged === true &&
        event.payload.pull_request.base?.repo?.full_name ===
          upstreamRepository &&
        event.payload.pull_request.base.ref === branch &&
        /^\d{1,30}$/.test(event.id),
    )
    .map((event) => event.id);
}

// UI-SYNC-001 / UI-REL-002: events are diagnostic; immutable HEAD/state decide freshness.
export function makePlan({
  head,
  state,
  stateCommit = null,
  uiRevision,
  site,
  force = false,
  resume = false,
  revision,
  events = [],
  now = new Date().toISOString(),
}) {
  requireRevision(uiRevision);
  if (revision && resume)
    throw new Error("Choose a pinned revision or resume, not both");
  if (revision) requireRevision(revision);
  const hold = Boolean(revision || (state?.hold && !resume));
  const source = revision || (hold ? state.upstream.revision : head.revision);
  const upstream = { ...head, revision: source };
  let reason = "unchanged";
  if (!state) reason = "initial-deployment";
  else if (resume) reason = "resume-upstream";
  else if (revision) reason = "pinned-snapshot";
  else if (force) reason = "forced-rebuild";
  else if (state.uiRevision !== uiRevision) reason = "ui-changed";
  else if (
    state.upstream.revision !== source ||
    state.upstream.branch !== head.branch
  )
    reason = "upstream-changed";
  else if (JSON.stringify(state.site) !== JSON.stringify(site))
    reason = "site-configuration-changed";
  const plan = validatePlan({
    schema: 1,
    uiRevision,
    upstream,
    site,
    hold,
    reason,
    checkedAt: now,
    stateCommit,
    mergeEventIds: mergeEvents(events, head.branch),
  });
  return { plan, changed: reason !== "unchanged" };
}
