import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as engine from '../dist/engine.js';

const appURL = new URL('../dist/app.js', import.meta.url);
// Run the application with its real engine and controlled DOM/Worker boundaries.
const source = (await readFile(appURL, 'utf8'))
  .replace(/^import .* from .*;\r?\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(appURL.href));

class Element extends EventTarget {
  constructor() {
    super();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.classes = new Set();
    this.classList = {
      contains: name => this.classes.has(name),
      toggle: (name, force = !this.classes.has(name)) => {
        if (force) this.classes.add(name); else this.classes.delete(name);
        return force;
      },
    };
  }
  setAttribute() {}
  append() {}
  replaceChildren() {}
  insertBefore() {}
  click() {}
}

function startApp(options = {}) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const fields = Object.entries(engine.DEFAULT_CONFIG).map(([key, value]) => {
    const field = new Element();
    Object.assign(field, { dataset: { config: key }, type: typeof value === 'boolean' ? 'checkbox' : 'number', value: String(value), checked: value });
    return field;
  });
  const form = get('configuration');
  form.querySelectorAll = () => fields;
  form.elements = Object.fromEntries(fields.map(field => [field.dataset.config, field]));
  const workers = [];
  const centers = [];
  const lineCharts = [];
  class Worker {
    constructor() { workers.push(this); }
    postMessage(message) { this.request = message; }
    terminate() { this.terminated = true; }
    complete() {
      const { config, requestId } = this.request;
      const samples = [engine.compactSample(engine.snapshot(config))];
      this.onmessage({ data: { type: 'result', requestId, config, samples, summary: engine.summarize(samples, config) } });
    }
  }
  const createdElements = [];
  const document = Object.assign(new EventTarget(), {
    getElementById: get, querySelector: get,
    createElement: tag => { const el = new Element(); el.tagName = tag; createdElements.push(el); return el; },
    createTextNode: text => text,
    createDocumentFragment: () => new Element(),
  });
  const location = { href: options.href || 'https://example.test/comm-nav', hash: options.hash || '' };
  const historyCalls = [];
  const history = {
    replaceState: (state, title, url) => {
      historyCalls.push(url);
      location.href = url;
      location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
    },
  };
  const clipboard = { text: null, fail: options.clipboardFails || false };
  const navigator = {
    clipboard: {
      writeText: text => clipboard.fail ? Promise.reject(new Error('denied')) : (clipboard.text = text, Promise.resolve()),
    },
  };
  runInNewContext(source, {
    ...engine, document,
    window: { matchMedia: () => ({ matches: false }) },
    location, history, navigator,
    Globe: class { set() {} center(lat, lon) { centers.push([lat, lon]); } draw() {} },
    skyPlot() {}, lineChart: (...args) => lineCharts.push(args),
    ResizeObserver: class { observe() {} },
    Worker, URL, Blob, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const submit = () => {
    const event = new Event('submit', { cancelable: true });
    form.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, 'form submission must not reload the page');
  };
  const click = id => get(id).dispatchEvent(new Event('click'));
  return { get, form, workers, submit, click, centers, location, historyCalls, clipboard, createdElements, lineCharts };
}

test('submitting settings reruns analysis with the latest input and opens the results', () => {
  const { get, form, workers, submit } = startApp();
  workers[0].complete();
  form.elements.altitude.value = '1280';
  submit();
  assert.equal(workers.length, 2);
  assert.equal(workers[1].request.config.altitude, 1280);
  assert.equal(get('analysis').hidden, false);
  assert.equal(get('run-analysis').disabled, true);
  workers[1].complete();
  assert.equal(get('run-analysis').disabled, false);
  assert.equal(get('export-csv').disabled, false);
  assert.equal(workers[1].terminated, true);
});

test('submitting while analysis is running neither reloads nor starts a second worker', () => {
  const { get, form, workers, submit } = startApp();
  get('config-error').hidden = true;
  form.elements.altitude.value = '';
  submit();
  assert.equal(workers.length, 1);
  assert.equal(get('config-error').hidden, true, 'duplicate submissions must not validate or change the active scenario');
  workers[0].complete();
});

