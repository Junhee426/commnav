import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../dist/engine.js';
import { Globe, skyPlot, lineChart } from '../dist/rendering.js';

const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const cfg = { ...engine.DEFAULT_CONFIG };

// --- minimal fake DOM: just enough surface for rendering.js to build SVG trees and
// drive a canvas 2D context, without pulling in a real DOM implementation. ---
class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.attributes = {};
    this.children = [];
    this._textContent = '';
    this._rect = { width: 400, height: 260 };
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = value; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  getBoundingClientRect() { return this._rect; }
  addEventListener() {}
  setPointerCapture() {}
}

class FakeContext2D {
  constructor() { this.calls = []; this.fillStyle = null; this.strokeStyle = null; this.lineWidth = 1; this.globalAlpha = 1; this.font = null; }
  setTransform(...args) { this.calls.push({ method: 'setTransform', args }); }
  clearRect(...args) { this.calls.push({ method: 'clearRect', args }); }
  beginPath() { this.calls.push({ method: 'beginPath', args: [] }); }
  moveTo(...args) { this.calls.push({ method: 'moveTo', args }); }
  lineTo(...args) { this.calls.push({ method: 'lineTo', args }); }
  stroke() { this.calls.push({ method: 'stroke', args: [] }); }
  fill() { this.calls.push({ method: 'fill', args: [] }); }
  // Snapshot fillStyle/globalAlpha at call time so tests can tell which color/opacity
  // a given marker was drawn with, without re-deriving rendering.js's own logic.
  arc(...args) { this.calls.push({ method: 'arc', args, fillStyle: this.fillStyle, globalAlpha: this.globalAlpha }); }
  fillText(...args) { this.calls.push({ method: 'fillText', args, fillStyle: this.fillStyle }); }
  drawImage(...args) { this.calls.push({ method: 'drawImage', args }); }
  createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; }
  putImageData() {}
  getImageData() { return { data: new Uint8ClampedArray(4) }; }
  createRadialGradient() { return { addColorStop() {} }; }
}

function fakeCanvas(width = 300, height = 200) {
  const el = new FakeElement('canvas');
  el._rect = { width, height };
  el.ctx = new FakeContext2D();
  el.getContext = () => el.ctx;
  return el;
}

globalThis.document = {
  createElementNS: (_ns, tag) => new FakeElement(tag),
  createElement: tag => tag === 'canvas' ? fakeCanvas() : new FakeElement(tag),
};
globalThis.window = { devicePixelRatio: 1 };
globalThis.ResizeObserver = class { observe() {} };
// Never fires onload: the Globe's Earth texture stays null, exercising the documented
// solid-color fallback path in background() instead of needing a real image decoder.
globalThis.Image = class { set src(_v) {} };
globalThis.requestAnimationFrame = fn => fn();

// --- skyPlot ---

test('skyPlot draws exactly the elevation-visible, navigation-relevant satellites with the right shape per group', () => {
  const current = engine.snapshot({ ...cfg, regional: true }, 0);
  const container = new FakeElement('div');
  skyPlot(container, current);
  assert.equal(container.children.length, 1);
  const svg = container.children[0];
  assert.equal(svg.tagName, 'svg');
  assert.equal(svg.attributes.role, 'img');

  const visible = current.satellites.filter(s => s.elevation >= 0 && (s.navUsed || s.id === current.best?.id));
  const marks = svg.children.filter(c => c.children.some(ch => ch.tagName === 'title'));
  assert.equal(marks.length, visible.length);
  const shapeFor = { LEO: 'circle', GNSS: 'rect', REGIONAL: 'path' };
  visible.forEach((sat, i) => {
    assert.equal(marks[i].tagName, shapeFor[sat.group]);
    const title = marks[i].children.find(ch => ch.tagName === 'title');
    assert.equal(title.textContent, `${sat.id} · 고도각 ${sat.elevation.toFixed(1)}° · ${sat.range.toFixed(0)} km`);
  });

  // Elevation rings (0/30/60) plus the compass cross are drawn regardless of satellites.
  assert.equal(svg.children.filter(c => c.tagName === 'circle' && c.attributes.r !== undefined && !marks.includes(c)).length >= 3, true);
  assert.equal(svg.children.some(c => c.tagName === 'path' && c.attributes.d?.startsWith('M38')), true);
});

