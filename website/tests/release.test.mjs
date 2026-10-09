import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const directory = new URL('../../.github/workflows/', import.meta.url);
const workflow = (name) =>
  parse(readFileSync(new URL(name, directory), 'utf8'));
const ci = workflow('ci.yml');
const publish = workflow('publish.yml');
const canonical = 'magicsword-io/lolbas-ui';
const action = (job, name) =>
  job.steps.find((step) => step.uses?.startsWith(`${name}@`));
const evaluate = (expression, context) =>
  runInNewContext(
    expression.replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1'),
    context,
    { timeout: 100 },
  );
const context = (overrides = {}) => ({
  vars: { PAGES_ENABLED: 'true' },
  github: {
    repository: canonical,
    ref: 'refs/heads/main',
    event_name: 'push',
    event: { repository: { fork: false } },
    ...overrides,
  },
});

// UI-REL-001: exercise actual parsed conditions, including positive controls.
test('publication gates reject PRs, forks, foreign repos, tags and non-main refs', () => {
  for (const repository of [canonical, 'contributor/lolbas-ui']) {
    for (const ref of [
      'refs/heads/main',
      'refs/heads/feature',
      'refs/tags/main',
    ]) {
      for (const fork of [false, true]) {
        for (const event_name of [
          'push',
          'schedule',
          'workflow_dispatch',
          'pull_request',
          'pull_request_target',
          'repository_dispatch',
          'workflow_run',
        ]) {
          const input = {
            repository,
            ref,
            event_name,
            event: { repository: { fork } },
          };
          const allowed =
            repository === canonical &&
            ref === 'refs/heads/main' &&
            !fork &&
            ['push', 'schedule', 'workflow_dispatch'].includes(event_name);
          for (const name of ['resolve', 'deploy', 'record-state']) {
            assert.equal(
              Boolean(evaluate(publish.jobs[name].if, context(input))),
              allowed,
              `${name}: ${JSON.stringify(input)}`,
            );
          }
        }
      }
    }
  }
});

test('publication requires explicit Pages opt-in; unset and false skip every privileged path', () => {
  for (const flag of [undefined, '', 'false', 'TRUE', 'true']) {
    for (const event_name of ['push', 'schedule', 'workflow_dispatch']) {
      const input = {
        ...context({ event_name }),
        vars: { PAGES_ENABLED: flag },
      };
      for (const name of ['resolve', 'deploy', 'record-state']) {
        assert.equal(
          Boolean(evaluate(publish.jobs[name].if, input)),
          flag === 'true',
          `${name}: ${event_name}/${flag}`,
        );
      }
    }
  }
  assert.doesNotMatch(JSON.stringify(ci), /PAGES_ENABLED/);
});

test('PR workflow is read-only with no publisher or credential persistence', () => {
  assert.deepEqual(readdirSync(directory).sort(), ['ci.yml', 'publish.yml']);
  assert.deepEqual(ci.on.pull_request.branches, ['main']);
  for (const flow of [ci, publish]) {
    assert.deepEqual(flow.permissions, { contents: 'read' });
    assert.equal(flow.on.pull_request_target, undefined);
    assert.equal(flow.on.repository_dispatch, undefined);
    assert.equal(flow.on.workflow_run, undefined);
    for (const job of Object.values(flow.jobs)) {
      for (const step of job.steps) {
        if (step.uses?.startsWith('actions/checkout@')) {
          assert.equal(step.with['persist-credentials'], false);
        }
      }
    }
  }
  assert.doesNotMatch(
    JSON.stringify(ci),
    /deploy-pages|record-deployment|secrets\.|"write"/,
  );
  assert.equal(publish.on.pull_request, undefined);
});

test('UI-SYNC-001 resolves every five minutes and serializes through recording', () => {
  assert.deepEqual(publish.on.push.branches, ['main']);
  assert.deepEqual(publish.on.schedule, [{ cron: '2-57/5 * * * *' }]);
  assert.deepEqual(publish.concurrency, {
    group: 'lolbas-ui-publication',
    'cancel-in-progress': false,
  });
  assert.equal(
    publish.jobs.resolve.steps.find((step) => step.id === 'upstream').run,
    'node scripts/check-upstream.mjs',
  );
  assert.deepEqual([publish.jobs.build.needs].flat(), ['resolve']);
  for (const changed of ['true', 'false', '', undefined]) {
    assert.equal(
      evaluate(publish.jobs.build.if, {
        needs: { resolve: { outputs: { changed } } },
      }),
      changed === 'true',
    );
  }
});

