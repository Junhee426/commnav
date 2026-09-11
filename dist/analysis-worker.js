import { validateConfig, buildConstellations, snapshot, compactSample, summarize, MODEL_VERSION } from './engine.js';
self.addEventListener('message', event => {
  const { config, requestId } = event.data;
  try {
    const cfg = validateConfig(config), constellation = buildConstellations(cfg), samples = [];
    for (let minutes = 0; minutes < 1440; minutes += 5) {
      samples.push(compactSample(snapshot(cfg, minutes, constellation)));
      if (minutes % 120 === 0) self.postMessage({ type: 'progress', requestId, progress: Math.round(minutes / 1440 * 100) });
    }
    self.postMessage({ type: 'result', requestId, config: cfg, samples, summary: summarize(samples, cfg), modelVersion: MODEL_VERSION });
  } catch (error) {
    self.postMessage({ type: 'error', requestId, message: error.message || '계산을 완료하지 못했습니다.' });
  }
});