test('skyPlot centers zenith and orients azimuth with north up, east right, per the ENU convention', () => {
  const fakeSnapshot = {
    best: null,
    satellites: [
      { id: 'ZEN', group: 'LEO', navUsed: true, elevation: 90, azimuth: 0, range: 800 },
      { id: 'EAST', group: 'GNSS', navUsed: true, elevation: 0, azimuth: 90, range: 20000 },
      { id: 'NORTH', group: 'REGIONAL', navUsed: true, elevation: 0, azimuth: 0, range: 20000 },
    ],
  };
  const container = new FakeElement('div');
  skyPlot(container, fakeSnapshot);
  const svg = container.children[0];
  const marks = svg.children.filter(c => c.children.some(ch => ch.tagName === 'title'));
  const [zen, east, north] = marks;
  const cx = 155, cy = 149, r = 117;

  assert.equal(zen.tagName, 'circle');
  close(Number(zen.attributes.cx), cx); close(Number(zen.attributes.cy), cy);

  assert.equal(east.tagName, 'rect');
  close(Number(east.attributes.x) + 4, cx + r); close(Number(east.attributes.y) + 4, cy);

  assert.equal(north.tagName, 'path');
  const [, nx, ny] = north.attributes.d.match(/M([-\d.]+) ([-\d.]+)/).map(Number);
  close(nx, cx); close(ny + 5, cy - r);
});

test('skyPlot omits satellites below the horizon or not used for navigation, and highlights the selected link', () => {
  const fakeSnapshot = {
    best: { id: 'BEST' },
    satellites: [
      { id: 'BEST', group: 'LEO', navUsed: false, elevation: 45, azimuth: 10, range: 900 },
      { id: 'BELOW', group: 'LEO', navUsed: true, elevation: -5, azimuth: 10, range: 900 },
      { id: 'UNUSED', group: 'GNSS', navUsed: false, elevation: 40, azimuth: 200, range: 21000 },
    ],
  };
  const container = new FakeElement('div');
  skyPlot(container, fakeSnapshot);
  const svg = container.children[0];
  const marks = svg.children.filter(c => c.children.some(ch => ch.tagName === 'title'));
  assert.equal(marks.length, 1);
  assert.equal(marks[0].children.find(ch => ch.tagName === 'title').textContent.startsWith('BEST'), true);
  // Highlight ring: an extra unmarked (title-less) circle for the chosen satellite.
  assert.equal(svg.children.some(c => c.tagName === 'circle' && !c.children.length && c.attributes.stroke === '#fff'), true);
});

// --- lineChart ---

function points(rows) { return rows.map(([hours, value]) => ({ hours, value })); }

test('lineChart draws one path per series with gridlines, a threshold line, and axis labels', () => {
  const container = new FakeElement('div'); container._rect = { width: 500, height: 260 };
  lineChart(container, points([[0, 10], [6, 40], [12, 20], [18, 30]]), [{ key: 'value', color: '#48d4f0' }],
    { threshold: 25, yLabel: 'Y', xLabel: 'X', title: 'T' });
  const svg = container.children[0];
  assert.equal(svg.attributes['aria-label'], 'T');
  assert.equal(svg.children.filter(c => c.tagName === 'line').length, 6); // 5 gridlines (i=0..4) + threshold
  const path = svg.children.find(c => c.tagName === 'path');
  assert.ok(path.attributes.d.trim().startsWith('M'));
  assert.equal(svg.children.some(c => c.tagName === 'text' && c.textContent === 'X'), true);
  assert.equal(svg.children.some(c => c.tagName === 'text' && c.textContent === 'Y'), true);
});

test('lineChart shows the no-data message and skips axes when every series value is non-finite', () => {
  const container = new FakeElement('div');
  lineChart(container, points([[0, null], [6, NaN], [12, null]]), [{ key: 'value', color: '#fff' }]);
  const svg = container.children[0];
  assert.equal(svg.children.some(c => c.tagName === 'text' && c.textContent === '이 조건에서는 유효한 측위 결과가 없습니다.'), true);
  assert.equal(svg.children.some(c => c.tagName === 'path'), false);
  assert.equal(svg.children.some(c => c.tagName === 'line'), false);
});

test('lineChart breaks the path at gaps instead of interpolating across missing samples', () => {
  const container = new FakeElement('div');
  lineChart(container, points([[0, 10], [1, null], [2, 15]]), [{ key: 'value', color: '#fff' }]);
  const svg = container.children[0];
  const path = svg.children.find(c => c.tagName === 'path');
  const moves = path.attributes.d.match(/M/g) || [];
  const lines = path.attributes.d.match(/L/g) || [];
  assert.equal(moves.length, 2); // one new subpath per finite run
  assert.equal(lines.length, 0); // each run has only one point, so no L segment
});

