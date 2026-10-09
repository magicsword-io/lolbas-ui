import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseEntry,
  loadCatalog,
  toApi,
  toCsv,
  toNavigator,
  apiKeys,
  csvHeader,
  collections,
} from '../scripts/prepare-data.mjs';

const fixture = `Name: Example.exe
Description: 'A "quoted", description'
Author: Example Author
Created: 2020-01-02
Commands:
  - Command: |-
      example.exe "first,second"
      next line
    Description: A command
    Usecase: Example
    Category: Execute
    Privileges: User
    MitreID: T1218.001
    OperatingSystem: Windows 11
    Tags:
      - Application: 'GUI, "quoted"'
      - Network: Remote
Acknowledgement:
  - Person: Example
    Handle: '@example'
`;
const record = () =>
  parseEntry(fixture, 'yml/OSBinaries/Example.yml', 'Binaries', 'Example');

// Independent parser makes commas, embedded quotes and multiline cells observable.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  assert.equal(quoted, false, 'CSV quotes must close');
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

test('legacy JSON has exact keys, null missing fields, original command fields, and canonical URL', () => {
  const entry = record();
  const [api] = toApi([entry]);
  assert.deepEqual(Object.keys(api), apiKeys);
  assert.equal(api.Created, '2020-01-02');
  assert.equal(api.Full_Path, null);
  assert.equal(api.Detection, null);
  assert.equal(api.Resources, null);
  assert.deepEqual(api.Commands, entry.Commands);
  assert.equal(
    api.url,
    'https://lolbas-project.github.io/lolbas/Binaries/Example/',
  );
  assert.ok(!('Acknowledgement' in api));
  assert.ok(!('source' in api));
});

test('CSV preserves 17 legacy columns and round trips multiline commands, quotes, commas and tags', () => {
  const [header, row] = parseCsv(toCsv([record()]));
  assert.deepEqual(header, csvHeader);
  assert.equal(row.length, 17);
  assert.equal(row[1], 'A "quoted", description');
  assert.equal(row[4], 'example.exe "first,second"\nnext line');
  assert.equal(row[14], 'Example (@example)');
  assert.equal(row[16], 'Application:GUI, "quoted",Network:Remote');
  assert.equal(row[11], '');
});

test('rejects malformed YAML, duplicate keys, invalid command shape and unsafe route IDs', () => {
  for (const text of [
    'Name: [',
    fixture + '\nName: Duplicate',
    fixture.replace('Category: Execute', 'Category: [Execute]'),
    fixture.replace('MitreID: T1218.001', 'MitreID: invalid'),
  ]) {
    assert.throws(
      () => parseEntry(text, 'bad.yml', 'Binaries', 'Example'),
      /bad.yml:/,
    );
  }
  assert.throws(
    () => parseEntry(fixture, 'bad.yml', 'Binaries', '../escape'),
    /filename/,
  );
});