test('UI-REL-002 only manual dispatch accepts force and pinned rollback inputs', () => {
  assert.equal(publish.on.workflow_dispatch.inputs.force.type, 'boolean');
  assert.equal(publish.on.workflow_dispatch.inputs.force.default, false);
  assert.equal(publish.on.workflow_dispatch.inputs.resume.type, 'boolean');
  assert.equal(publish.on.workflow_dispatch.inputs.resume.default, false);
  assert.equal(
    publish.on.workflow_dispatch.inputs.upstream_revision.type,
    'string',
  );
  const env = publish.jobs.resolve.steps.find(
    (step) => step.id === 'upstream',
  ).env;
  for (const event_name of ['push', 'schedule', 'workflow_dispatch']) {
    for (const force of [false, true]) {
      const input = {
        ...context({ event_name }),
        inputs: { force, resume: force, upstream_revision: 'a'.repeat(40) },
      };
      assert.equal(
        evaluate(env.FORCE_REBUILD, input),
        event_name === 'workflow_dispatch' && force ? 'true' : 'false',
      );
      assert.equal(
        evaluate(env.RESUME_UPSTREAM, input),
        event_name === 'workflow_dispatch' && force ? 'true' : 'false',
      );
      assert.equal(
        evaluate(env.UPSTREAM_REVISION, input),
        event_name === 'workflow_dispatch' ? 'a'.repeat(40) : '',
      );
    }
  }
});

test('UI-SYNC-002 consumes one immutable data checkout without running upstream code', () => {
  for (const [job, reference] of [
    [ci.jobs.validate, '${{ steps.upstream.outputs.revision }}'],
    [publish.jobs.build, '${{ needs.resolve.outputs.revision }}'],
  ]) {
    const checkout = job.steps.find(
      (step) => step.with?.repository === 'LOLBAS-Project/LOLBAS',
    );
    assert.equal(checkout.with.ref, reference);
    assert.equal(checkout.with.path, '.upstream');
    assert.equal(
      job.env.LOLBAS_SOURCE_DIR,
      '${{ github.workspace }}/.upstream/yml',
    );
    assert.equal(job.defaults.run['working-directory'], 'website');
    for (const step of job.steps) {
      assert.doesNotMatch(step.run ?? '', /\.upstream|validation\.py|yamllint/);
      assert.notEqual(step['working-directory'], '.upstream');
    }
  }
});

