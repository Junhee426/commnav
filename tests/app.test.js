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
}

function startApp() {
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
  const document = Object.assign(new EventTarget(), {
    getElementById: get, querySelector: get,
    createElement: () => new Element(), createTextNode: text => text,
    createDocumentFragment: () => new Element(),
  });
  runInNewContext(source, {
    ...engine, document,
    window: { matchMedia: () => ({ matches: false }) },
    Globe: class { set() {} center() {} draw() {} },
    skyPlot() {}, lineChart() {},
    ResizeObserver: class { observe() {} },
    Worker, URL, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const submit = () => {
    const event = new Event('submit', { cancelable: true });
    form.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, 'form submission must not reload the page');
  };
  return { get, form, workers, submit };
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
