// K-LEO COMM/PNT: deterministic circular-orbit design model, not operational ephemerides.
export const MODEL_VERSION = '1.1.0';
export const EARTH_RADIUS = 6378.137; // km; spherical Earth approximation
export const MU = 398600.4418; // km^3/s^2
export const EARTH_RATE = 7.292115e-5; // rad/s
export const C = 299792458; // m/s, exact
const TAU = 2 * Math.PI;
const RAD = Math.PI / 180;
export const LOCATIONS = {
  seoul: { name: '서울', lat: 37.5665, lon: 126.978 },
  busan: { name: '부산', lat: 35.1796, lon: 129.0756 },
  jeju: { name: '제주', lat: 33.4996, lon: 126.5312 },
  abudhabi: { name: '아부다비', lat: 24.4539, lon: 54.3773 },
  singapore: { name: '싱가포르', lat: 1.3521, lon: 103.8198 },
  jakarta: { name: '자카르타', lat: -6.2088, lon: 106.8456 },
};
export const DEFAULT_CONFIG = Object.freeze({
  altitude: 888, inclination: 42, planes: 16, satellitesPerPlane: 16,
  location: 'seoul', latitude: 37.5665, longitude: 126.978, commElevation: 20, navElevation: 10,
  leoNav: true, payloadPercent: 100, regional: false,
  sharing: 'separate', navShare: 10,
  gnssSigma: 3, leoSigma: 1.5, orbitSigma: 1, clockNs: 3,
  eirp: 45, gt: 5, bandwidth: 100, frequency: 20, rainLoss: 4,
  horizontalTarget: 10, rateTarget: 100,
});
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('설정 형식을 확인해 주세요.');
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  for (const key of Object.keys(input)) if (!known.has(key)) throw new Error('알 수 없는 설정: ' + key);
  const cfg = { ...DEFAULT_CONFIG, ...input };
  const limits = {
    altitude: [400, 2000], inclination: [0, 90], planes: [1, 32], satellitesPerPlane: [4, 32],
    latitude: [-90, 90], longitude: [-180, 180],
    commElevation: [5, 60], navElevation: [5, 60], payloadPercent: [0, 100], navShare: [0, 40],
    gnssSigma: [0.1, 30], leoSigma: [0.1, 30], orbitSigma: [0, 30], clockNs: [0, 1000],
    eirp: [20, 65], gt: [-10, 30], bandwidth: [1, 500], frequency: [10, 40], rainLoss: [0, 40],
    horizontalTarget: [0.1, 100], rateTarget: [1, 1000],
  };
  for (const [key, [lo, hi]] of Object.entries(limits)) {
    if (typeof cfg[key] !== 'number' || !Number.isFinite(cfg[key]) || cfg[key] < lo || cfg[key] > hi)
      throw new Error(key + ': ' + lo + '–' + hi + ' 범위의 수치를 입력해 주세요.');
  }
  if (!Number.isInteger(cfg.planes) || !Number.isInteger(cfg.satellitesPerPlane)) throw new Error('궤도면·위성 수는 정수여야 합니다.');
  if (cfg.planes * cfg.satellitesPerPlane > 512) throw new Error('LEO 위성은 총 512기까지 계산합니다. 궤도면 수 또는 면당 위성 수를 줄여 주세요.');
  for (const key of ['leoNav', 'regional']) if (typeof cfg[key] !== 'boolean') throw new Error(key + ' 값을 확인해 주세요.');
  if (typeof cfg.location !== 'string' || (cfg.location !== 'custom' && !Object.hasOwn(LOCATIONS, cfg.location))) throw new Error('관측지를 선택해 주세요.');
  if (!['separate', 'time'].includes(cfg.sharing)) throw new Error('신호 공유 방식을 선택해 주세요.');
  return cfg;
}
export function getLocation(config) {
  return config.location === 'custom'
    ? { name: '사용자 지정', lat: config.latitude, lon: config.longitude }
    : LOCATIONS[config.location];
}
export function observerFrame(latDeg, lonDeg) {
  const lat = latDeg * RAD, lon = lonDeg * RAD;
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  return { position: up.map(x => x * EARTH_RADIUS), up,
    east: [-Math.sin(lon), Math.cos(lon), 0],
    north: [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)] };
}
export function orbitState(orbit, timeSeconds, phaseOverride) {
  const a = orbit.radius, n = Math.sqrt(MU / (a * a * a));
  const u = (phaseOverride ?? orbit.phase) + n * timeSeconds;
  const cu = Math.cos(u), su = Math.sin(u);
  // raan/inclination are fixed per orbit; buildConstellations precomputes their cos/sin once
  // instead of every call, since this runs per satellite per sample (up to ~536 x 288 per day).
  const co = orbit.raanCos, so = orbit.raanSin, ci = orbit.incCos, si = orbit.incSin;
  const inertial = [a * (co * cu - so * su * ci), a * (so * cu + co * su * ci), a * su * si];
  const velocity = [a * n * (-co * su - so * cu * ci), a * n * (-so * su + co * cu * ci), a * n * cu * si];
  const theta = EARTH_RATE * timeSeconds, ct = Math.cos(theta), st = Math.sin(theta);
  const p = [ct * inertial[0] + st * inertial[1], -st * inertial[0] + ct * inertial[1], inertial[2]];
  const v = [ct * velocity[0] + st * velocity[1] + EARTH_RATE * p[1],
    -st * velocity[0] + ct * velocity[1] - EARTH_RATE * p[0], velocity[2]];
  return { position: p, velocity: v };
}
export function buildConstellations(config) {
  const cfg = validateConfig(config), out = [];
  const total = cfg.planes * cfg.satellitesPerPlane;
  for (let p = 0; p < cfg.planes; p++) for (let s = 0; s < cfg.satellitesPerPlane; s++) {
    const i = p * cfg.satellitesPerPlane + s;
    const payload = cfg.leoNav && Math.floor((i + 1) * cfg.payloadPercent / 100 + 1e-9) > Math.floor(i * cfg.payloadPercent / 100 + 1e-9);
    out.push({ id: 'L' + String(i + 1).padStart(3, '0'), group: 'LEO', plane: p, payload,
      radius: EARTH_RADIUS + cfg.altitude, inclination: cfg.inclination * RAD,
      raan: TAU * p / cfg.planes, phase: TAU * s / cfg.satellitesPerPlane + TAU * p / total });
  }
  // Idealized 24-satellite MEO reference; not live GPS/Galileo broadcast orbits.
  for (let p = 0; p < 6; p++) for (let s = 0; s < 4; s++) {
    out.push({ id: 'G' + String(p * 4 + s + 1).padStart(2, '0'), group: 'GNSS', payload: true,
      radius: EARTH_RADIUS + 20200, inclination: 55 * RAD,
      raan: TAU * p / 6, phase: TAU * s / 4 + TAU * p / 24 + 0.35 });
  }
  if (cfg.regional) {
    const radius = Math.cbrt(MU / (EARTH_RATE * EARTH_RATE));
    for (let i = 0; i < 3; i++) out.push({ id: 'R' + (i + 1), group: 'REGIONAL', payload: true,
      radius, inclination: 0, raan: (120 + i * 8) * RAD, phase: 0 });
    for (let i = 0; i < 5; i++) {
      const phase = TAU * i / 5;
      out.push({ id: 'R' + (i + 4), group: 'REGIONAL', payload: true,
        radius, inclination: 43 * RAD, raan: 128 * RAD - phase, phase });
    }
  }
  return out.map(o => ({ ...o, raanCos: Math.cos(o.raan), raanSin: Math.sin(o.raan), incCos: Math.cos(o.inclination), incSin: Math.sin(o.inclination) }));
}
export function observe(state, frame) {
  // Scalar math instead of .map()-built intermediate arrays: called per satellite per sample
  // (up to ~536 x 288 for a full-day run), so the array allocations here were real GC pressure.
  const dx = state.position[0] - frame.position[0], dy = state.position[1] - frame.position[1], dz = state.position[2] - frame.position[2];
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const lx = dx / range, ly = dy / range, lz = dz / range;
  const e = lx * frame.east[0] + ly * frame.east[1] + lz * frame.east[2];
  const n = lx * frame.north[0] + ly * frame.north[1] + lz * frame.north[2];
  const u = lx * frame.up[0] + ly * frame.up[1] + lz * frame.up[2];
  const rangeRate = state.velocity[0] * lx + state.velocity[1] * ly + state.velocity[2] * lz;
  return { range, elevation: Math.asin(Math.max(-1, Math.min(1, u))) / RAD,
    azimuth: (Math.atan2(e, n) / RAD + 360) % 360, losENU: [e, n, u], rangeRate };
}
export function invert(matrix) {
  const n = matrix.length, max = Math.max(...matrix.flat().map(Math.abs));
  if (!Number.isFinite(max) || max === 0) return null;
  const a = matrix.map((row, i) => [...row.map(v => v / max), ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i][k]) > Math.abs(a[pivot][k])) pivot = i;
    if (Math.abs(a[pivot][k]) < 1e-12) return null;
    [a[k], a[pivot]] = [a[pivot], a[k]];
    const div = a[k][k];
    for (let j = 0; j < 2 * n; j++) a[k][j] /= div;
    for (let i = 0; i < n; i++) if (i !== k) {
      const factor = a[i][k];
      for (let j = 0; j < 2 * n; j++) a[i][j] -= factor * a[k][j];
    }
  }
  const inv = a.map(row => row.slice(n).map(v => v / max));
  const matrixNorm = Math.max(...matrix.map(row => row.reduce((s, v) => s + Math.abs(v), 0)));
  const inverseNorm = Math.max(...inv.map(row => row.reduce((s, v) => s + Math.abs(v), 0)));
  if (matrixNorm * inverseNorm > 1e12 || inv.some(row => row.some(v => !Number.isFinite(v)))) return null;
  return inv;
}
export function positionAccuracy(measurements) {
  const groups = [...new Set(measurements.map(m => m.group))];
  const states = 3 + groups.length;
  const unavailable = reason => ({ valid: false, reason, satellites: measurements.length, groups, states, hrms: null, vrms: null, pdop: null });
  if (!groups.length || measurements.length < states) return unavailable('가시 위성 부족');
  const normal = Array.from({ length: states }, () => Array(states).fill(0));
  const geometry = Array.from({ length: states }, () => Array(states).fill(0));
  for (const m of measurements) {
    const row = [...m.losENU, ...groups.map(group => group === m.group ? 1 : 0)];
    const weight = 1 / (m.sigma * m.sigma);
    for (let i = 0; i < states; i++) for (let j = 0; j < states; j++) {
      normal[i][j] += row[i] * row[j] * weight;
      geometry[i][j] += row[i] * row[j];
    }
  }
  const cov = invert(normal), q = invert(geometry);
  if (!cov || !q || cov[0][0] < 0 || cov[1][1] < 0 || cov[2][2] < 0) return unavailable('위성 배치의 기하학적 제약');
  return { valid: true, reason: '', satellites: measurements.length, groups, states,
    hrms: Math.sqrt(cov[0][0] + cov[1][1]), vrms: Math.sqrt(cov[2][2]),
    pdop: Math.sqrt(q[0][0] + q[1][1] + q[2][2]), covariance: cov };
}
export function linkBudget(sat, config) {
  const fspl = 92.45 + 20 * Math.log10(config.frequency) + 20 * Math.log10(sat.range);
  const snr = config.eirp + config.gt - fspl - config.rainLoss - 2 + 228.6 - 10 * Math.log10(config.bandwidth * 1e6);
  const efficiency = Math.min(6, Math.log2(1 + Math.pow(10, (snr - 3) / 10)));
  const navDuty = config.sharing === 'time' && sat.payload ? config.navShare / 100 : 0;
  const mbps = config.bandwidth * efficiency * 0.75 * (1 - navDuty);
  return { mbps, snr, fspl, navDuty, delayMs: sat.range * 1e6 / C,
    dopplerKHz: sat.rangeRate === 0 ? 0 : -sat.rangeRate * 1000 / C * config.frequency * 1e6 };
}
export function snapshot(config, minutes = 0, constellation) {
  const cfg = validateConfig(config);
  return evaluateSnapshot(cfg, prepareGeometry(cfg, minutes, constellation));
}
// Orbit propagation and observer geometry do not depend on navigation time allocation.
export function prepareGeometry(cfg, minutes, constellation) {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) throw new Error('시각은 0–1440분 범위입니다.');
  const satList = constellation || buildConstellations(cfg), location = getLocation(cfg);
  const frame = observerFrame(location.lat, location.lon);
  const satellites = satList.map(orbit => {
    const state = orbitState(orbit, minutes * 60);
    return { id: orbit.id, group: orbit.group, payload: orbit.payload, position: state.position, ...observe(state, frame) };
  });
  return { minutes, location, observer: frame.position, satellites };
}
export function evaluateSnapshot(cfg, geometry) {
  const { minutes, location, observer } = geometry;
  const measurements = [], gnss = [], regional = [], leo = [], states = [];
  let best = null;
  let commVisible = 0, navVisibleLEO = 0, payloadCount = 0;
  for (const seen of geometry.satellites) {
    if (seen.group === 'LEO' && seen.payload) payloadCount++;
    const sat = { ...seen, sigma: null, navUsed: false };
    if (sat.group === 'LEO' && seen.elevation >= cfg.commElevation) {
      commVisible++;
      sat.link = linkBudget(sat, cfg);
      if (!best || sat.link.mbps > best.link.mbps) best = sat;
    }
    if (seen.elevation >= cfg.navElevation && sat.payload) {
      if (sat.group === 'LEO') {
        const fraction = cfg.sharing === 'time' ? cfg.navShare / 100 : 0.1;
        if (fraction > 0) {
          const noise = cfg.leoSigma * seen.range / 1000 * Math.sqrt(0.1 / fraction);
          sat.sigma = Math.sqrt(noise * noise + cfg.orbitSigma ** 2 + (cfg.clockNs * 1e-9 * C) ** 2);
          navVisibleLEO++;
        }
      } else sat.sigma = cfg.gnssSigma;
      if (sat.sigma !== null) {
        const m = { id: sat.id, group: sat.group, losENU: seen.losENU, sigma: sat.sigma };
        sat.navUsed = true;
        measurements.push(m);
        if (sat.group === 'GNSS') gnss.push(m);
        else if (sat.group === 'REGIONAL') regional.push(m);
        else leo.push(m);
      }
    }
    states.push(sat);
  }
  const baseline = positionAccuracy(gnss);
  const gnssLEO = positionAccuracy([...gnss, ...leo]);
  const fusion = positionAccuracy(measurements);
  const rate = best ? best.link.mbps : 0;
  const navPass = fusion.valid && fusion.hrms <= cfg.horizontalTarget;
  const commPass = rate >= cfg.rateTarget;
  return { minutes, satellites: states, observer, location, best,
    baseline, gnssLEO, fusion, rate, commVisible, navVisibleLEO, gnssVisible: gnss.length,
    regionalVisible: regional.length, payloadCount, navPass, commPass, jointPass: navPass && commPass };
}
export function compactSample(s) {
  return { minutes: s.minutes, rate: s.rate, hrms: s.fusion.hrms, baseline: s.baseline.hrms,
    gnssLEO: s.gnssLEO.hrms, pdop: s.fusion.pdop, commVisible: s.commVisible,
    leoVisible: s.navVisibleLEO, gnssVisible: s.gnssVisible, regionalVisible: s.regionalVisible,
    delayMs: s.best?.link.delayMs ?? null, navPass: s.navPass, commPass: s.commPass, jointPass: s.jointPass };
}
export function quantile(values, q) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const at = (valid.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return valid[lo] + (valid[hi] - valid[lo]) * (at - lo);
}
export function summarize(samples, config) {
  const count = samples.length, ratio = fn => count ? 100 * samples.filter(fn).length / count : 0;
  return { samples: count, stepMinutes: samples.length > 1 ? samples[1].minutes - samples[0].minutes : null,
    medianRate: quantile(samples.map(s => s.rate), .5), medianHrms: quantile(samples.map(s => s.hrms), .5),
    medianBaseline: quantile(samples.map(s => s.baseline), .5), medianGnssLEO: quantile(samples.map(s => s.gnssLEO), .5),
    commAvailability: ratio(s => s.commPass), navAvailability: ratio(s => s.navPass), jointAvailability: ratio(s => s.jointPass),
    baselineAvailability: ratio(s => s.baseline !== null && s.baseline <= config.horizontalTarget),
    gnssLeoAvailability: ratio(s => s.gnssLEO !== null && s.gnssLEO <= config.horizontalTarget),
    validNavAvailability: ratio(s => s.hrms !== null),
    minLEO: Math.min(...samples.map(s => s.leoVisible)), maxLEO: Math.max(...samples.map(s => s.leoVisible)) };
}
export function resourceSweep(config, minutes) {
  return parameterSweep(config, minutes, 'navShare');
}
// Ranges mirror validateConfig's own limits for each field.
const SWEEP_SPECS = {
  navShare: { min: 0, max: 40, steps: 21 },
  altitude: { min: 400, max: 2000, steps: 17 },
  inclination: { min: 0, max: 90, steps: 19 },
  planes: { min: 1, max: 32, steps: 32, integer: true },
  satellitesPerPlane: { min: 4, max: 32, steps: 15, integer: true },
  payloadPercent: { min: 0, max: 100, steps: 21 },
};
export const SWEEP_AXES = Object.keys(SWEEP_SPECS);
function sweepAxisPoints({ min, max, steps, integer }) {
  return Array.from({ length: steps }, (_, i) => {
    const raw = min + (max - min) * i / (steps - 1);
    return integer ? Math.round(raw) : Math.round(raw * 100) / 100;
  });
}
// Sweeps a single design variable across its full valid range, holding everything
// else fixed, so a trade study can compare e.g. altitude or plane count rather
// than only the original navigation-time-share axis. Points whose combination
// happens to be infeasible (e.g. planes × satellitesPerPlane > 512) are marked
// unavailable instead of aborting the whole sweep.
export function parameterSweep(config, minutes, axis = 'navShare') {
  const spec = SWEEP_SPECS[axis];
  if (!spec) throw new Error('지원하지 않는 스윕 변수: ' + axis);
  const base = axis === 'navShare' ? { ...validateConfig(config), sharing: 'time' } : validateConfig(config);
  // navShare alone doesn't change satellite geometry, so it can reuse one prepared geometry.
  const sharedGeometry = axis === 'navShare' ? prepareGeometry(base, minutes) : null;
  return sweepAxisPoints(spec).map(value => {
    try {
      const cfg = validateConfig({ ...base, [axis]: value });
      const geometry = sharedGeometry || prepareGeometry(cfg, minutes);
      const s = evaluateSnapshot(cfg, geometry);
      return { [axis]: value, rate: s.rate, hrms: s.fusion.hrms, unavailable: false };
    } catch {
      return { [axis]: value, rate: null, hrms: null, unavailable: true };
    }
  });
}