test('lineChart multi-series charts draw one path per series in matching colors', () => {
  const container = new FakeElement('div');
  const rows = [0, 6, 12].map(hours => ({ hours, a: hours, b: 24 - hours }));
  lineChart(container, rows, [{ key: 'a', color: '#111' }, { key: 'b', color: '#222', width: 1.5 }]);
  const svg = container.children[0];
  const paths = svg.children.filter(c => c.tagName === 'path');
  assert.equal(paths.length, 2);
  assert.equal(paths[0].attributes.stroke, '#111');
  assert.equal(paths[1].attributes.stroke, '#222');
  assert.equal(paths[1].attributes['stroke-width'], '1.5');
});

test('lineChart maps a non-zero xMin to the left edge and labels ticks across [xMin, xMax]', () => {
  const container = new FakeElement('div'); container._rect = { width: 500, height: 260 };
  const rows = [400, 1200, 2000].map(altitude => ({ altitude, rate: altitude / 10 }));
  lineChart(container, rows, [{ key: 'rate', color: '#fff' }], { xMin: 400, xMax: 2000, xKey: 'altitude', xLabel: 'km' });
  const svg = container.children[0];
  const coords = svg.children.find(c => c.tagName === 'path').attributes.d.trim().split(/[ML]\s*/).filter(Boolean).map(pair => Number(pair.split(' ')[0]));
  close(coords[0], 58); // margin.left
  close(coords[2], 500 - 22); // width - margin.right
  close(coords[1], (58 + 478) / 2);
  const ticks = svg.children.filter(c => c.tagName === 'text' && c.attributes.y === String(260 - 21)).map(c => c.textContent);
  assert.deepEqual(ticks, [400, 800, 1200, 1600, 2000]);
});

// --- Globe ---

test('Globe.draw is a no-op until a snapshot has been set', () => {
  const canvas = fakeCanvas();
  new Globe(canvas);
  assert.equal(canvas.ctx.calls.length, 0);
});

test('Globe centered on the observer places its marker exactly at the canvas center, scaled by devicePixelRatio', () => {
  globalThis.window.devicePixelRatio = 2;
  try {
    const orbits = engine.buildConstellations(cfg);
    const current = engine.snapshot(cfg, 0, orbits);
    const canvas = fakeCanvas(300, 200);
    const globe = new Globe(canvas);
    globe.set(current, orbits);
    canvas.ctx.calls = []; // isolate the re-centered draw from the initial default-view draw
    globe.center(current.location.lat, current.location.lon); // frame.up now equals the observer direction exactly
    assert.equal(canvas.width, 600); assert.equal(canvas.height, 400); // 300x200 at dpr=2

    const cx = 150, cy = 102; // w/2, h/2 + 2
    const observerArcs = canvas.ctx.calls.filter(c => c.method === 'arc' && c.args[2] === 4);
    assert.equal(observerArcs.length, 1);
    close(observerArcs[0].args[0], cx, 1e-6); close(observerArcs[0].args[1], cy, 1e-6);
    assert.equal(observerArcs[0].fillStyle, '#fff');
    const label = canvas.ctx.calls.find(c => c.method === 'fillText' && c.args[0] === current.location.name);
    assert.ok(label, 'observer label was drawn');
  } finally {
    globalThis.window.devicePixelRatio = 1;
  }
});

test('Globe only draws GNSS/regional satellites when full-sky scale is enabled', () => {
  const orbits = engine.buildConstellations({ ...cfg, regional: true });
  const current = engine.snapshot({ ...cfg, regional: true }, 0, orbits);
  const canvas = fakeCanvas();
  const globe = new Globe(canvas);
  globe.set(current, orbits);
  const leoOnlyColors = new Set(canvas.ctx.calls.filter(c => c.method === 'arc' && c.args[2] < 4).map(c => c.fillStyle));
  assert.equal(leoOnlyColors.has('#f6b75b'), false); // GNSS amber
  assert.equal(leoOnlyColors.has('#c1a0ff'), false); // regional purple

  globe.setFull(true);
  const fullColors = new Set(canvas.ctx.calls.filter(c => c.method === 'arc' && c.args[2] < 4).map(c => c.fillStyle));
  assert.equal(fullColors.has('#f6b75b') || fullColors.has('#c1a0ff'), true);
});
