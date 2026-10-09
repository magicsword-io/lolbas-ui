import { test } from "node:test";
import assert from "node:assert/strict";
import {
  githubClient,
  upstreamRepository,
  uiRepository,
  upstreamHead,
  deploymentState,
  makePlan,
  mergeEvents,
  siteConfiguration,
  validatePlan,
} from "./sync-lib.mjs";
import { checkUpstream } from "./check-upstream.mjs";
import { recordDeployment } from "./record-deployment.mjs";

const revision = "a".repeat(40),
  next = "b".repeat(40),
  uiRevision = "c".repeat(40),
  stateCommit = "d".repeat(40);
const head = { repository: upstreamRepository, branch: "master", revision };
const site = { url: "https://magicsword-io.github.io", base: "/lolbas-ui" };
const initial = () => makePlan({ head, uiRevision, site }).plan;
const event = (base = "master", merged = true) => ({
  id: "12345",
  type: "PullRequestEvent",
  repo: { name: upstreamRepository },
  payload: {
    action: "closed",
    pull_request: {
      merged,
      base: { ref: base, repo: { full_name: upstreamRepository } },
    },
  },
});
function fixtureApi({
  state = null,
  source = head,
  events = [event()],
  stateError,
  repoError,
} = {}) {
  return async (path) => {
    if (path === `/repos/${uiRepository}`) {
      if (repoError) throw repoError;
      return { full_name: uiRepository };
    }
    if (path.includes("/git/ref/heads/")) {
      if (stateError) throw stateError;
      return state ? { object: { sha: stateCommit } } : null;
    }
    if (path.includes("/contents/deployment.json"))
      return {
        type: "file",
        encoding: "base64",
        size: 1000,
        content: Buffer.from(JSON.stringify(state)).toString("base64"),
      };
    if (path === `/repos/${upstreamRepository}`)
      return { full_name: upstreamRepository, default_branch: source.branch };
    if (path.includes("/commits/"))
      return {
        sha:
          path.endsWith("/master") || path.endsWith("/main")
            ? source.revision
            : path.split("/").at(-1),
      };
    if (path.includes("/events?")) {
      if (events instanceof Error) throw events;
      return events;
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  };
}
const context = () => ({
  GITHUB_REPOSITORY: uiRepository,
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "schedule",
  GITHUB_SHA: uiRevision,
});

test("UI-SYNC-001 first deployment builds; matching state skips even with delayed duplicate merge events", async () => {
  const first = await checkUpstream(context(), fixtureApi());
  assert.equal(first.changed, true);
  assert.equal(first.plan.reason, "initial-deployment");
  const same = await checkUpstream(
    context(),
    fixtureApi({ state: first.plan }),
  );
  assert.equal(same.changed, false);
  assert.equal(same.plan.reason, "unchanged");
});
test("UI-SYNC-001 merge on default branch rebuilds at new immutable HEAD; unrelated/closed-unmerged events do not", async () => {
  assert.deepEqual(
    mergeEvents(
      [
        event(),
        event("feature"),
        event("master", false),
        { ...event(), repo: { name: "attacker/LOLBAS" } },
      ],
      "master",
    ),
    ["12345"],
  );
  const result = await checkUpstream(
    context(),
    fixtureApi({ state: initial(), source: { ...head, revision: next } }),
  );
  assert.equal(result.changed, true);
  assert.equal(result.plan.upstream.revision, next);
  const unrelated = makePlan({
    head,
    state: initial(),
    uiRevision,
    site,
    events: [event("feature")],
  });
  assert.equal(unrelated.changed, false);
});
test("UI-SYNC-001 missing/failed event feeds and squash/rebase/direct pushes are recovered through HEAD comparison", async () => {
  for (const events of [[], new Error("Unavailable")]) {
    const result = await checkUpstream(
      context(),
      fixtureApi({
        state: initial(),
        source: { ...head, revision: next },
        events,
      }),
    );
    assert.equal(result.changed, true);
    assert.equal(result.plan.reason, "upstream-changed");
  }
});
test("UI-SYNC-001 upstream default branch is discovered rather than hardcoded", async () => {
  const result = await checkUpstream(
    context(),
    fixtureApi({
      state: initial(),
      source: { ...head, branch: "main" },
      events: [event("main")],
    }),
  );
  assert.equal(result.plan.upstream.branch, "main");
  assert.equal(result.changed, true);
  assert.deepEqual(result.plan.mergeEventIds, ["12345"]);
});
test("UI-REL-002 both UI revisions and domain/base configuration cause rebuilds", () => {
  const state = initial();
  for (const change of [
    { uiRevision: next },
    { site: { url: "https://lolbas.io", base: "/" } },
    { site: { ...site, base: "/other" } },
  ]) {
    assert.equal(
      makePlan({ head, state, uiRevision, site, ...change }).changed,
      true,
    );
  }
  assert.equal(
    makePlan({ head, state, uiRevision, site, force: true }).plan.reason,
    "forced-rebuild",
  );
});
test("UI-REL-002 pinned rollback persists through polling and UI updates until explicit resume", async () => {
  const pinned = makePlan({
    head,
    state: initial(),
    uiRevision,
    site,
    revision: next,
  }).plan;
  assert.equal(pinned.hold, true);
  assert.equal(pinned.upstream.revision, next);
  const poll = await checkUpstream(context(), fixtureApi({ state: pinned }));
  assert.equal(poll.changed, false);
  assert.equal(poll.plan.upstream.revision, next);
  const uiUpdate = makePlan({
    head,
    state: pinned,
    uiRevision: revision,
    site,
  });
  assert.equal(uiUpdate.changed, true);
  assert.equal(uiUpdate.plan.upstream.revision, next);
  const resumed = makePlan({
    head,
    state: pinned,
    uiRevision,
    site,
    resume: true,
  });
  assert.equal(resumed.changed, true);
  assert.equal(resumed.plan.hold, false);
  assert.equal(resumed.plan.upstream.revision, head.revision);
  assert.throws(() =>
    makePlan({
      head,
      state: pinned,
      uiRevision,
      site,
      resume: true,
      revision: next,
    }),
  );
});
test("UI-SYNC-002 inaccessible/corrupt state and malformed revisions fail closed, not initial deployment", async () => {
  await assert.rejects(
    deploymentState(fixtureApi({ repoError: new Error("403") }), uiRepository),
    /403/,
  );
  await assert.rejects(
    deploymentState(fixtureApi({ stateError: new Error("500") }), uiRepository),
    /500/,
  );
  await assert.rejects(
    deploymentState(fixtureApi({ state: { schema: 99 } }), uiRepository),
    /Invalid deployment/,
  );
  await assert.rejects(
    upstreamHead(fixtureApi({ source: { ...head, revision: "main" } })),
    /immutable/,
  );
  await assert.rejects(
    checkUpstream(
      { ...context(), UPSTREAM_REVISION: "main;rm -rf /" },
      fixtureApi(),
    ),
    /immutable/,
  );
  assert.throws(() => validatePlan({ ...initial(), uiRevision: "feature" }));
});
test("UI-REL-002 unsafe origins and base paths cannot enter plan or action outputs", () => {
  for (const url of [
    "http://lolbas.io",
    "https://user:password@lolbas.io",
    "https://lolbas.io/path",
    "https://lolbas.io/?token=x",
  ])
    assert.throws(() => siteConfiguration({ SITE_URL: url }));
  for (const base of [
    "/../evil",
    "bad",
    "/x?secret",
    "/a\nchanged=true",
    "/a//../b",
  ])
    assert.throws(() => siteConfiguration({ SITE_BASE: base }));
  assert.deepEqual(
    siteConfiguration({ SITE_URL: "https://lolbas.io/", SITE_BASE: "/" }),
    { url: "https://lolbas.io", base: "/" },
  );
});
test("UI-REL-001 GitHub client restricts token destination, forbids redirects, and redacts error response bodies", async () => {
  let request;
  const api = githubClient("fixture-secret", async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ safe: true }), { status: 200 });
  });
  await api(`/repos/${upstreamRepository}`);
  assert.equal(
    request.url,
    `https://api.github.com/repos/${upstreamRepository}`,
  );
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.Authorization, "Bearer fixture-secret");
  await assert.rejects(api("https://attacker.test/"), /Unsupported/);
  const broken = githubClient(
    "fixture-secret",
    async () =>
      new Response("fixture-secret should never appear", { status: 403 }),
  );
  await assert.rejects(
    broken(`/repos/${uiRepository}`),
    (error) =>
      /HTTP 403/.test(error.message) &&
      !error.message.includes("fixture-secret"),
  );
});
test("UI-REL-001 state write rejects PR/fork/feature/wrong UI revision before API mutation", async () => {
  for (const change of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REPOSITORY: "attacker/lolbas-ui" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_SHA: next },
  ]) {
    let called = false;
    await assert.rejects(
      recordDeployment(initial(), { ...context(), ...change }, async () => {
        called = true;
      }),
      /main release context/,
    );
    assert.equal(called, false);
  }
});
test("UI-REL-001 state creates only metadata branch after publication and rejects concurrent state replacement", async () => {
  const writes = [];
  const reads = fixtureApi();
  const api = async (path, options = {}) => {
    if (!options.method) return reads(path);
    writes.push({ path, ...options });
    return { sha: next };
  };
  await recordDeployment(initial(), context(), api);
  assert.equal(writes.at(-1).body.ref, "refs/heads/deployment-state");
  assert.equal(writes[1].body.tree[0].path, "deployment.json");
  assert.equal(writes[2].body.parents.length, 0);
  await assert.rejects(
    recordDeployment(initial(), context(), fixtureApi({ state: initial() })),
    /changed since resolution/,
  );
});
test("UI-REL-001 existing state update is fast-forward and retains previous tree", async () => {
  const writes = [];
  const reads = fixtureApi({ state: initial() });
  const plan = { ...initial(), stateCommit };
  const api = async (path, options = {}) => {
    if (!options.method)
      return path.includes("/git/commits/")
        ? { tree: { sha: revision } }
        : reads(path);
    writes.push({ path, ...options });
    return { sha: next };
  };
  await recordDeployment(plan, context(), api);
  assert.equal(writes[1].body.base_tree, revision);
  assert.deepEqual(writes[2].body.parents, [stateCommit]);
  assert.equal(writes.at(-1).method, "PATCH");
  assert.equal(writes.at(-1).body.force, false);
});
