import { DEFAULT_CONFIG, LOCATIONS, validateConfig, buildConstellations, snapshot, resourceSweep, MODEL_VERSION } from './engine.js';
import { Globe, skyPlot, lineChart } from './rendering.js';

const $ = id => document.getElementById(id);
const form = $('configuration');
let config = { ...DEFAULT_CONFIG }, minutes = 0, view = 'situation';
let orbits = buildConstellations(config), current = null;
let lastAnalysis = null, worker = null, job = 0, playing = null, calculating = false;
let scheduled = null, analysisResolve = null, analysisReject = null;
const globe = new Globe($('globe'));
const fields = [...form.querySelectorAll('[data-config]')];
const mobileMedia = window.matchMedia('(max-width: 620px)');
const sidebar = document.querySelector('.sidebar');
const display = (v, decimals = 1) => Number.isFinite(v) ? v.toLocaleString('ko-KR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : '—';
const clock = value => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(Math.floor(value % 60)).padStart(2, '0');
function text(id, value) { $(id).textContent = value; }
function metric(id, value, unit, decimals = 1) {
  const small = document.createElement('small'); small.textContent = ' ' + unit;
  $(id).replaceChildren(document.createTextNode(display(value, decimals)), small);
}
function readConfig() {
  const read = { ...config };
  for (const field of fields) {
    const key = field.dataset.config;
    read[key] = field.type === 'checkbox' ? field.checked : ['location', 'sharing'].includes(key) ? field.value : field.value.trim() === '' ? NaN : Number(field.value);
  }
  return validateConfig(read);
}
function reportError(message) { text('config-error', message); $('config-error').hidden = false; }
function clearError() { $('config-error').hidden = true; }
function stale() { return !lastAnalysis || JSON.stringify(lastAnalysis.config) !== JSON.stringify(config); }
function updateAnalysisNotice() {
  const note = $('analysis-note');
  note.classList.toggle('stale', !!lastAnalysis && stale());
  if (lastAnalysis && stale()) note.textContent = '설정이 변경되었습니다. 아래 시간별 결과는 이전 설정입니다. ‘24시간 비교 분석’을 다시 실행해 주세요.';
  else if (lastAnalysis) note.textContent = `${LOCATIONS[lastAnalysis.config.location].name} · 24시간 / 5분 간격 / 288개 표본 · 원궤도 설계모형`;
  else note.textContent = calculating ? '기본 시나리오의 24시간 성능을 계산하고 있습니다.' : '왼쪽 설정에서 24시간 비교 분석을 실행해 주세요.';
}
function updateControlLabels() {
  text('payload-value', config.payloadPercent + '%'); text('share-value', config.navShare + '%');
  const share = form.elements.navShare;
  share.disabled = config.sharing === 'separate' || !config.leoNav || config.payloadPercent === 0;
  form.elements.payloadPercent.disabled = !config.leoNav;
  text('sharing-note', config.sharing === 'separate' ? '신호 분리 모드에서는 통신 시간을 차감하지 않습니다.' : '항법 탑재 위성의 통신 시간을 항법 비율만큼 차감합니다.');
  text('fleet-count', 'LEO ' + (config.planes * config.satellitesPerPlane) + '기');
  $('regional-legend').hidden = !config.regional;
}
function drawSnapshot() {
  current = snapshot(config, minutes, orbits);
  const loc = current.location;
  $('observer-label').replaceChildren(document.createTextNode(loc.name + ' '));
  const coord = document.createElement('span'); coord.textContent = `${Math.abs(loc.lat).toFixed(2)}° ${loc.lat >= 0 ? 'N' : 'S'} / ${Math.abs(loc.lon).toFixed(2)}° ${loc.lon >= 0 ? 'E' : 'W'}`;
  $('observer-label').append(coord);
  metric('current-rate', current.rate, 'Mbps'); metric('current-nav', current.fusion.hrms, 'm', 2);
  text('current-link', current.best ? `${current.best.id} · 항법 탑재 ${current.payloadCount}기` : '통신 최소고도각을 만족하는 위성이 없습니다.');
  text('current-baseline', current.fusion.valid ? 'GNSS 단독 ' + display(current.baseline.hrms, 2) + ' m' : current.fusion.reason);
  text('current-joint', current.jointPass ? '동시 충족' : !current.commPass && !current.navPass ? '두 조건 미충족' : !current.commPass ? '통신 조건 미충족' : '항법 조건 미충족');
  $('current-joint').classList.toggle('status-good', current.jointPass);
  $('current-joint').classList.toggle('status-warn', !current.jointPass);
  text('current-targets', `통신 ≥ ${config.rateTarget} Mbps · 항법 ≤ ${config.horizontalTarget} m`);
  text('globe-title', `LEO ${config.planes * config.satellitesPerPlane}기 · ${config.altitude.toLocaleString()} km`);
  text('nav-count', `항법 위성 ${current.fusion.satellites}기`);
  text('visible-comm', current.commVisible + '기');
  text('visible-nav', `${current.navVisibleLEO} / ${current.gnssVisible}기` + (config.regional ? ` (+지역 ${current.regionalVisible})` : ''));
  text('pdop', display(current.fusion.pdop, 2)); text('vrms', display(current.fusion.vrms, 2) + ' m');
  text('best-satellite', current.best ? current.best.id + ' · 사용자 다운링크' : '접속 불가');
  text('link-elevation', display(current.best?.elevation, 1) + '°');
  text('link-range', display(current.best?.range, 0) + ' km');
  text('link-delay', display(current.best?.link.delayMs, 2) + ' ms');
  text('link-snr', display(current.best?.link.snr, 1) + ' dB');
  text('link-doppler', display(current.best?.link.dopplerKHz, 1) + ' kHz');
  text('time-label', 'T + ' + clock(minutes)); $('time-slider').value = minutes;
  $('time-slider').setAttribute('aria-valuetext', '기준시각 이후 ' + clock(minutes));
  globe.set(current, orbits); skyPlot($('sky-plot'), current);
  if (view === 'analysis') renderSweep();
}
function acceptConfig(next) {
  const oldLocation = config.location; config = next; orbits = buildConstellations(config);
  updateControlLabels(); clearError(); drawSnapshot(); updateAnalysisNotice();
  if (oldLocation !== config.location) globe.center(LOCATIONS[config.location].lat, LOCATIONS[config.location].lon);
}
form.addEventListener('input', () => {
  clearTimeout(scheduled);
  scheduled = setTimeout(() => { try { acceptConfig(readConfig()); } catch (error) { reportError(error.message); } }, 90);
});
form.addEventListener('submit', event => { event.preventDefault(); runAnalysis(true).catch(() => {}); });

function setView(next) {
  if (!['situation', 'analysis'].includes(next)) throw new Error('화면을 선택해 주세요.');
  view = next;
  for (const id of ['situation', 'analysis']) {
    $(id).hidden = id !== view; $('tab-' + id).classList.toggle('active', id === view);
    $('tab-' + id).setAttribute('aria-selected', String(id === view));
    $('tab-' + id).tabIndex = id === view ? 0 : -1;
  }
  if (next === 'analysis') { pause(); renderAnalysis(); renderSweep(); }
  else globe.draw();
}
for (const id of ['situation', 'analysis']) $('tab-' + id).addEventListener('click', () => setView(id));
document.querySelector('.tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 'situation' : event.key === 'End' ? 'analysis' : view === 'situation' ? 'analysis' : 'situation';
  setView(next); $('tab-' + next).focus();
});
function pause() { clearInterval(playing); playing = null; text('play', '재생'); $('play').setAttribute('aria-pressed', 'false'); }
$('play').addEventListener('click', () => {
  if (playing) { pause(); return; }
  text('play', '일시정지'); $('play').setAttribute('aria-pressed', 'true');
  playing = setInterval(() => { minutes = (minutes + 5) % 1440; drawSnapshot(); }, 350);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
$('time-slider').addEventListener('input', event => { pause(); minutes = Number(event.target.value); drawSnapshot(); });
$('recenter').addEventListener('click', () => globe.center(current.location.lat, current.location.lon));
$('globe-scale').addEventListener('change', event => globe.setFull(event.target.value === 'all'));
$('open-model').addEventListener('click', () => { pause(); $('model-dialog').showModal(); });
$('close-model').addEventListener('click', () => $('model-dialog').close());
$('model-dialog').addEventListener('click', event => { if (event.target === $('model-dialog')) { const box = event.target.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close(); } });

function finishCalculation(error) {
  calculating = false; $('run-analysis').disabled = false; $('analysis-progress').hidden = true;
  text('run-analysis', '24시간 비교 분석');
  if (worker) { worker.terminate(); worker = null; }
  if (error) { reportError(error); text('run-status', '계산을 완료하지 못했습니다.'); analysisReject?.(new Error(error)); }
  else { text('run-status', '완료 · 5분 간격 / 288개 표본'); analysisResolve?.(lastAnalysis); }
  analysisResolve = analysisReject = null;
}
function runAnalysis(navigate = false) {
  try { clearTimeout(scheduled); acceptConfig(readConfig()); } catch (error) { reportError(error.message); return Promise.reject(error); }
  if (calculating) return Promise.reject(new Error('현재 분석이 진행 중입니다.'));
  calculating = true; job++;
  $('run-analysis').disabled = true; text('run-analysis', '분석 중…');
  $('analysis-progress').hidden = false; $('analysis-progress').value = 0; text('run-status', '위성 배치와 항법 오차 계산 중');
  updateAnalysisNotice();
  if (navigate) { setView('analysis'); if (mobileMedia.matches) setMobileCollapsed(true); }
  const promise = new Promise((resolve, reject) => { analysisResolve = resolve; analysisReject = reject; });
  try {
    worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = event => {
      if (event.data.requestId !== job) return;
      if (event.data.type === 'progress') { $('analysis-progress').value = event.data.progress; text('run-status', '분석 중 · ' + event.data.progress + '%'); }
      else if (event.data.type === 'result') {
        lastAnalysis = event.data; renderAnalysis(); updateAnalysisNotice(); $('export-csv').disabled = false; finishCalculation();
      } else finishCalculation(event.data.message);
    };
    worker.onerror = () => finishCalculation('분석을 시작하지 못했습니다. 페이지를 새로 열어 다시 실행해 주세요.');
    worker.postMessage({ config: { ...config }, requestId: job });
  } catch (error) { finishCalculation(error.message); }
  return promise;
}
function renderAnalysis() {
  if (!lastAnalysis) return;
  const { samples, summary: sum, config: used } = lastAnalysis;
  metric('joint-availability', sum.jointAvailability, '%'); metric('comm-availability', sum.commAvailability, '%'); metric('nav-availability', sum.navAvailability, '%');
  text('rate-target-note', '≥ ' + used.rateTarget + ' Mbps'); text('nav-target-note', '수평 RMS ≤ ' + used.horizontalTarget + ' m');
  const points = samples.map(s => ({ ...s, hours: s.minutes / 60 }));
  lineChart($('navigation-chart'), points, [{ key: 'baseline', color: '#8d9fbb', width: 1.5 }, { key: 'hrms', color: '#48d4f0' }], { threshold: used.horizontalTarget, yLabel: '수평 RMS (m)', title: '24시간 GNSS 단독과 선택한 항법 구성의 예측 위치오차' });
  lineChart($('communication-chart'), points, [{ key: 'rate', color: '#f6b75b' }], { threshold: used.rateTarget, yLabel: '처리량 (Mbps)', title: '24시간 단일 사용자 다운링크 처리량' });
  const rows = [
    { name: 'GNSS 단독', median: sum.medianBaseline, availability: sum.baselineAvailability, selected: !used.leoNav && !used.regional },
    { name: used.leoNav ? 'GNSS + LEO' : 'GNSS + LEO (LEO 항법 꺼짐)', median: sum.medianGnssLEO, availability: sum.gnssLeoAvailability, selected: used.leoNav && !used.regional },
  ];
  if (used.regional) rows.push({ name: used.leoNav ? 'GNSS + LEO + 지역항법 예시' : 'GNSS + 지역항법 예시', median: sum.medianHrms, availability: sum.navAvailability, selected: true });
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr'); if (row.selected) tr.className = 'selected-row';
    for (const value of [row.name, display(row.median, 2) + ' m', display(row.availability, 1) + '%']) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    fragment.append(tr);
  }
  $('comparison-rows').replaceChildren(fragment);
  text('comparison-context', LOCATIONS[used.location].name + ' · 동일 시간 표본');
}
function renderSweep() {
  if (view !== 'analysis') return;
  const points = resourceSweep(config, minutes);
  text('sweep-context', 'T + ' + clock(minutes) + ' · 현재 입력값');
  lineChart($('resource-rate-chart'), points, [{ key: 'rate', color: '#f6b75b' }], { xMax: 40, xKey: 'navShare', xLabel: '항법 배정시간 (%)', yLabel: '처리량 (Mbps)', title: '항법 배정시간에 따른 통신 처리량' });
  lineChart($('resource-nav-chart'), points, [{ key: 'hrms', color: '#48d4f0' }], { xMax: 40, xKey: 'navShare', xLabel: '항법 배정시간 (%)', yLabel: '수평 RMS (m)', title: '항법 배정시간에 따른 위치오차' });
}
let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (view === 'analysis') { renderAnalysis(); renderSweep(); } }, 120); }).observe($('workspace'));

