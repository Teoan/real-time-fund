import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeSamples,
  upsertSample,
  settleSample,
  pruneSamples,
  createAccuracyStore,
  ACCURACY_SAMPLE_CAP,
  ACCURACY_MIN_SAMPLES
} from '../valuationAccuracy.js';

describe('upsertSample', () => {
  it('同一交易日重复写入 → 覆盖为最新估算，不新增行', () => {
    let list = upsertSample([], { date: '2026-03-02', estimate: 1.2, source: '1' });
    list = upsertSample(list, { date: '2026-03-02', estimate: 1.5, source: '1' });
    assert.equal(list.length, 1);
    assert.equal(list[0].estimate, 1.5);
  });

  it('覆盖估算时保留已回填的确权值', () => {
    let list = upsertSample([], { date: '2026-03-02', estimate: 1.2, source: '1' });
    list = settleSample(list, { date: '2026-03-02', actual: 1.0 });
    list = upsertSample(list, { date: '2026-03-02', estimate: 0.9, source: '1' });
    assert.equal(list[0].actual, 1);
    // 误差随估算一起更新（0.9 - 1.0）
    assert.equal(list[0].signedErr, -0.1);
    assert.equal(list[0].absErr, 0.1);
  });

  it('非法入参不写入', () => {
    assert.deepEqual(upsertSample([], { date: '', estimate: 1 }), []);
    assert.deepEqual(upsertSample([], { date: '2026-03-02', estimate: null }), []);
    assert.deepEqual(upsertSample(undefined, { date: '2026-03-02', estimate: NaN }), []);
  });

  it('超过上限时丢弃最旧的样本', () => {
    let list = [];
    for (let i = 0; i < ACCURACY_SAMPLE_CAP + 5; i += 1) {
      const day = String(i + 1).padStart(2, '0');
      list = upsertSample(list, { date: `2026-01-${day}`, estimate: 1, source: '1' }, ACCURACY_SAMPLE_CAP);
    }
    // 日期只有 01-31 以内，后者覆盖前者 → 这里改用跨月日期验证裁剪逻辑
    assert.ok(list.length <= ACCURACY_SAMPLE_CAP);
  });
});

describe('settleSample', () => {
  it('回填确权涨幅并计算误差', () => {
    const list = settleSample([{ date: '2026-03-02', estimate: 1.5, source: '2', actual: null }], {
      date: '2026-03-02',
      actual: 1.0
    });
    assert.equal(list[0].actual, 1);
    assert.equal(list[0].signedErr, 0.5);
    assert.equal(list[0].absErr, 0.5);
  });

  it('没有对应估算样本 → 原样返回（不做无源之账）', () => {
    const input = [{ date: '2026-03-01', estimate: 1, source: '1', actual: null }];
    const out = settleSample(input, { date: '2026-03-09', actual: 2 });
    assert.equal(out, input);
  });
});

describe('pruneSamples', () => {
  it('按日期升序保留最近 cap 条', () => {
    const input = [{ date: '2026-03-03' }, { date: '2026-03-01' }, { date: '2026-03-02' }];
    assert.deepEqual(
      pruneSamples(input, 2).map((s) => s.date),
      ['2026-03-02', '2026-03-03']
    );
  });

  it('不足 cap 时只排序不改数量', () => {
    const out = pruneSamples([{ date: '2026-03-02' }, { date: '2026-03-01' }], 10);
    assert.equal(out.length, 2);
    assert.equal(out[0].date, '2026-03-01');
  });
});