test('invalid form input reports an error without starting another analysis', async () => {
  const { get, form, workers, submit } = startApp();
  workers[0].complete();
  form.elements.altitude.value = '';
  submit();
  await Promise.resolve();
  assert.equal(workers.length, 1);
  assert.equal(get('config-error').hidden, false);
  assert.match(get('config-error').textContent, /altitude/);
  assert.equal(get('run-analysis').disabled, false);
});

test('a failed analysis restores the controls and allows a retry', async () => {
  const { get, workers, submit } = startApp();
  workers[0].complete();
  submit();
  workers[1].onerror();
  await Promise.resolve();
  assert.equal(workers[1].terminated, true);
  assert.equal(get('run-analysis').disabled, false);
  assert.equal(get('analysis-progress').hidden, true);
  assert.equal(get('config-error').hidden, false);
  submit();
  assert.equal(workers.length, 3);
  workers[2].complete();
});

test('custom observer and constellation settings reach analysis and recenter the globe', () => {
  const { get, form, workers, submit, centers } = startApp();
  workers[0].complete();
  form.elements.location.value = 'custom';
  form.elements.latitude.value = '-33.87';
  form.elements.longitude.value = '151.21';
  form.elements.planes.value = '7';
  form.elements.satellitesPerPlane.value = '12';
  submit();
  assert.equal(get('custom-location').hidden, false);
  assert.equal(form.elements.latitude.disabled, false);
  assert.deepEqual(centers.at(-1), [-33.87, 151.21]);
  assert.equal(workers[1].request.config.satellitesPerPlane, 12);
  assert.equal(get('fleet-count').textContent, 'LEO 84기');
  workers[1].complete();
  assert.match(get('analysis-note').textContent, /-33.87°, 151.21°/);
  form.elements.latitude.value = '-20';
  submit();
  assert.deepEqual(centers.at(-1), [-20, 151.21]);
  assert.equal(get('analysis-note').classList.contains('stale'), true);
  workers[2].complete();
  assert.match(get('analysis-note').textContent, /-20°, 151.21°/);
  form.elements.location.value = 'seoul';
  submit();
  assert.equal(get('custom-location').hidden, true);
  assert.equal(form.elements.latitude.disabled, true);
  assert.deepEqual(centers.at(-1), [37.5665, 126.978]);
  workers[3].complete();
});

test('an excessive constellation reports an error and preserves the last valid result', async () => {
  const { get, form, workers, submit } = startApp();
  workers[0].complete();
  form.elements.planes.value = '32';
  form.elements.satellitesPerPlane.value = '32';
  submit();
  await Promise.resolve();
  assert.equal(workers.length, 1);
  assert.match(get('config-error').textContent, /512/);
  assert.equal(get('fleet-count').textContent, 'LEO 256기');
});

test('a shared-link hash restores the scenario into the form and worker requests', () => {
  const hash = '#cfg=' + encodeURIComponent(JSON.stringify({ altitude: 1280, planes: 6, satellitesPerPlane: 6 }));
  const { form, workers } = startApp({ hash });
  assert.equal(form.elements.altitude.value, '1280');
  assert.equal(form.elements.planes.value, '6');
  workers[0].complete();
  assert.equal(workers[0].request.config.altitude, 1280);
});

test('an invalid shared-link hash is ignored and falls back to defaults', () => {
  const { form, workers } = startApp({ hash: '#cfg=' + encodeURIComponent(JSON.stringify({ altitude: 99999 })) });
  assert.equal(form.elements.altitude.value, String(engine.DEFAULT_CONFIG.altitude));
  workers[0].complete();
});

test('malformed hash content does not throw during startup', () => {
  const { form } = startApp({ hash: '#cfg=not-json' });
  assert.equal(form.elements.altitude.value, String(engine.DEFAULT_CONFIG.altitude));
});

