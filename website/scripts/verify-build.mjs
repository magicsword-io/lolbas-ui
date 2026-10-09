import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  loadCatalog,
  toApi,
  toCsv,
  toNavigator,
  toBadge,
  websiteRoot,
} from './prepare-data.mjs';

const dist = resolve(websiteRoot, process.argv[2] ?? 'dist');
const catalog = await loadCatalog();
const json = async (path) =>
  JSON.parse(await readFile(join(dist, path), 'utf8'));
assert.deepEqual(
  await json('api/lolbas.json'),
  toApi(catalog),
  'JSON API must preserve legacy fields and all canonical entries',
);
assert.equal(
  await readFile(join(dist, 'api/lolbas.csv'), 'utf8'),
  toCsv(catalog),
  'CSV must include each command with the legacy 17-column representation',
);
assert.deepEqual(
  await json('mitre_attack_navigator_layer.json'),
  toNavigator(catalog),
  'Navigator must aggregate all command techniques',
);
assert.equal(
  await readFile(join(dist, 'assets/lolbas-count.svg'), 'utf8'),
  toBadge(catalog.length),
);
await access(join(dist, 'index.html'));
await access(join(dist, 'LICENSE.txt'));
await access(join(dist, 'UPSTREAM_NOTICE.md'));
const base = (process.env.SITE_BASE || '/').replace(/\/$/, '');
const site = process.env.SITE_URL || 'https://magicsword-io.github.io';
const checkCanonical = (html, path) => {
  const expected = new URL(`${base}${path}`, site).href;
  assert.ok(
    html.includes(`rel="canonical" href="${expected}"`),
    `${path} must have the independent site's canonical URL: ${expected}`,
  );
};
for (const path of ['/', '/about/', '/api/', '/insights/'])
  checkCanonical(await readFile(join(dist, path, 'index.html'), 'utf8'), path);
for (const entry of catalog) {
  const html = await readFile(join(dist, entry.url, 'index.html'), 'utf8');
  checkCanonical(html, entry.url);
  assert.ok(html.includes(entry.Name), `${entry.url} must show ${entry.Name}`);
  assert.ok(
    html.includes(entry.source),
    `${entry.url} must link its canonical source`,
  );
}
console.log(
  `Verified ${catalog.length} legacy detail routes, JSON API, CSV command rows, Navigator and count badge in ${dist}.`,
);