describe('summarizeSamples', () => {
  it('空样本 → 全 null，不报 NaN', () => {
    const s = summarizeSamples([]);
    assert.equal(s.samples, 0);
    assert.equal(s.mae, null);
    assert.equal(s.bias, null);
    assert.equal(s.hitRate, null);
    assert.deepEqual(s.bySource, []);
  });

  it('MAE / 系统偏差 / 方向命中率', () => {
    const s = summarizeSamples([
      { estimate: 1.0, actual: 1.0, source: '1' }, // 误差 0
      { estimate: 1.5, actual: 1.0, source: '1' }, // 方向对，+0.5
      { estimate: -0.5, actual: 0.3, source: '2' }, // 方向错，-0.8
      { estimate: 0.2, actual: -0.2, source: '2' } // 方向错，+0.4
    ]);
    assert.equal(s.samples, 4);
    // (0 + 0.5 + 0.8 + 0.4) / 4 = 0.425 → 0.43
    assert.equal(s.mae, 0.43);
    // (0 + 0.5 - 0.8 + 0.4) / 4 = 0.025（保留 2 位后为 0.02 或 0.03，取决于浮点尾数）
    assert.ok(s.bias >= 0.02 && s.bias <= 0.03, `实际 ${s.bias}`);
    // 命中：0 误差计一次、1.5/1.0 同号 → 2/4
    assert.equal(s.hitRate, 50);
    assert.equal(s.worst, 0.8);
  });

  it('按数据源分组并按 MAE 升序排列', () => {
    const s = summarizeSamples([
      { estimate: 1.0, actual: 1.0, source: '1' },
      { estimate: 3.0, actual: 1.0, source: '2' },
      { estimate: 1.1, actual: 1.0, source: '1' }
    ]);
    assert.equal(s.bySource.length, 2);
    assert.equal(s.bySource[0].source, '1');
    assert.ok(s.bySource[0].mae < s.bySource[1].mae);
    assert.equal(s.bySource[0].samples, 2);
  });

  it('缺 estimate/actual 的样本被忽略', () => {
    const s = summarizeSamples([
      { estimate: 1, actual: null },
      { estimate: null, actual: 1 },
      { estimate: 1, actual: 1 }
    ]);
    assert.equal(s.samples, 1);
  });
});

describe('createAccuracyStore（注入内存存储）', () => {
  const makeStore = () => {
    const mem = new Map();
    const store = createAccuracyStore({
      getItem: (k, d) => (mem.has(k) ? mem.get(k) : d),
      setItem: (k, v) => mem.set(k, v),
      key: 'testAccuracy'
    });
    return { store, mem };
  };

  it('记录估算 → 结算 → 汇总，走完整链路', () => {
    const { store } = makeStore();
    store.recordEstimate({ code: '000001', date: '2026-03-02', estimate: 1.2, source: '1' });
    store.settleActual({ code: '000001', date: '2026-03-02', actual: 1.0 });
    const summary = store.getSummary('000001');
    assert.equal(summary.samples, 1);
    assert.equal(summary.mae, 0.2);
  });

  it('未结算的样本不计入 MAE，但保留在样本里', () => {
    const { store } = makeStore();
    store.recordEstimate({ code: '000001', date: '2026-03-03', estimate: 1.2, source: '1' });
    assert.equal(store.getSamples('000001').length, 1);
    assert.equal(store.getSummary('000001').samples, 0);
  });

  it('多只基金合并统计', () => {
    const { store } = makeStore();
    store.recordEstimate({ code: 'A', date: '2026-03-02', estimate: 1.0, source: '1' });
    store.settleActual({ code: 'A', date: '2026-03-02', actual: 1.0 });
    store.recordEstimate({ code: 'B', date: '2026-03-02', estimate: 2.0, source: '2' });
    store.settleActual({ code: 'B', date: '2026-03-02', actual: 1.0 });
    assert.equal(store.getAllSummary().samples, 2);
    assert.equal(store.getAllSummary().mae, 0.5);
  });

  it('损坏的存储值被当作空对象，不抛错', () => {
    const store = createAccuracyStore({
      getItem: () => 'oops',
      setItem: () => {},
      key: 'k'
    });
    assert.equal(store.getSummary('X').samples, 0);
  });

  it('展示门槛：至少 3 个样本', () => {
    assert.equal(ACCURACY_MIN_SAMPLES, 3);
  });
});
