import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  medianOf,
  computeRelativePercentile,
  createPeerPool,
  PEER_POOL_MAX_FUNDS,
  PEER_POOL_MAX_AGE_DAYS
} from '../valuationPeerPool.js';

describe('medianOf', () => {
  it('奇数个取中间', () => {
    assert.equal(medianOf([3, 1, 2]), 2);
  });

  it('偶数个取中间两个的平均', () => {
    assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  });

  it('忽略非法值，空数组 → null', () => {
    assert.equal(medianOf([1, NaN, 3, null]), 2);
    assert.equal(medianOf([]), null);
    assert.equal(medianOf(null), null);
  });
});

describe('computeRelativePercentile', () => {
  it('基金分位 − 池内中位，保留 1 位', () => {
    assert.equal(computeRelativePercentile(78, 62), 16);
    assert.equal(computeRelativePercentile(45, 62), -17);
    assert.equal(computeRelativePercentile(50, 62.35), -12.4);
  });

  it('任一缺失 → null', () => {
    assert.equal(computeRelativePercentile(null, 62), null);
    assert.equal(computeRelativePercentile(78, null), null);
    assert.equal(computeRelativePercentile(NaN, 62), null);
  });
});

describe('createPeerPool', () => {
  const makePool = ({ now } = {}) => {
    const mem = new Map();
    const pool = createPeerPool({
      getItem: (k, d) => (mem.has(k) ? mem.get(k) : d),
      setItem: (k, v) => mem.set(k, v),
      key: 'testPool',
      now
    });
    return { pool, mem };
  };

  it('记录后可以取到池内中位分位', () => {
    const { pool } = makePool();
    pool.record({
      code: 'F1',
      perStockPercents: [
        { code: 'A', pe: 20 },
        { code: 'B', pe: 40 }
      ]
    });
    pool.record({ code: 'F2', perStockPercents: [{ code: 'C', pe: 60 }] });
    // [20, 40, 60] → 中位 40
    assert.equal(pool.getPeerMedian('pe'), 40);
    assert.deepEqual(pool.getPoolStats(), { funds: 2, stocks: 3 });
  });

  it('同一基金再次记录 → 覆盖旧快照（持仓会换血）', () => {
    const { pool } = makePool();
    pool.record({ code: 'F1', perStockPercents: [{ code: 'A', pe: 10 }] });
    pool.record({ code: 'F1', perStockPercents: [{ code: 'Z', pe: 90 }] });
    assert.equal(pool.getPeerMedian('pe'), 90);
    assert.equal(pool.getPoolStats().funds, 1);
  });

  it('超过 45 天的条目不再参与中位数', () => {
    const day = 24 * 60 * 60 * 1000;
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    let clock = t0;
    const { pool } = makePool({ now: () => clock });
    pool.record({ code: 'OLD', perStockPercents: [{ code: 'A', pe: 10 }] });
    clock = t0 + 60 * day;
    pool.record({ code: 'NEW', perStockPercents: [{ code: 'B', pe: 90 }] });
    assert.equal(pool.getPeerMedian('pe'), 90);
    assert.equal(pool.getPoolStats().funds, 1);
  });

  it('基金数超上限时保留最新的', () => {
    const mem = new Map();
    const pool = createPeerPool({
      getItem: (k, d) => (mem.has(k) ? mem.get(k) : d),
      setItem: (k, v) => mem.set(k, v),
      key: 'k'
    });
    for (let i = 0; i < PEER_POOL_MAX_FUNDS + 5; i += 1) {
      pool.record({
        code: `F${i}`,
        perStockPercents: [{ code: `S${i}`, pe: 50 }],
        updatedAt: `2026-03-${String((i % 28) + 1).padStart(2, '0')}`
      });
    }
    assert.ok(pool.getPoolStats().funds <= PEER_POOL_MAX_FUNDS);
  });

  it('空记录 / 非法输入不写入', () => {
    const { pool } = makePool();
    pool.record({ code: '', perStockPercents: [{ code: 'A', pe: 10 }] });
    pool.record({ code: 'F1', perStockPercents: [] });
    assert.equal(pool.getPoolStats().funds, 0);
    assert.equal(pool.getPeerMedian('pe'), null);
  });

  it('损坏的存储值被当作空池', () => {
    const pool = createPeerPool({ getItem: () => 'oops', setItem: () => {}, key: 'k' });
    assert.equal(pool.getPeerMedian('pe'), null);
    assert.deepEqual(pool.getPoolStats(), { funds: 0, stocks: 0 });
  });

  it('常量口径：上限 200 只基金 / 45 天过期', () => {
    assert.equal(PEER_POOL_MAX_FUNDS, 200);
    assert.equal(PEER_POOL_MAX_AGE_DAYS, 45);
  });
});