test('root, prefix and configured browser tests gate exactly the published artifact', () => {
  for (const job of [ci.jobs.validate, publish.jobs.build]) {
    const steps = job.steps;
    for (const command of [
      'npm ci',
      'npm run format:check',
      'npm run check',
      'npm run test:data',
      'node --test scripts/*.test.mjs',
      'npx playwright install --with-deps chromium',
    ]) {
      assert.ok(
        steps.some((step) => step.run === command),
        command,
      );
    }
    for (const base of ['', '/lolbas-ui']) {
      const build = steps.findIndex(
        (step) => step.run === 'npm run build' && step.env?.SITE_BASE === base,
      );
      const browser = steps.findIndex(
        (step) => step.run === 'npm test' && step.env?.SITE_BASE === base,
      );
      assert.ok(build >= 0 && browser > build);
    }
    assert.equal(job['continue-on-error'], undefined);
    for (const step of steps) {
      assert.equal(step['continue-on-error'], undefined);
      if (
        step.uses === 'actions/upload-artifact@v4' &&
        step.with?.path ===
          'website/playwright-report/\nwebsite/test-results/\n'
      ) {
        assert.equal(step.if, 'always()');
      } else {
        assert.equal(step.if, undefined);
      }
    }
  }
  const steps = publish.jobs.build.steps;
  assert.equal(
    publish.jobs.build.env.SITE_URL,
    '${{ needs.resolve.outputs.site_url }}',
  );
  assert.equal(
    publish.jobs.resolve.env.SITE_BASE,
    "${{ vars.SITE_BASE || '/lolbas-ui' }}",
  );
  const configuredBase = '${{ needs.resolve.outputs.site_base }}';
  assert.equal(
    publish.jobs.resolve.outputs.site_url,
    '${{ steps.upstream.outputs.site_url }}',
  );
  assert.equal(
    publish.jobs.resolve.outputs.site_base,
    '${{ steps.upstream.outputs.site_base }}',
  );
  assert.doesNotMatch(JSON.stringify(publish.jobs.build), /vars\.SITE_/);
  const configuredBuild = steps.findIndex(
    (step) =>
      step.run === 'npm run build' && step.env?.SITE_BASE === configuredBase,
  );
  const configuredTest = steps.findIndex(
    (step) => step.run === 'npm test' && step.env?.SITE_BASE === configuredBase,
  );
  const provenance = steps.findIndex(
    (step) => step.run === 'node scripts/write-build-info.mjs',
  );
  const upload = steps.indexOf(
    action(publish.jobs.build, 'actions/upload-pages-artifact'),
  );
  assert.ok(
    configuredBuild >= 0 &&
      configuredTest > configuredBuild &&
      provenance > configuredTest &&
      upload > provenance,
  );
  assert.equal(steps[upload].with.path, 'website/dist/');
  assert.equal(
    steps.slice(configuredTest + 1).filter((step) => /npm/.test(step.run ?? ''))
      .length,
    0,
  );
});

test('Pages deploy uses only the same-run tested artifact with scoped OIDC', () => {
  const job = publish.jobs.deploy;
  assert.deepEqual([job.needs].flat(), ['build']);
  assert.doesNotMatch(job.if, /always\(|failure\(|cancelled\(/);
  assert.deepEqual(job.permissions, { pages: 'write', 'id-token': 'write' });
  assert.equal(job.environment.name, 'github-pages');
  const upload = action(publish.jobs.build, 'actions/upload-pages-artifact');
  const deploy = action(job, 'actions/deploy-pages');
  assert.equal(deploy.with.artifact_name, upload.with.name);
  assert.match(upload.with.name, /github\.run_id/);
  assert.match(upload.with.name, /github\.run_attempt/);
  assert.doesNotMatch(
    JSON.stringify(job.steps),
    /checkout|npm|deploy_key|secrets\.|external_repository/,
  );
});

test('state records the same plan only after successful deployment; failures remain retryable', () => {
  const state = publish.jobs['record-state'];
  assert.deepEqual(state.needs, ['build', 'deploy']);
  // With no status override, Actions requires success of all needed jobs.
  assert.doesNotMatch(state.if, /always\(|failure\(|cancelled\(/);
  assert.deepEqual(state.permissions, { contents: 'write' });
  const upload = action(publish.jobs.resolve, 'actions/upload-artifact');
  assert.equal(upload.with.path, '.sync/plan.json');
  assert.equal(upload.with['include-hidden-files'], true);
  assert.equal(upload.with['if-no-files-found'], 'error');
  for (const job of [publish.jobs.build, state]) {
    const download = action(job, 'actions/download-artifact');
    assert.equal(download.with.name, upload.with.name);
    assert.equal(download.with.path, '.sync');
    assert.equal(download.with['run-id'], undefined);
    assert.equal(download.with.repository, undefined);
  }
  const downloadIndex = state.steps.indexOf(
    action(state, 'actions/download-artifact'),
  );
  const recordIndex = state.steps.findIndex(
    (step) => step.run === 'node scripts/record-deployment.mjs',
  );
  assert.ok(recordIndex > downloadIndex);
  assert.doesNotMatch(
    JSON.stringify(state.steps),
    /npm|write-build-info|check-upstream/,
  );
  for (const [name, job] of Object.entries(publish.jobs)) {
    if (name === 'record-state') continue;
    assert.doesNotMatch(JSON.stringify(job.steps), /record-deployment/);
    assert.notEqual(job.permissions?.contents, 'write');
  }
});
