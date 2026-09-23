import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as engine from '../dist/engine.js';

const source = (await readFile(new URL('../dist/analysis-worker.js', import.meta.url), 'utf8'))
  .replace(/^import .* from .*;\r?\n/gm, '');

function runWorker(config, requestId = 1) {
  const messages = [];
  let receive;
  runInNewContext(source, { ...engine, self: {
    addEventListener: (type, handler) => { receive = handler; },
    postMessage: message => messages.push(message),
  } });
  receive({ data: { config, requestId } });
  return messages;
}

test('24-hour worker analyzes a custom observer and constellation with exportable configuration', () => {
  const config = { ...engine.DEFAULT_CONFIG, location: 'custom', latitude: -33.87, longitude: 151.21, planes: 7, satellitesPerPlane: 12 };
  const messages = runWorker(config, 42);
  const result = messages.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.requestId, 42);
  assert.equal(result.samples.length, 288);
  assert.equal(result.samples.at(-1).minutes, 1435);
  assert.deepEqual(result.config, config);
  assert.deepEqual(result.samples[0], engine.compactSample(engine.snapshot(config)));
  assert.equal(result.summary.samples, 288);
  assert.equal(result.modelVersion, '1.1.0');
  assert.ok(messages.some(message => message.type === 'progress'));
});

test('worker honors a configured periodMinutes/stepMinutes instead of the fixed 24h/5min default', () => {
  const config = { ...engine.DEFAULT_CONFIG, periodMinutes: 60, stepMinutes: 10 };
  const result = runWorker(config).at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.samples.length, 6); // 60 / 10
  // Cross-realm arrays (samples were built inside the vm context) compare unequal under strict
  // deepEqual purely on prototype identity, so compare the plain minute values one at a time.
  assert.equal(JSON.stringify([...result.samples].map(s => s.minutes)), JSON.stringify([0, 10, 20, 30, 40, 50]));
  assert.equal(result.summary.samples, 6);
  assert.equal(result.summary.stepMinutes, 10);
});

test('worker reports a validation error, not a crash, for a step that does not evenly divide the period', () => {
  const config = { ...engine.DEFAULT_CONFIG, periodMinutes: 100, stepMinutes: 7 };
  const messages = runWorker(config);
  const result = messages.at(-1);
  assert.equal(result.type, 'error');
  assert.match(result.message, /나누어 떨어져야/);
});
