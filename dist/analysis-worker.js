import { validateConfig, buildConstellations, prepareGeometry, evaluateSnapshot, compactSample, summarize, MODEL_VERSION } from './engine.js';
self.addEventListener('message', event => {
  const { config, requestId } = event.data;
  try {
    const cfg = validateConfig(config), constellation = buildConstellations(cfg), samples = [];
    for (let minutes = 0; minutes < cfg.periodMinutes; minutes += cfg.stepMinutes) {
      // cfg is already validated above; skip snapshot()'s re-validation on each sample.
      samples.push(compactSample(evaluateSnapshot(cfg, prepareGeometry(cfg, minutes, constellation))));
      // minutes is always an exact multiple of stepMinutes here, so this lands on every 24th
      // sample exactly (matching the original fixed 5-minute-step cadence of one update per
      // 120 minutes), regardless of the configured step.
      if (minutes % (cfg.stepMinutes * 24) === 0) self.postMessage({ type: 'progress', requestId, progress: Math.round(minutes / cfg.periodMinutes * 100) });
    }
    self.postMessage({ type: 'result', requestId, config: cfg, samples, summary: summarize(samples, cfg), modelVersion: MODEL_VERSION });
  } catch (error) {
    self.postMessage({ type: 'error', requestId, message: error.message || '계산을 완료하지 못했습니다.' });
  }
});
