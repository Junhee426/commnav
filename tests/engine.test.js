import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, EARTH_RADIUS, LOCATIONS, validateConfig, buildConstellations, walkerDelta, GNSS_REFERENCE, REGIONAL_REFERENCE, orbitState, observerFrame, observe, snapshot, positionAccuracy, linkBudget, compactSample, summarize, resourceSweep, parameterSweep, SWEEP_AXES } from '../dist/engine.js';

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const norm = a => Math.hypot(...a);
const cfg = { ...DEFAULT_CONFIG };
function sightline(az, el) { az *= Math.PI/180; el *= Math.PI/180; return [Math.cos(el)*Math.sin(az),Math.cos(el)*Math.cos(az),Math.sin(el)]; }

test('circular orbital radius and constellation counts remain physical', () => {
  for (const altitude of [500, 888, 1280]) {
    const orbits = buildConstellations({ ...cfg, altitude, regional: true });
    assert.equal(orbits.filter(o=>o.group==='LEO').length,256);
    assert.equal(orbits.filter(o=>o.group==='GNSS').length,24);
    assert.equal(orbits.filter(o=>o.group==='REGIONAL').length,8);
    for (const orbit of orbits) for (const t of [0, 1834, 7349]) close(norm(orbitState(orbit,t).position),orbit.radius,1e-7);
    close(orbits[0].radius, EARTH_RADIUS+altitude);
  }
});