test('sharing copies a compact link containing only the changed settings', async () => {
  const { form, submit, workers, click, clipboard, historyCalls, location } = startApp();
  workers[0].complete();
  form.elements.altitude.value = '1280';
  submit();
  workers[1].complete();
  click('share-config');
  await Promise.resolve();
  const encoded = clipboard.text.split('cfg=')[1];
  const diff = JSON.parse(decodeURIComponent(encoded));
  assert.deepEqual(diff, { altitude: 1280 });
  assert.equal(historyCalls.length, 1);
  assert.equal(location.hash, '#cfg=' + encodeURIComponent(JSON.stringify({ altitude: 1280 })));
});

test('sharing the default scenario produces a link with no hash', async () => {
  const { workers, click, clipboard } = startApp();
  workers[0].complete();
  click('share-config');
  await Promise.resolve();
  assert.ok(!clipboard.text.includes('#'));
});

test('switching the sweep axis updates the trade-study intro text', () => {
  const { get, workers, submit, click } = startApp();
  workers[0].complete();
  submit();
  assert.match(get('sweep-intro').textContent, /항법 시간을 0–40%/);
  get('sweep-axis').value = 'altitude';
  get('sweep-axis').dispatchEvent(new Event('change'));
  assert.match(get('sweep-intro').textContent, /궤도 고도를 400–2,000 km/);
  workers[1].complete();
});

test('changing navShare invalidates the cached altitude sweep instead of serving stale points', () => {
  const { get, form, workers, submit, lineCharts } = startApp();
  workers[0].complete();
  form.elements.sharing.value = 'time';
  form.elements.navShare.value = '0';
  submit();
  workers[1].complete();
  get('sweep-axis').value = 'altitude';
  get('sweep-axis').dispatchEvent(new Event('change'));
  const rateChartEl = get('resource-rate-chart');
  const latestRatePoints = () => lineCharts.filter(call => call[0] === rateChartEl).at(-1)[1];

  const before = latestRatePoints();
  assert.equal(before.length, 17);
  assert.ok(before.every(p => !p.unavailable), 'all 17 altitude sweep points should be available');
  assert.equal(before[0].altitude, 400);
  assert.ok(Math.abs(before[0].rate - 345.987) < 0.01, `expected ~345.987 Mbps at navShare=0, got ${before[0].rate}`);

  form.elements.navShare.value = '40';
  submit();

  const after = latestRatePoints();
  assert.notStrictEqual(after, before, 'the altitude sweep must be recalculated, not served from stale cache');
  assert.equal(after.length, 17);
  assert.ok(after.every(p => !p.unavailable), 'all 17 altitude sweep points should be recalculated and available');
  assert.equal(after[0].altitude, 400);
  assert.ok(Math.abs(after[0].rate - 207.592) < 0.01, `expected ~207.592 Mbps at navShare=40, got ${after[0].rate}`);

  workers[2].complete();
});

test('CSV export writes one row per sample and reuses the same scenario JSON for every row', async () => {
  const { workers, submit, click, createdElements } = startApp();
  workers[0].complete();
  submit();
  workers[1].complete();
  click('export-csv');
  const anchor = createdElements.filter(el => el.tagName === 'a').at(-1);
  assert.ok(anchor, 'export must create a download link');
  assert.ok(anchor.download.startsWith('KLEO_COMM_PNT_'));
  assert.ok(anchor.href.startsWith('blob:'));
  const csv = await (await fetch(anchor.href)).text();
  const lines = csv.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  const parseRow = line => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(m => m[1].replaceAll('""', '"'));
  const header = parseRow(lines[0]);
  assert.equal(header[0], 'model_version');
  assert.equal(header.at(-1), 'scenario_config_json');
  const dataRows = lines.slice(1).map(parseRow);
  assert.equal(dataRows.length, 1); // the fake worker in this harness returns exactly one sample
  const configs = dataRows.map(row => JSON.parse(row.at(-1)));
  assert.ok(configs.every(cfg => cfg.altitude === workers[1].request.config.altitude), 'every row must carry the same scenario config that produced it');
});

test('a clipboard failure still updates the address bar and reports the problem', async () => {
  const { workers, click, get, historyCalls } = startApp({ clipboardFails: true });
  workers[0].complete();
  click('share-config');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(historyCalls.length, 1);
  assert.match(get('share-status').textContent, /실패/);
});
