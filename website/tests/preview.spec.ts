import { test, expect } from '@playwright/test';
import { sourceSnapshot } from '../scripts/prepare-data.mjs';

test('UI-SITE-001 independent hosted preview keeps navigation, assets and data under its base path', async ({
  page,
  request,
  context,
}) => {
  const base = process.env.SITE_BASE!.replace(/\/$/, '');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(response.url());
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${base}/`);
  const site = process.env.SITE_URL || 'https://magicsword-io.github.io';
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    new URL(`${base}/`, site).href,
  );
  await expect(
    page.getByRole('heading', {
      name: 'Living Off The Land Binaries, Scripts and Libraries',
    }),
  ).toBeVisible();
  expect(
    await page
      .locator('.brand-logo')
      .evaluate((img) => (img as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  for (const path of await page
    .locator('a[href^="/"], img[src^="/"], link[href^="/"]')
    .evaluateAll((nodes) =>
      nodes.map(
        (node) => node.getAttribute('href') || node.getAttribute('src')!,
      ),
    ))
    expect(path.startsWith(`${base}/`)).toBeTruthy();
  await page.getByRole('searchbox').fill('certutil');
  await expect(page.locator('[data-row]:visible')).toHaveCount(1);
  await page.locator('.entry-name:visible').click();
  await expect(page).toHaveURL(new RegExp(`${base}/lolbas/Binaries/Certutil/`));
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    new URL(`${base}/lolbas/Binaries/Certutil/`, site).href,
  );
  const snapshot = await sourceSnapshot();
  await expect(page.getByRole('link', { name: 'View source' })).toHaveAttribute(
    'href',
    `https://github.com/LOLBAS-Project/LOLBAS/blob/${snapshot.revision}/yml/OSBinaries/Certutil.yml`,
  );
  const copy = page.locator('[data-copy]').first();
  const command = await copy.getAttribute('data-copy');
  await copy.click();
  await expect(copy).toHaveText('Copied ✓');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    command,
  );
  await page.getByRole('link', { name: 'Insights', exact: true }).click();
  await page.locator('.growth-chart a').last().click();
  await expect(page).toHaveURL(new RegExp(`${base}/\\?year=`));
  await expect(page.locator('#year-filter')).toContainText('Created in');
  await page.getByRole('link', { name: 'API', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Copy JSON API command' }),
  ).toHaveAttribute(
    'data-copy',
    `curl ${new URL(`${base}/api/lolbas.json`, site)}`,
  );
  await page.locator('.endpoint').first().click();
  await expect(page).toHaveURL(new RegExp(`${base}/api/lolbas.json`));
  const response = await request.get(`${base}/api/lolbas.json`);
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  expect(data.find((entry: any) => entry.Name === 'Certutil.exe').url).toBe(
    'https://lolbas-project.github.io/lolbas/Binaries/Certutil/',
  );
  expect(errors).toEqual([]);
});
