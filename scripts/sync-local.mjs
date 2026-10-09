import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  githubClient,
  upstreamHead,
  upstreamRepository,
  root,
  isRevision,
} from "./sync-lib.mjs";
const api = githubClient();
const head = await upstreamHead(api);
const revision = process.argv[2] || head.revision;
if (!isRevision(revision))
  throw new Error("Specify a full upstream commit SHA");
if (revision !== head.revision) {
  const commit = await api(`/repos/${upstreamRepository}/commits/${revision}`);
  if (commit.sha !== revision) throw new Error("Unknown upstream revision");
}
const directory = resolve(root, ".upstream");
await mkdir(directory, { recursive: true });
const git = (...args) =>
  execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-C", directory, ...args],
    { stdio: "inherit" },
  );
git("init");
git(
  "fetch",
  "--depth=1",
  `https://github.com/${upstreamRepository}.git`,
  revision,
);
git("checkout", "--detach", "FETCH_HEAD");
console.log(
  `Pinned catalog: ${upstreamRepository}@${revision}. No catalog data is committed to the UI repository.`,
);
