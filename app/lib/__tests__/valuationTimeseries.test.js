import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  pruneSeries,
  recordValuation,
  getValuationSeries,
  setValuationSeries,
  isTimeseriesPersistDegraded,
  clearTimeseriesPersistDegraded,
  __resetTimeseriesCache,
  MAX_TRADING_DAYS,
  MAX_POINTS_PER_DAY
} from '../valuationTimeseries.js';

const pt = (date, time, gsz = 1, gszzl = 0) => ({ date, time, gsz, gszzl });

describe('pruneSeries（§3.10 容量与结构）', () => {
  it('只保留最近 MAX_TRADING_DAYS 个交易日', () => {
    const series = [];
    for (let d = 1; d <= 8; d++) series.push(pt(`2026-03-0${d}`, '10:00'));
    const kept = pruneSeries(series);
    assert.equal(new Set(kept.map((p) => p.date)).size, MAX_TRADING_DAYS);
    assert.equal(kept[0].date, '2026-03-04');
  });

  it('同日同分钟去重，保留后写入者', () => {
    const kept = pruneSeries([pt('2026-03-20', '10:00', 1.1, 1), pt('2026-03-20', '10:00', 1.2, 2)]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].gsz, 1.2);
    assert.equal(kept[0].gszzl, 2);
  });

  it('单日超量丢最早，保住最新走势', () => {
    const series = [];
    for (let i = 0; i < MAX_POINTS_PER_DAY + 20; i++) {
      const h = String(9 + Math.floor(i / 60)).padStart(2, '0');
      const m = String(i % 60).padStart(2, '0');
      series.push(pt('2026-03-20', `${h}:${m}`, i, i));
    }
    const kept = pruneSeries(series);
    assert.equal(kept.length, MAX_POINTS_PER_DAY);
    assert.equal(kept[kept.length - 1].gsz, MAX_POINTS_PER_DAY + 19);
  });

  it('兼容旧格式 { time, value, date }，且 gsz 与 gszzl 都空时丢弃', () => {
    const kept = pruneSeries([
      { date: '2026-03-20', time: '10:00', value: 1.5 },
      { date: '2026-03-20', time: '10:01' }
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].gsz, 1.5);
    assert.equal(kept[0].gszzl, null);
  });

  it('非数组输入返回空数组', () => {
    assert.deepEqual(pruneSeries(null), []);
    assert.deepEqual(pruneSeries(undefined), []);
  });
});

describe('recordValuation（§3.10 写入）', () => {
  beforeEach(() => __resetTimeseriesCache());

  it('带 gszzl / dwjz 落盘，同日同分钟覆盖', () => {
    recordValuation('110022', { gsz: 1.1, gszzl: 0.5, dwjz: 1.094, gztime: '2026-03-20 10:00' });
    recordValuation('110022', { gsz: 1.2, gszzl: 1.5, dwjz: 1.094, gztime: '2026-03-20 10:00' });
    const series = getValuationSeries('110022');
    assert.equal(series.length, 1);
    assert.equal(series[0].gsz, 1.2);
    assert.equal(series[0].gszzl, 1.5);
    assert.equal(series[0].dwjz, 1.094);
  });

  it('跨日累加而不清空（旧实现新日期会整段替换）', () => {
    recordValuation('110022', { gsz: 1.0, gszzl: 0.1, gztime: '2026-03-19 14:00' });
    recordValuation('110022', { gsz: 1.1, gszzl: 0.2, gztime: '2026-03-20 10:00' });
    const series = getValuationSeries('110022');
    assert.equal(series.length, 2);
    assert.equal(series[0].date, '2026-03-19');
  });

  it('数据源之间互不干扰', () => {
    recordValuation('110022', { gsz: 1.0, gszzl: 0.1, gztime: '2026-03-20 10:00' }, 1);
    recordValuation('110022', { gsz: 1.0, gszzl: 0.9, gztime: '2026-03-20 10:00' }, 2);
    assert.equal(getValuationSeries('110022', 1)[0].gszzl, 0.1);
    assert.equal(getValuationSeries('110022', 2)[0].gszzl, 0.9);
  });

  it('setValuationSeries 也走清洗与截断', () => {
    const raw = [];
    for (let d = 1; d <= 8; d++) raw.push(pt(`2026-03-0${d}`, '10:00'));
    setValuationSeries('110022', 3, raw);
    assert.equal(getValuationSeries('110022', 3).length, MAX_TRADING_DAYS);
  });

  it('无 gsz 无 gszzl 的点被忽略', () => {
    recordValuation('110022', { gztime: '2026-03-20 10:00' });
    assert.equal(getValuationSeries('110022').length, 0);
  });

  it('降级标记可复位', () => {
    clearTimeseriesPersistDegraded();
    assert.equal(isTimeseriesPersistDegraded(), false);
  });
});
