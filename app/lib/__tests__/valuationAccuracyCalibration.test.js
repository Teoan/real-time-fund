import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeSamples,
  calibrateEstimate,
  upsertSample,
  settleSample,
  ACCURACY_WINDOW,
  ACCURACY_CALIBRATION_MIN_SAMPLES,
  ACCURACY_BIAS_THRESHOLD
} from '../valuationAccuracy.js';

/** 造 n 条已配对样本：估算恒为 actual + bias */
const samplesWithBias = (n, bias, val = 1) =>
  Array.from({ length: n }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, '0');
    const actual = val;
    return { date: `2026-03-${day}`, source: '1', estimate: actual + bias, actual };
  });

describe('summarizeSamples：近 20 日窗口（§4.8）', () => {
  it('recent 只统计最近 20 个已配对样本', () => {
    // 前 30 天偏差 +1.0，最近 20 天偏差 0：全历史 bias > 0，近期 bias ≈ 0
    const old20 = samplesWithBias(30, 1, 1).map((s, i) => ({
      ...s,
      date: `2026-01-${String(i + 1).padStart(2, '0')}`
    }));
    const recent = Array.from({ length: ACCURACY_WINDOW }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, '0')}`,
      source: '1',
      estimate: 1,
      actual: 1
    }));
    const summary = summarizeSamples([...old20, ...recent]);
    assert.equal(summary.recent.samples, ACCURACY_WINDOW);
    assert.equal(summary.recent.bias, 0);
    assert.ok(summary.bias > 0);
  });

  it('样本里的 pending（未配对）不进统计，但会计数', () => {
    const settled = samplesWithBias(5, 0.5);
    const summary = summarizeSamples([...settled, { date: '2026-04-01', source: '1', estimate: 1.2 }]);
    assert.equal(summary.samples, 5);
    assert.equal(summary.pending, 1);
  });

  it('rmse 与 mae 同时给出，且 rmse >= mae', () => {
    const summary = summarizeSamples([
      { date: '2026-03-01', estimate: 1.3, actual: 1 },
      { date: '2026-03-02', estimate: 0.9, actual: 1 }
    ]);
    assert.ok(summary.rmse >= summary.mae);
  });
});

describe('calibrateEstimate（§4.8 校准估值）', () => {
  it('样本不足 20 → 不校准', () => {
    const summary = summarizeSamples(samplesWithBias(ACCURACY_CALIBRATION_MIN_SAMPLES - 1, 0.5));
    const out = calibrateEstimate(1.2, summary);
    assert.equal(out.applied, false);
    assert.equal(out.reason, 'insufficient');
    assert.equal(out.value, 1.2);
  });

  it('系统偏差小于阈值 → 视为噪声，不校准', () => {
    const summary = summarizeSamples(samplesWithBias(ACCURACY_CALIBRATION_MIN_SAMPLES, ACCURACY_BIAS_THRESHOLD / 2));
    const out = calibrateEstimate(1.2, summary);
    assert.equal(out.applied, false);
    assert.equal(out.reason, 'not-significant');
  });

  it('系统性高估 → 估值下调，并给出校准依据', () => {
    const summary = summarizeSamples(samplesWithBias(25, 0.4));
    const out = calibrateEstimate(1.2, summary);
    assert.equal(out.applied, true);
    assert.equal(out.value, 0.8); // 1.2 - 0.4
    assert.equal(out.adjustment, -0.4);
    assert.equal(out.samples, ACCURACY_WINDOW); // 校准只用窗口内的 20 条
  });

  it('系统性低估 → 估值上调', () => {
    const summary = summarizeSamples(samplesWithBias(25, -0.4));
    const out = calibrateEstimate(1.2, summary);
    assert.equal(out.applied, true);
    assert.equal(out.value, 1.6);
  });

  it('估算值非法 → reason = invalid', () => {
    const summary = summarizeSamples(samplesWithBias(25, 0.4));
    for (const bad of [null, undefined, NaN, '1.2']) {
      const out = calibrateEstimate(bad, summary);
      assert.equal(out.applied, false);
      assert.equal(out.reason, 'invalid');
    }
  });

  it('没有样本 → reason = no-data', () => {
    assert.equal(calibrateEstimate(1.2, null).reason, 'no-data');
    assert.equal(calibrateEstimate(1.2, summarizeSamples([])).reason, 'no-data');
  });
});

describe('upsertSample / settleSample 配对链路', () => {
  it('同日重复估算覆盖数值但保留已回填的确权值', () => {
    let list = upsertSample([], { date: '2026-03-20', estimate: 1.0, source: '1' });
    list = settleSample(list, { date: '2026-03-20', actual: 0.8 });
    list = upsertSample(list, { date: '2026-03-20', estimate: 1.1, source: '1' });
    assert.equal(list.length, 1);
    assert.equal(list[0].estimate, 1.1);
    assert.equal(list[0].actual, 0.8);
    assert.equal(list[0].signedErr, 0.3);
  });

  it('没有对应估算样本时 settle 不动数组（同一引用）', () => {
    const list = upsertSample([], { date: '2026-03-19', estimate: 1 });
    assert.equal(settleSample(list, { date: '2026-03-20', actual: 1 }), list);
  });
});
