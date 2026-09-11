import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, EARTH_RADIUS, LOCATIONS, validateConfig, buildConstellations, orbitState, observerFrame, observe, snapshot, positionAccuracy, linkBudget, compactSample, summarize, resourceSweep } from '../dist/engine.js';

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

test('24-hour summary counts unavailable samples and excludes them only from conditional medians', () => {
  const samples=[{minutes:0,rate:200,hrms:2,baseline:4,gnssLEO:2,navPass:true,commPass:true,jointPass:true,leoVisible:4},{minutes:5,rate:0,hrms:null,baseline:null,gnssLEO:null,navPass:false,commPass:false,jointPass:false,leoVisible:0}];
  const sum=summarize(samples,cfg);close(sum.jointAvailability,50);close(sum.medianHrms,2);close(sum.validNavAvailability,50);assert.equal(sum.minLEO,0);
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
