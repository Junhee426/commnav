import { test as base, expect } from '@playwright/test';

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(page);
    expect(errors, 'the real application must not throw browser errors').toEqual([]);
  },
});

async function waitForAnalysis(page) {
  await expect(page.locator('#run-status')).toContainText('완료');
  await expect(page.locator('#run-analysis')).toBeEnabled();
  await expect(page.locator('#export-csv')).toBeEnabled();
  await expect(page.locator('#config-error')).toBeHidden();
}

function configInUrl(url) {
  const hash = new URL(url).hash;
  return hash ? JSON.parse(decodeURIComponent(hash.slice('#cfg='.length))) : {};
}

async function readCsvDownload(page) {
  const pending = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const download = await pending;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/^\ufeff/, '').trim().split('\r\n')
    .map(line => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replaceAll('""', '"')));
}

test('shared settings survive real HTML controls, module Worker analysis, and a URL round trip', async ({ page }) => {
  const expected = { altitude: 900, payloadPercent: 33, navShare: 10.5, sharing: 'time' };
  const pendingWorker = page.waitForEvent('worker');
  await page.goto('/#cfg=' + encodeURIComponent(JSON.stringify(expected)));
  expect((await pendingWorker).url()).toMatch(/\/analysis-worker\.js$/);
  await waitForAnalysis(page);

  for (const [key, value] of Object.entries(expected)) {
    await expect(page.locator(`[data-config="${key}"]`)).toHaveValue(String(value));
  }
  expect(await page.locator('#configuration').evaluate(form => form.checkValidity())).toBe(true);

  await page.locator('#tab-analysis').click();
  const [header, ...rows] = await readCsvDownload(page);
  expect(rows).toHaveLength(288);
  const minutes = header.indexOf('elapsed_minutes');
  expect(rows[0][minutes]).toBe('0');
  expect(rows.at(-1)[minutes]).toBe('1435');
  const configColumn = header.indexOf('scenario_config_json');
  for (const row of rows) expect(JSON.parse(row[configColumn])).toMatchObject(expected);

  await page.locator('#share-config').click();
  await expect(page.locator('#share-status')).toContainText('복사했습니다');
  expect(configInUrl(page.url())).toEqual(expected);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  await page.reload();
  await waitForAnalysis(page);
  for (const [key, value] of Object.entries(expected)) {
    await expect(page.locator(`[data-config="${key}"]`)).toHaveValue(String(value));
  }
});

test('sharing commits an input before its debounce runs and rejects an invalid draft', async ({ page }) => {
  await page.goto('/');
  await waitForAnalysis(page);
  // Keep both DOM events in one browser task so the 90 ms timer cannot hide the regression.
  await page.evaluate(() => {
    const altitude = document.querySelector('[data-config="altitude"]');
    altitude.value = '1280';
    altitude.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('share-config').click();
  });
  await expect(page.locator('#share-status')).toContainText('복사했습니다');
  expect(configInUrl(page.url())).toEqual({ altitude: 1280 });
  const sharedUrl = page.url();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sharedUrl);

  await page.evaluate(() => {
    const altitude = document.querySelector('[data-config="altitude"]');
    altitude.value = '';
    altitude.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('share-config').click();
  });
  await expect(page.locator('#config-error')).toBeVisible();
  expect(page.url()).toBe(sharedUrl);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sharedUrl);
});

test('isolated valid navigation samples remain visible after a real analysis', async ({ page }) => {
  await page.goto('/');
  await waitForAnalysis(page);
  await page.locator('[data-config="navElevation"]').fill('56');
  await page.locator('#run-analysis').click();
  await waitForAnalysis(page);
  await expect(page.locator('#analysis')).toBeVisible();

  const markers = page.locator('#navigation-chart circle[fill="#48d4f0"]');
  await expect(markers).toHaveCount(6);
  for (const marker of await markers.all()) {
    await expect(marker).toBeVisible();
    const box = await marker.boundingBox();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  }
});
