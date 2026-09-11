import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as engine from '../dist/engine.js';

const source = (await readFile(new URL('../dist/analysis-worker.js', import.meta.url), 'utf8'))
  .replace(/^import .* from .*;\r?\n/gm, '');

test('24-hour worker analyzes a custom observer and constellation with exportable configuration', () => {
  const messages = [];
  let receive;
  runInNewContext(source, { ...engine, self: {
    addEventListener: (type, handler) => { receive = handler; },
    postMessage: message => messages.push(message),
  } });
  const config = { ...engine.DEFAULT_CONFIG, location: 'custom', latitude: -33.87, longitude: 151.21, planes: 7, satellitesPerPlane: 12 };
  receive({ data: { config, requestId: 42 } });
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