test('walkerDelta is the shared generator behind both the user LEO fleet and the fixed GNSS reference', () => {
  const grid = walkerDelta({ planes: 2, satellitesPerPlane: 3, radius: 7000, inclinationDeg: 45 });
  assert.equal(grid.length, 6);
  assert.deepEqual(grid.map(s => s.plane), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(grid.map(s => s.index), [0, 1, 2, 3, 4, 5]);
  close(grid[0].raan, 0); close(grid[3].raan, Math.PI);
  close(grid[0].inclination, 45 * Math.PI / 180);
  const offset = walkerDelta({ planes: 1, satellitesPerPlane: 1, radius: 7000, inclinationDeg: 0, phaseOffset: 1.2 });
  close(offset[0].phase, 1.2);
  // buildConstellations' fixed GNSS block must match calling walkerDelta directly with GNSS_REFERENCE.
  const viaBuild = buildConstellations(cfg).filter(o => o.group === 'GNSS');
  const viaSpec = walkerDelta({ planes: GNSS_REFERENCE.planes, satellitesPerPlane: GNSS_REFERENCE.satellitesPerPlane,
    radius: EARTH_RADIUS + GNSS_REFERENCE.altitudeKm, inclinationDeg: GNSS_REFERENCE.inclinationDeg, phaseOffset: GNSS_REFERENCE.phaseOffset });
  assert.equal(viaBuild.length, viaSpec.length);
  viaBuild.forEach((sat, i) => { close(sat.raan, viaSpec[i].raan); close(sat.phase, viaSpec[i].phase); close(sat.radius, viaSpec[i].radius); });
});

test('the regional reference spec is data, not code: changing it changes the constellation with no other edits', () => {
  const stock = buildConstellations({ ...cfg, regional: true }).filter(o => o.group === 'REGIONAL');
  assert.equal(stock.length, REGIONAL_REFERENCE.geoCount + REGIONAL_REFERENCE.igsoCount);
  assert.equal(stock[0].id, 'R1');
  close(stock[0].raan, REGIONAL_REFERENCE.geoStartDeg * Math.PI / 180);
  close(stock[REGIONAL_REFERENCE.geoCount].inclination, REGIONAL_REFERENCE.igsoInclinationDeg * Math.PI / 180);
});

test('walkerDelta defaults to F=1 and honors an explicit phasing factor', () => {
  const base = { planes: 4, satellitesPerPlane: 6, radius: 7000, inclinationDeg: 45 };
  const defaultF = walkerDelta(base);
  const explicitF1 = walkerDelta({ ...base, F: 1 });
  defaultF.forEach((sat, i) => close(sat.phase, explicitF1[i].phase));
  // Standard Walker Delta phasing: adjacent-plane phase step is F * 360deg / total.
  const TAU = 2 * Math.PI, total = base.planes * base.satellitesPerPlane;
  for (const F of [0, 2, 3]) {
    const grid = walkerDelta({ ...base, F });
    const plane0 = grid.find(s => s.plane === 0 && s.index % base.satellitesPerPlane === 0);
    const plane1 = grid.find(s => s.plane === 1 && s.index % base.satellitesPerPlane === 0);
    close(((plane1.phase - plane0.phase) % TAU + TAU) % TAU, (TAU * F / total) % TAU);
  }
});

test('validateConfig enforces walkerF as an integer within [0, 31], independent of planes', () => {
  assert.equal(validateConfig({ ...cfg, planes: 8, walkerF: 7 }).walkerF, 7);
  assert.equal(validateConfig({ ...cfg, planes: 8, walkerF: 0 }).walkerF, 0);
  assert.equal(validateConfig({ ...cfg, planes: 8, walkerF: 31 }).walkerF, 31);
  assert.throws(() => validateConfig({ ...cfg, walkerF: 32 }), /walkerF/);
  assert.throws(() => validateConfig({ ...cfg, walkerF: -1 }), /walkerF/);
  assert.throws(() => validateConfig({ ...cfg, walkerF: 1.5 }), /위상 계수 F/);
  // F stays valid even when it numerically exceeds the (unrelated) plane count: F and F+planes
  // describe geometrically equivalent constellations, so no cross-field rejection is needed.
  assert.equal(validateConfig({ ...cfg, planes: 2, walkerF: 5 }).walkerF, 5);
  assert.equal(validateConfig({ ...cfg, planes: 1, walkerF: 1 }).walkerF, 1);
});

test('buildConstellations threads cfg.walkerF into the LEO fleet, leaving the fixed GNSS reference at its own F', () => {
  const withF2 = buildConstellations({ ...cfg, planes: 4, satellitesPerPlane: 6, walkerF: 2 }).filter(o => o.group === 'LEO');
  const viaSpec = walkerDelta({ planes: 4, satellitesPerPlane: 6, radius: EARTH_RADIUS + cfg.altitude, inclinationDeg: cfg.inclination, F: 2 });
  withF2.forEach((sat, i) => close(sat.phase, viaSpec[i].phase));
  // GNSS reference ignores the LEO fleet's F entirely: identical to the F=1 default case.
  const gnssWithF2 = buildConstellations({ ...cfg, walkerF: 2 }).filter(o => o.group === 'GNSS');
  const gnssDefault = buildConstellations(cfg).filter(o => o.group === 'GNSS');
  gnssWithF2.forEach((sat, i) => close(sat.phase, gnssDefault[i].phase));
});

test('geostationary example remains fixed in ECEF', () => {
  const orbit=buildConstellations({...cfg,regional:true}).find(o=>o.id==='R1');
  const first=orbitState(orbit,0).position, later=orbitState(orbit,31000).position;
  close(norm(first.map((v,i)=>v-later[i])),0,1e-7);
});

test('ECEF velocity gives the numerical derivative of observer range', () => {
  const orbit=buildConstellations(cfg)[42], frame=observerFrame(37.5665,126.978), t=2200, dt=.01;
  const a=observe(orbitState(orbit,t-dt),frame).range,b=observe(orbitState(orbit,t+dt),frame).range;
  close((b-a)/(2*dt),observe(orbitState(orbit,t),frame).rangeRate,1e-6);
});

test('weighted covariance matches an independent NumPy ENU reference with inter-system clock state', () => {
  const gnss=[[15,65],[60,30],[105,45],[150,20],[195,60],[240,35],[285,25],[330,50]].map(([a,e])=>({group:'GNSS',sigma:3,losENU:sightline(a,e)}));
  const leo=[[5,25],[75,60],[145,40],[215,75],[275,50],[330,20]];
  close(positionAccuracy(gnss).hrms,2.981276900100016,1e-9);
  const precise=leo.map(([a,e])=>({group:'LEO',sigma:Math.sqrt(2.25+1+.299792458**2),losENU:sightline(a,e)}));
  const loose=leo.map(([a,e])=>({group:'LEO',sigma:Math.sqrt(2.25+1+2.99792458**2),losENU:sightline(a,e)}));
  close(positionAccuracy([...gnss,...precise]).hrms,1.867575,1e-6);
  close(positionAccuracy([...gnss,...loose]).hrms,2.390719,1e-6);
  assert.equal(positionAccuracy([...gnss,...precise]).states,5);
});

test('measurement scaling changes precision, while geometric PDOP remains unchanged', () => {
  const measurements=[[5,20],[80,35],[170,65],[240,25],[300,50],[345,80]].map(([a,e])=>({group:'GNSS',sigma:2,losENU:sightline(a,e)}));
  const a=positionAccuracy(measurements),b=positionAccuracy(measurements.map(m=>({...m,sigma:m.sigma*3})));
  close(b.hrms,a.hrms*3);close(b.pdop,a.pdop);
});

test('insufficient or rank-deficient geometry is unavailable, not a zero error', () => {
  assert.equal(positionAccuracy([]).hrms,null);
  const same=Array.from({length:6},()=>({group:'GNSS',sigma:3,losENU:[0,0,1]}));
  assert.equal(positionAccuracy(same).valid,false);
  assert.equal(positionAccuracy(same).hrms,null);
});

test('LEO disabled, zero payload, and zero navigation time correctly recover the GNSS baseline', () => {
  for(const patch of [{leoNav:false},{payloadPercent:0},{sharing:'time',navShare:0}]) {
    const s=snapshot({...cfg,...patch},0);
    close(s.fusion.hrms,s.baseline.hrms,1e-9);assert.equal(s.navVisibleLEO,0);
  }
  assert.equal(buildConstellations({...cfg,payloadPercent:25}).filter(o=>o.group==='LEO'&&o.payload).length,64);
});

test('time sharing reduces rate and navigation uncertainty under stated independent-noise assumptions', () => {
  const separate=snapshot(cfg,0),shared=snapshot({...cfg,sharing:'time',navShare:20},0);
  close(shared.rate,separate.rate*.8,1e-9);
  assert.ok(shared.fusion.hrms<separate.fusion.hrms);
  const sweep=resourceSweep(cfg,0);
  for(let i=1;i<sweep.length;i++){assert.ok(sweep[i].rate<=sweep[i-1].rate+1e-8);assert.ok(sweep[i].hrms<=sweep[i-1].hrms+1e-8);}
});

test('poor LEO timing supplies little information and does not artificially improve geometry-only accuracy', () => {
  const precise=snapshot({...cfg,clockNs:1},0),poor=snapshot({...cfg,clockNs:1000},0);
  assert.ok(precise.fusion.hrms<poor.fusion.hrms);
  assert.ok(poor.fusion.hrms<=poor.baseline.hrms+1e-8);
  assert.ok(Math.abs(poor.fusion.hrms-poor.baseline.hrms)<.02);
  close(precise.fusion.pdop,poor.fusion.pdop,1e-9);
});

test('link free-space loss and delay obey distance scaling', () => {
  const first=linkBudget({range:1000,rangeRate:0,payload:true},cfg);
  const second=linkBudget({range:2000,rangeRate:0,payload:true},cfg);
  close(second.fspl-first.fspl,20*Math.log10(2));
  close(second.delayMs,first.delayMs*2);
  close(first.delayMs,1000000/299792458*1000);
  assert.ok(second.mbps<first.mbps);assert.equal(first.dopplerKHz,0);
});

test('invalid requests and excessive constellations fail before calculations', () => {
  for(const patch of [{altitude:NaN},{clockNs:-1},{planes:32,satellitesPerPlane:32},{location:'unknown'},{regional:'true'},{privateKey:1}])assert.throws(()=>validateConfig({...cfg,...patch}));
});

test('location must be a string, even when an input coerces to a known location', () => {
  for (const location of [['seoul'], new String('seoul'), { toString: () => 'seoul' }, null]) {
    assert.throws(() => validateConfig({ ...cfg, location }), /관측지/);
  }
  assert.equal(validateConfig({ ...cfg, location: 'seoul' }).location, 'seoul');
});

test('24-hour summary counts unavailable samples and excludes them only from conditional medians', () => {
  const samples=[{minutes:0,rate:200,hrms:2,baseline:4,gnssLEO:2,navPass:true,commPass:true,jointPass:true,leoVisible:4},{minutes:5,rate:0,hrms:null,baseline:null,gnssLEO:null,navPass:false,commPass:false,jointPass:false,leoVisible:0}];
  const sum=summarize(samples,cfg);close(sum.jointAvailability,50);close(sum.medianHrms,2);close(sum.validNavAvailability,50);assert.equal(sum.minLEO,0);
  assert.equal(sum.longestOutageMinutes, 5); // one 5-minute-step sample missed the joint target
});

test('summarize tracks the minimum visible LEO nav satellite count and the longest joint-target outage', () => {
  const sample = (minutes, jointPass, leoVisible) => ({ minutes, rate: jointPass ? 200 : 0, hrms: jointPass ? 2 : null,
    baseline: 4, gnssLEO: 2, navPass: jointPass, commPass: jointPass, jointPass, leoVisible });
  // pass, pass, FAIL, FAIL, FAIL, pass, FAIL, pass -> longest run of misses is 3 samples * 5 min = 15 min.
  const pattern = [true, true, false, false, false, true, false, true];
  const samples = pattern.map((ok, i) => sample(i * 5, ok, ok ? 8 : 2));
  const sum = summarize(samples, cfg);
  assert.equal(sum.minLEO, 2);
  assert.equal(sum.maxLEO, 8);
  assert.equal(sum.longestOutageMinutes, 15);
});

test('summarize reports no outage when every sample meets the joint target', () => {
  const samples = Array.from({ length: 6 }, (_, i) => ({ minutes: i * 5, rate: 200, hrms: 2, baseline: 4, gnssLEO: 2,
    navPass: true, commPass: true, jointPass: true, leoVisible: 6 }));
  const sum = summarize(samples, cfg);
  assert.equal(sum.longestOutageMinutes, 0);
});

test('summarize leaves longestOutageMinutes null when the sampling step is unknown (0 or 1 samples)', () => {
  assert.equal(summarize([], cfg).longestOutageMinutes, null);
  assert.equal(summarize([{ minutes: 0, rate: 0, hrms: null, baseline: null, gnssLEO: null, navPass: false, commPass: false, jointPass: false, leoVisible: 0 }], cfg).longestOutageMinutes, null);
});

test('custom coordinates reproduce each preset at the same position', () => {
  for (const [location, { lat, lon }] of Object.entries(LOCATIONS)) {
    const preset = snapshot({ ...cfg, location }, 345);
    const custom = snapshot({ ...cfg, location: 'custom', latitude: lat, longitude: lon }, 345);
    assert.deepEqual(compactSample(custom), compactSample(preset));
    assert.deepEqual(custom.observer, preset.observer);
  }
});

test('custom observer coordinates handle poles and the date line and reject invalid inputs', () => {
  for (const latitude of [-90, 0, 90]) for (const longitude of [-180, 0, 180]) {
    const s = snapshot({ ...cfg, location: 'custom', latitude, longitude });
    close(norm(s.observer), EARTH_RADIUS, 1e-7);
    assert.ok(Number.isFinite(s.rate));
    assert.ok(s.satellites.every(sat => Number.isFinite(sat.elevation) && Number.isFinite(sat.range)));
  }
  for (const patch of [{ latitude: 90.01 }, { latitude: -91 }, { longitude: 181 }, { longitude: -181 }, { latitude: NaN }, { longitude: '126' }]) {
    assert.throws(() => validateConfig({ ...cfg, location: 'custom', ...patch }));
  }
});

test('custom constellation sizes propagate through snapshots and resource sweeps', () => {
  for (const [planes, satellitesPerPlane] of [[1, 4], [7, 12], [16, 32], [32, 16]]) {
    const used = { ...cfg, planes, satellitesPerPlane, location: 'custom', latitude: -33.87, longitude: 151.21 };
    const s = snapshot(used, 60);
    assert.equal(s.satellites.filter(sat => sat.group === 'LEO').length, planes * satellitesPerPlane);
    assert.equal(s.payloadCount, planes * satellitesPerPlane);
    const point = resourceSweep(used, 60)[5];
    const shared = snapshot({ ...used, sharing: 'time', navShare: 10 }, 60);
    close(point.rate, shared.rate);
    assert.equal(point.hrms, shared.fusion.hrms);
  }
  for (const patch of [{ planes: 1.5 }, { satellitesPerPlane: 4.5 }, { satellitesPerPlane: 3 }, { planes: 17, satellitesPerPlane: 32 }]) {
    assert.throws(() => validateConfig({ ...cfg, ...patch }));
  }
});

test('all regional presets and a full day produce finite rates and consistent covariance results', () => {
  for(const location of Object.keys(LOCATIONS)) for(const altitude of [500,888,1280]) for(const regional of [false,true]) {
    for(const minutes of [0,345,1080]){
      const s=snapshot({...cfg,location,altitude,regional},minutes);
      assert.ok(Number.isFinite(s.rate)&&s.rate>=0);
      if(s.baseline.valid&&s.fusion.valid)assert.ok(s.fusion.hrms<=s.baseline.hrms+1e-7);
    }
  }
  const orbits=buildConstellations(cfg), samples=[];
  for(let m=0;m<1440;m+=5)samples.push(compactSample(snapshot(cfg,m,orbits)));
  const summary=summarize(samples,cfg);
  assert.equal(summary.samples,288);assert.equal(samples.at(-1).minutes,1435);
  for(const key of ['commAvailability','navAvailability','jointAvailability'])assert.ok(summary[key]>=0&&summary[key]<=100);
});

test('parameterSweep on navShare reproduces resourceSweep exactly', () => {
  assert.deepEqual(parameterSweep(cfg, 0, 'navShare'), resourceSweep(cfg, 0).map(p => ({ ...p, unavailable: false })));
});

test('parameterSweep rejects an unsupported axis', () => {
  assert.throws(() => parameterSweep(cfg, 0, 'notAnAxis'));
});

test('altitude sweep covers the full validated range and stays available throughout', () => {
  const points = parameterSweep(cfg, 0, 'altitude');
  assert.equal(points[0].altitude, 400);
  assert.equal(points.at(-1).altitude, 2000);
  assert.ok(points.every(p => !p.unavailable && Number.isFinite(p.rate) && Number.isFinite(p.hrms)));
});

test('planes sweep marks combinations exceeding the 512-satellite cap as unavailable, not a crash', () => {
  const points = parameterSweep({ ...cfg, satellitesPerPlane: 32 }, 0, 'planes');
  const overCap = points.filter(p => p.planes * 32 > 512);
  const underCap = points.filter(p => p.planes * 32 <= 512);
  assert.ok(overCap.length > 0 && underCap.length > 0);
  assert.ok(overCap.every(p => p.unavailable && p.rate === null));
  assert.ok(underCap.every(p => !p.unavailable));
});

test('every advertised sweep axis runs end to end', () => {
  for (const axis of SWEEP_AXES) {
    const points = parameterSweep(cfg, 0, axis);
    assert.ok(points.length > 1);
    assert.ok(points.some(p => !p.unavailable));
  }
});
