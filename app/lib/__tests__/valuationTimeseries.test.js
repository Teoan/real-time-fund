import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  pruneSeries,
  recordValuation,
  getValuationSeries,
  setValuationSeries,
  bindTimeseriesStorage,
  getAllValuationSeries,
  getAllValuationSeriesRaw,
  replaceAllValuationSeriesRaw,
  clearFund,
  storageKeyForCode,
  isTimeseriesPersistDegraded,
  clearTimeseriesPersistDegraded,
  __resetTimeseriesCache,
  MAX_TRADING_DAYS,
  MAX_POINTS_PER_DAY
} from '../valuationTimeseries.js';
import { TIMESERIES_LEGACY_KEY } from '../storageKeys.js';

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

describe('valuationTimeseries — 按基金拆键（P0 写放大修复）', () => {
  let store;
  let adapter;
  let writes;

  const createAdapter = () => {
    store = new Map();
    writes = [];
    return {
      getItem: (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
      setItem: (k, raw) => {
        writes.push(k);
        store.set(k, raw);
      },
      removeItem: (k) => store.delete(k),
      keysWithPrefix: (prefix) => Array.from(store.keys()).filter((k) => k.startsWith(prefix))
    };
  };

  beforeEach(() => {
    adapter = createAdapter();
    bindTimeseriesStorage(adapter);
  });

  it('每只基金写自己的 key，一次写入只序列化这一只', () => {
    recordValuation('110022', { gsz: 1.1, gszzl: 0.5, gztime: '2026-03-20 10:00' });
    recordValuation('161725', { gsz: 2.2, gszzl: 1.5, gztime: '2026-03-20 10:01' });
    recordValuation('110022', { gsz: 1.2, gszzl: 0.6, gztime: '2026-03-20 10:02' });

    assert.deepEqual(
      writes,
      [storageKeyForCode('110022'), storageKeyForCode('161725'), storageKeyForCode('110022')],
      '第 3 次写入只碰 110022 自己的 key'
    );
    assert.equal(store.has(TIMESERIES_LEGACY_KEY), false);
    // 每只基金各自的 key 里只有自己的数据
    assert.deepEqual(Object.keys(JSON.parse(store.get(storageKeyForCode('161725')))), ['1']);
    assert.equal(JSON.parse(store.get(storageKeyForCode('110022')))['1'].length, 2);
  });

  it('旧版单一大 key 首次读取时自动迁移为分键并删除', () => {
    store.set(
      TIMESERIES_LEGACY_KEY,
      JSON.stringify({
        110022: { 1: [{ date: '2026-03-20', time: '10:00', gsz: 1.5, gszzl: 1 }] },
        161725: { 2: [{ date: '2026-03-20', time: '10:00', gsz: 2.5, gszzl: 2 }] }
      })
    );

    assert.equal(getValuationSeries('110022', 1)[0].gsz, 1.5);
    assert.equal(getValuationSeries('161725', 2)[0].gsz, 2.5);
    assert.equal(store.has(TIMESERIES_LEGACY_KEY), false, '旧 key 迁移完应删除');
    assert.equal(store.has(storageKeyForCode('110022')), true);
    assert.equal(store.has(storageKeyForCode('161725')), true);
  });

  it('getAllValuationSeriesRaw 把分键重新组装成整块（云端同步载荷形状不变）', () => {
    recordValuation('110022', { gsz: 1.1, gszzl: 0.5, gztime: '2026-03-20 10:00' });
    recordValuation('161725', { gsz: 2.2, gszzl: 1.5, gztime: '2026-03-20 10:01' }, 2);

    const raw = getAllValuationSeriesRaw();
    assert.deepEqual(Object.keys(raw).sort(), ['110022', '161725']);
    assert.equal(raw['110022']['1'].length, 1);
    assert.equal(raw['161725']['2'].length, 1);

    // 返回的必须是副本：外部合并时原地修改不能污染内存镜像
    raw['110022']['1'].push({ date: '2026-03-21', time: '09:30', gsz: 9, gszzl: 9 });
    assert.equal(getValuationSeries('110022', 1).length, 1);
  });

  it('replaceAllValuationSeriesRaw 覆盖本地并落盘', () => {
    recordValuation('110022', { gsz: 1.1, gszzl: 0.5, gztime: '2026-03-20 10:00' });
    replaceAllValuationSeriesRaw({
      110022: { 1: [{ date: '2026-03-25', time: '14:00', gsz: 1.9, gszzl: 3 }] },
      '006282': { 1: [{ date: '2026-03-25', time: '14:01', gsz: 2.9, gszzl: 4 }] }
    });

    assert.equal(getValuationSeries('110022', 1)[0].gsz, 1.9);
    assert.equal(getValuationSeries('006282', 1)[0].gsz, 2.9);
    assert.equal(JSON.parse(store.get(storageKeyForCode('110022')))['1'][0].gsz, 1.9);
  });

  it('clearFund 只删自己那把 key', () => {
    recordValuation('110022', { gsz: 1.1, gszzl: 0.5, gztime: '2026-03-20 10:00' });
    recordValuation('161725', { gsz: 2.2, gszzl: 1.5, gztime: '2026-03-20 10:01' });
    clearFund('110022');

    assert.equal(store.has(storageKeyForCode('110022')), false);
    assert.equal(store.has(storageKeyForCode('161725')), true);
    assert.deepEqual(getAllValuationSeries(), { 161725: getAllValuationSeries()['161725'] });
  });

  it('适配器没有 keysWithPrefix 时仍能读到写过的基金（纯内存兜底）', () => {
    const memoryOnly = {
      getItem: (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
      setItem: (k, raw) => store.set(k, raw)
    };
    bindTimeseriesStorage(memoryOnly);
    recordValuation('110022', { gsz: 1.1, gszzl: 0.5, gztime: '2026-03-20 10:00' });

    assert.equal(getAllValuationSeries()['110022'].length, 1);
  });
});