test('collection mapping excludes HonorableMentions and duplicate binary filenames fail before generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lolbas-data-'));
  try {
    for (const folder of [...Object.keys(collections), 'HonorableMentions'])
      await mkdir(join(root, folder));
    await writeFile(join(root, 'OSBinaries/Example.yml'), fixture);
    await writeFile(
      join(root, 'HonorableMentions/Ignored.yml'),
      'malformed: [',
    );
    assert.equal((await loadCatalog(root)).length, 1);
    await writeFile(join(root, 'OtherMSBinaries/eXample.yml'), fixture);
    await assert.rejects(
      loadCatalog(root),
      /duplicate binary filename.*OSBinaries\/Example.yml/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extension gate rejects .yaml, uppercase .YML and unrelated files even in unpublished collections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lolbas-extension-'));
  try {
    for (const folder of [
      ...Object.keys(collections),
      'HonorableMentions',
      'FutureCollection',
    ])
      await mkdir(join(root, folder));
    await writeFile(join(root, 'OSBinaries/Example.yml'), fixture);
    for (const path of [
      'OSBinaries/Bad.yaml',
      'OSLibraries/Bad.YML',
      'HonorableMentions/Bad.txt',
      'FutureCollection/Bad.json',
      'Bad.md',
    ]) {
      await writeFile(join(root, path), fixture);
      await assert.rejects(
        loadCatalog(root),
        /unexpected extension; use '.yml'/,
      );
      await rm(join(root, path));
    }
    assert.equal((await loadCatalog(root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('distinct binary names and matching library stems are valid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lolbas-names-'));
  try {
    for (const folder of Object.keys(collections))
      await mkdir(join(root, folder));
    for (const path of [
      'OSBinaries/Example.yml',
      'OtherMSBinaries/Another.yml',
      'OSLibraries/Example.yml',
    ])
      await writeFile(join(root, path), fixture);
    assert.equal((await loadCatalog(root)).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extension validation is recursive and published collections cannot hide nested entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lolbas-nested-'));
  try {
    for (const folder of [
      ...Object.keys(collections),
      'HonorableMentions/nested/deeper',
    ])
      await mkdir(join(root, folder), { recursive: true });
    await writeFile(join(root, 'OSBinaries/Example.yml'), fixture);
    await writeFile(
      join(root, 'HonorableMentions/nested/deeper/Bad.txt'),
      fixture,
    );
    await assert.rejects(
      loadCatalog(root),
      /HonorableMentions\/nested\/deeper\/Bad.txt: unexpected extension/,
    );
    await rm(join(root, 'HonorableMentions/nested/deeper/Bad.txt'));
    await writeFile(
      join(root, 'HonorableMentions/nested/deeper/Allowed.yml'),
      fixture,
    );
    assert.equal((await loadCatalog(root)).length, 1);
    for (const folder of Object.keys(collections)) {
      await mkdir(join(root, folder, 'nested'));
      await writeFile(join(root, folder, 'nested/Hidden.yml'), fixture);
      await assert.rejects(
        loadCatalog(root),
        /nested directories are not supported in published collections/,
      );
      await rm(join(root, folder, 'nested'), { recursive: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Created rejects impossible dates and accepts leap dates', () => {
  for (const date of [
    '2023-02-29',
    '2020-02-30',
    '2020-13-01',
    '2020-00-01',
    '2020-1-02',
  ]) {
    assert.throws(
      () =>
        parseEntry(
          fixture.replace('2020-01-02', date),
          'bad.yml',
          'Binaries',
          'Example',
        ),
      /valid calendar date/,
    );
  }
  assert.equal(
    parseEntry(
      fixture.replace('2020-01-02', '2020-02-29'),
      'good.yml',
      'Binaries',
      'Example',
    ).Created,
    '2020-02-29',
  );
});

test('Navigator aggregates every command and marks parents with subtechniques', () => {
  const entry = record();
  entry.Commands.push(
    { ...entry.Commands[0], MitreID: 'T1218' },
    { ...entry.Commands[0] },
  );
  const layer = toNavigator([entry]);
  assert.deepEqual(layer.techniques, [
    { techniqueID: 'T1218', score: 1, showSubtechniques: true },
    { techniqueID: 'T1218.001', score: 2 },
  ]);
  assert.equal(layer.gradient.maxValue, 2);
});

test('canonical source produces a deterministic API and one CSV row per command', async () => {
  const catalog = await loadCatalog();
  const rows = parseCsv(toCsv(catalog));
  assert.ok(catalog.length > 200);
  assert.equal(new Set(catalog.map((entry) => entry.url)).size, catalog.length);
  assert.equal(
    rows.length - 1,
    catalog.reduce((sum, entry) => sum + entry.Commands.length, 0),
  );
  assert.ok(rows.every((row) => row.length === 17));
  assert.deepEqual(catalog, await loadCatalog());
  assert.ok(
    catalog.some((entry) => entry.url === '/lolbas/Libraries/comsvcs/'),
  );
  assert.ok(
    catalog.every((entry) => !entry.source.includes('HonorableMentions')),
  );
});

test('UI-SYNC-002 resolves ignored upstream YAML by default and explicit source overrides', () => {
  const script = new URL('../scripts/prepare-data.mjs', import.meta.url).href;
  const readRoot = (override) => {
    const env = { ...process.env };
    delete env.LOLBAS_SOURCE_DIR;
    if (override) env.LOLBAS_SOURCE_DIR = override;
    return execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { sourceRoot } from ${JSON.stringify(script)}; console.log(sourceRoot);`,
      ],
      { env, encoding: 'utf8' },
    ).trim();
  };
  assert.equal(
    readRoot(),
    new URL('../../.upstream/yml', import.meta.url).pathname,
  );
  assert.equal(
    readRoot('./custom-upstream/yml'),
    resolve('./custom-upstream/yml'),
  );
});

test('UI-SYNC-002 rejects source root, collection, entry and unpublished symlinks', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'lolbas-symlink-'));
  const root = join(temp, 'yml');
  try {
    for (const folder of [...Object.keys(collections), 'HonorableMentions'])
      await mkdir(join(root, folder), { recursive: true });
    await writeFile(join(root, 'OSBinaries/Example.yml'), fixture);
    await writeFile(join(temp, 'outside.yml'), fixture);
    assert.equal((await loadCatalog(root)).length, 1);
    await symlink(root, join(temp, 'root-link'));
    await assert.rejects(loadCatalog(join(temp, 'root-link')), /symbolic link/);
    for (const path of [
      'OSBinaries/Linked.yml',
      'HonorableMentions/Linked.yml',
      'LinkedCollection',
    ]) {
      await symlink(join(temp, 'outside.yml'), join(root, path));
      await assert.rejects(loadCatalog(root), /symbolic links are not allowed/);
      await rm(join(root, path));
    }
    await rm(join(root, 'OSLibraries'), { recursive: true });
    await symlink(join(root, 'OSBinaries'), join(root, 'OSLibraries'));
    await assert.rejects(loadCatalog(root), /symbolic links are not allowed/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('UI-SYNC-002 linked source fields reject unsafe schemes and malformed URLs', () => {
  for (const field of [
    'Resources:\n  - Link:',
    'Detection:\n  - Sigma:',
    'Code_Sample:\n  - Code:',
  ]) {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'https://',
      'https://good.example/ bad',
    ]) {
      assert.throws(
        () =>
          parseEntry(
            `${fixture}\n${field} ${JSON.stringify(value)}\n`,
            'bad.yml',
            'Binaries',
            'Example',
          ),
        /absolute HTTP\(S\) URL/,
      );
    }
    for (const value of [
      'https://example.com/path?x=1&y=2',
      'http://example.com/',
    ])
      assert.doesNotThrow(() =>
        parseEntry(
          `${fixture}\n${field} ${JSON.stringify(value)}\n`,
          'good.yml',
          'Binaries',
          'Example',
        ),
      );
  }
  assert.doesNotThrow(() =>
    parseEntry(
      `${fixture}\nDetection:\n  - IOC: Suspicious process with arguments\nCode_Sample:\n  - Code: 'print("example")'\n`,
      'good.yml',
      'Binaries',
      'Example',
    ),
  );
  for (const extra of [
    'Resources: [{Other: value}]',
    'Code_Sample: [{Code: 42}]',
    'Aliases: [{Alias: [nested]}]',
    'Detection: [{Sigma: [nested]}]',
  ])
    assert.throws(
      () =>
        parseEntry(`${fixture}\n${extra}\n`, 'bad.yml', 'Binaries', 'Example'),
      /bad.yml:/,
    );
});

test('UI-SYNC-002 rejects excessive YAML alias expansion', () => {
  const aliases = Array(101).fill('*payload').join(', ');
  assert.throws(
    () =>
      parseEntry(
        `${fixture}\npayload: &payload [one, two]\nexpanded: [${aliases}]\n`,
        'bad.yml',
        'Binaries',
        'Example',
      ),
    /alias|resource exhaustion/i,
  );
});

test(
  'UI-SYNC-002 rejects a source FIFO before trying to read it',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'lolbas-fifo-'));
    try {
      for (const folder of Object.keys(collections))
        await mkdir(join(root, folder));
      await writeFile(join(root, 'OSBinaries/Example.yml'), fixture);
      assert.equal((await loadCatalog(root)).length, 1);
      execFileSync('mkfifo', [join(root, 'OSBinaries/Pipe.yml')]);
      await assert.rejects(
        loadCatalog(root),
        /only regular files and directories/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('UI-SYNC-002 IOC text stays text but linked IOC URLs are validated', () => {
  for (const value of ['https://', 'http://example.com/ bad'])
    assert.throws(
      () =>
        parseEntry(
          `${fixture}\nDetection:\n  - IOC: ${JSON.stringify(value)}\n`,
          'bad.yml',
          'Binaries',
          'Example',
        ),
      /absolute HTTP\(S\) URL/,
    );
  for (const value of ['javascript:alert(1)', 'https://example.com/indicator'])
    assert.doesNotThrow(() =>
      parseEntry(
        `${fixture}\nDetection:\n  - IOC: ${JSON.stringify(value)}\n`,
        'good.yml',
        'Binaries',
        'Example',
      ),
    );
});
