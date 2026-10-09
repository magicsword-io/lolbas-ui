import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sourceSnapshot } from '../scripts/prepare-data.mjs';
import { makePlan, upstreamRepository } from '../../scripts/sync-lib.mjs';

test('UI-SITE-001 source links require the actual checkout and validated CI snapshot', async () => {
  const checkoutRoot = await mkdtemp(join(tmpdir(), 'lolbas-source-'));
  const planFile = join(checkoutRoot, 'plan.json');
  const git = (args) =>
    execFileSync('git', ['-C', checkoutRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    git(['init']);
    git([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Snapshot Test',
      '-c',
      'user.email=snapshot@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'Fixture',
    ]);
    const revision = git(['rev-parse', 'HEAD']);
    const options = { checkoutRoot, planFile, ci: true };
    await assert.rejects(
      sourceSnapshot(options),
      /requires a resolved deployment plan/,
    );
    await assert.rejects(
      sourceSnapshot({
        ...options,
        checkoutRoot: join(checkoutRoot, 'missing'),
      }),
    );
    assert.deepEqual(await sourceSnapshot({ ...options, ci: false }), {
      revision,
      branch: 'master',
    });
    await writeFile(planFile, '{broken');
    await assert.rejects(sourceSnapshot(options), SyntaxError);
    await writeFile(planFile, '{}');
    await assert.rejects(sourceSnapshot(options));
    const plan = makePlan({
      head: { repository: upstreamRepository, branch: 'main', revision },
      uiRevision: 'c'.repeat(40),
      site: { url: 'https://magicsword-io.github.io', base: '/lolbas-ui' },
    }).plan;
    await writeFile(planFile, JSON.stringify(plan));
    assert.deepEqual(await sourceSnapshot(options), {
      revision,
      branch: 'main',
    });
    plan.upstream.revision =
      revision === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40);
    await writeFile(planFile, JSON.stringify(plan));
    await assert.rejects(
      sourceSnapshot(options),
      /differs from the deployment plan/,
    );
  } finally {
    await rm(checkoutRoot, { recursive: true, force: true });
  }
});