function downloadCSV() {
  if (!lastAnalysis) return;
  const used = lastAnalysis.config;
  const headers = ['model_version', 'elapsed_minutes', 'downlink_mbps', 'fusion_horizontal_rms_m', 'gnss_horizontal_rms_m', 'gnss_leo_horizontal_rms_m', 'fusion_pdop', 'one_way_delay_ms', 'comm_visible_leo', 'navigation_leo', 'navigation_gnss', 'navigation_regional', 'comm_target_met', 'nav_target_met', 'joint_targets_met', 'scenario_config_json'];
  const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  const rows = lastAnalysis.samples.map(s => [MODEL_VERSION, s.minutes, s.rate, s.hrms, s.baseline, s.gnssLEO, s.pdop, s.delayMs, s.commVisible, s.leoVisible, s.gnssVisible, s.regionalVisible, s.commPass, s.navPass, s.jointPass, JSON.stringify(used)]);
  const csv = '\ufeff' + [headers, ...rows].map(row => row.map(quote).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = 'KLEO_COMM_PNT_' + used.location + '_24h.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export-csv').addEventListener('click', downloadCSV);

const settingsToggle = document.createElement('button');
settingsToggle.type = 'button'; settingsToggle.className = 'mobile-collapse-button';
settingsToggle.setAttribute('aria-controls', 'configuration');
document.querySelector('.sidebar-title').append(settingsToggle);
function setMobileCollapsed(value) {
  sidebar.classList.toggle('mobile-collapsed', value);
  settingsToggle.textContent = value ? '설정 펼치기' : '설정 접기';
  settingsToggle.setAttribute('aria-expanded', String(!value));
}
settingsToggle.addEventListener('click', () => setMobileCollapsed(!sidebar.classList.contains('mobile-collapsed')));
const advanced = document.createElement('button'); advanced.type = 'button'; advanced.className = 'button mobile-settings-button'; advanced.textContent = '오차·통신 설정 더 보기'; advanced.setAttribute('aria-expanded', 'false');
form.insertBefore(advanced, document.querySelector('.run-controls'));
advanced.addEventListener('click', () => { const show = sidebar.classList.toggle('show-all'); advanced.textContent = show ? '고급 설정 접기' : '오차·통신 설정 더 보기'; advanced.setAttribute('aria-expanded', String(show)); });
setMobileCollapsed(mobileMedia.matches);

// Exposes exactly the same local state transitions as the interface, when supported.
function toolSummary() {
  return { modelVersion: MODEL_VERSION, config: { ...config }, view, elapsedMinutes: minutes,
    current: { downlinkMbps: current.rate, horizontalRmsM: current.fusion.hrms, baselineRmsM: current.baseline.hrms, navigationSatellites: current.fusion.satellites, jointTargetsMet: current.jointPass },
    analysis: lastAnalysis ? { stale: stale(), summary: lastAnalysis.summary } : null, calculating };
}
function configureFromTool(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'settings') || !input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) throw new Error('settings 객체가 필요합니다.');
  const allowed = new Map(fields.map(f => [f.dataset.config, f]));
  for (const [key, value] of Object.entries(input.settings)) {
    const field = allowed.get(key); if (!field) throw new Error('설정할 수 없는 항목: ' + key);
    if (field.tagName === 'SELECT' && ![...field.options].some(o => o.value === String(value))) throw new Error('지원하는 선택값이 아닙니다: ' + key);
    if (field.type === 'range' && ((value - Number(field.min)) / Number(field.step || 1)) % 1 !== 0) throw new Error('설정 간격을 확인해 주세요: ' + key);
  }
  const validated = validateConfig({ ...config, ...input.settings });
  clearTimeout(scheduled);
  for (const field of fields) { if (field.type === 'checkbox') field.checked = validated[field.dataset.config]; else field.value = validated[field.dataset.config]; }
  acceptConfig(validated); return toolSummary();
}
function registerModelTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  const properties = {};
  for (const field of fields) {
    const key = field.dataset.config;
    if (field.type === 'checkbox') properties[key] = { type: 'boolean' };
    else if (field.tagName === 'SELECT') properties[key] = { type: ['location', 'sharing'].includes(key) ? 'string' : 'number', enum: [...field.options].map(o => ['location', 'sharing'].includes(key) ? o.value : Number(o.value)) };
    else properties[key] = { type: 'number', minimum: Number(field.min), maximum: Number(field.max) };
  }
  const tools = [
    { name: 'get_comm_nav_state', title: '통신·항법 상태 읽기', description: '현재 설정, 현재시각의 예측값과 마지막 24시간 분석 요약을 읽습니다. stale은 이전 설정의 결과임을 나타냅니다.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: false }, execute: input => { if (!input || Object.keys(input).length) throw new Error('입력 항목이 없습니다.'); return toolSummary(); } },
    { name: 'configure_comm_nav', title: '통신·항법 설정 변경', description: '화면의 시나리오 설정을 변경하고 현재시각의 결과를 갱신합니다. 24시간 분석은 별도로 실행합니다.', inputSchema: { type: 'object', properties: { settings: { type: 'object', properties, additionalProperties: false } }, required: ['settings'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: configureFromTool },
    { name: 'run_comm_nav_analysis', title: '24시간 비교 분석 실행', description: '현재 화면 설정으로 24시간, 5분 간격 분석을 완료하고 성능 분석 화면에 표시합니다. 결과는 설계모형 예측값입니다.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: async input => { if (!input || Object.keys(input).length) throw new Error('입력 항목이 없습니다.'); const result = await runAnalysis(true); return { config: result.config, summary: result.summary, modelVersion: MODEL_VERSION }; } },
    { name: 'show_comm_nav_view', title: '화면과 설계시각 선택', description: '상황 또는 성능 분석 화면을 선택합니다. elapsedMinutes로 현재 배치 시각만 변경하며 24시간 결과는 변경하지 않습니다.', inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['situation', 'analysis'] }, elapsedMinutes: { type: 'integer', minimum: 0, maximum: 1435, multipleOf: 5 } }, required: ['view'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: input => {
      if (!input || Object.keys(input).some(k => !['view', 'elapsedMinutes'].includes(k)) || !['situation', 'analysis'].includes(input.view)) throw new Error('화면 값을 확인해 주세요.');
      if (input.elapsedMinutes !== undefined && (!Number.isInteger(input.elapsedMinutes) || input.elapsedMinutes < 0 || input.elapsedMinutes > 1435 || input.elapsedMinutes % 5 !== 0)) throw new Error('시각은 0–1435분의 5분 간격이어야 합니다.');
      pause(); if (input.elapsedMinutes !== undefined) minutes = input.elapsedMinutes; drawSnapshot(); setView(input.view); return toolSummary();
    } },
  ];
  for (const tool of tools) {
    try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {}
  }
}
updateControlLabels(); drawSnapshot(); globe.center(current.location.lat, current.location.lon);
setView('situation'); registerModelTools();
runAnalysis(false).catch(() => {});
