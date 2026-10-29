import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateYtdReturnRate, normalizeEarningsItem, resolveEarningsItemCost } from '../ytdReturn.js';

const YEAR = 2026;

test('YTD：缺成本快照的记录不进分子（分子分母同集合）', () => {
  const map = {
    A: [{ date: `${YEAR}-01-05`, earnings: 10, baseCostAmount: 1000 }],
    // B 没有 baseCostAmount 也没有 rate → 无法确定当日成本口径，整条跳过
    B: [{ date: `${YEAR}-01-05`, earnings: 10 }]
  };
  // 旧实现：分子 10 + 10 = 20，分母只有 1000 → 2.00%（错误，翻倍）
  assert.equal(calculateYtdReturnRate(map, { currentYear: YEAR }), 1);
});

test('YTD：全部记录都无法确定成本时返回 null', () => {
  const map = { A: [{ date: `${YEAR}-01-05`, earnings: 10 }] };
  assert.equal(calculateYtdReturnRate(map, { currentYear: YEAR }), null);
  assert.equal(calculateYtdReturnRate({}, { currentYear: YEAR }), null);
  assert.equal(calculateYtdReturnRate(null, { currentYear: YEAR }), null);
});

test('YTD：按日累乘，两日各 +1% 得 +2.01%', () => {
  const map = {
    A: [
      { date: `${YEAR}-01-05`, earnings: 10, baseCostAmount: 1000 },
      { date: `${YEAR}-01-06`, earnings: 10.1, baseCostAmount: 1010 }
    ]
  };
  assert.equal(calculateYtdReturnRate(map, { currentYear: YEAR }), 2.01);
});

test('YTD：先 +1% 再 -1% 得 -0.01%（累乘而非相加）', () => {
  const map = {
    A: [
      { date: `${YEAR}-01-05`, earnings: 10, baseCostAmount: 1000 },
      { date: `${YEAR}-01-06`, earnings: -10, baseCostAmount: 1000 }
    ]
  };
  assert.equal(calculateYtdReturnRate(map, { currentYear: YEAR }), -0.01);
});

test('YTD：跨年记录被忽略', () => {
  const map = {
    A: [
      { date: `${YEAR - 1}-12-31`, earnings: 500, baseCostAmount: 1000 },
      { date: `${YEAR}-01-05`, earnings: 10, baseCostAmount: 1000 }
    ]
  };
  assert.equal(calculateYtdReturnRate(map, { currentYear: YEAR }), 1);
});

test('YTD：可用 rate 反推当日成本', () => {
  const map = { A: [{ date: `${YEAR}-02-02`, earnings: 5, rate: 0.5 }] };
  // 5 / (0.5/100) = 1000 → 0.5%
  assert.equal(calculateYtdReturnRate(map, { currentYear: YEAR }), 0.5);
});

test('YTD：不再接受持仓参数，第二参数不会改变结果（无 look-ahead）', () => {
  const map = { A: [{ date: `${YEAR}-01-05`, earnings: 10, baseCostAmount: 1000 }] };
  const base = calculateYtdReturnRate(map, { currentYear: YEAR });
  const withLegacyHoldings = calculateYtdReturnRate(map, { currentYear: YEAR }, { A: { share: 100, cost: 99 } });
  assert.equal(withLegacyHoldings, base);
});

test('YTD：同日同 code 重复记录以最后一条为准（成本不被重复累加）', () => {
  const map = {
    A: [
      { date: `${YEAR}-01-05`, earnings: 5, baseCostAmount: 1000 },
      { date: `${YEAR}-01-05`, earnings: 5, baseCostAmount: 1000 }
    ]
  };
  // 若按行累加，分子 10 / 分母 2000 会变成 0.5% 的「正确巧合」，但口径应是 5/1000 = 0.5%
  assert.equal(calculateYtdReturnRate(map, { currentYear: YEAR }), 0.5);
});

test('YTD：非法记录被剔除', () => {
  const map = {
    A: [
      { date: '2026/01/05', earnings: 10, baseCostAmount: 1000 },
      { date: `${YEAR}-01-06`, earnings: Number.NaN, baseCostAmount: 1000 },
      { date: `${YEAR}-01-07`, earnings: 10, baseCostAmount: 1000 }
    ]
  };
  assert.equal(calculateYtdReturnRate(map, { currentYear: YEAR }), 1);
});

test('normalizeEarningsItem：保留 rate / baseCostAmount，非法值归零', () => {
  assert.deepEqual(normalizeEarningsItem({ date: '2026-01-05', earnings: 1, rate: null, baseCostAmount: -1 }), {
    date: '2026-01-05',
    earnings: 1,
    rate: null,
    baseCostAmount: null
  });
  assert.equal(normalizeEarningsItem(null), null);
  assert.equal(normalizeEarningsItem({ date: '2026-1-5', earnings: 1 }), null);
});

test('resolveEarningsItemCost：快照优先，rate=0 不反推', () => {
  assert.equal(resolveEarningsItemCost({ earnings: 5, rate: 1, baseCostAmount: 800 }), 800);
  assert.equal(resolveEarningsItemCost({ earnings: 5, rate: 1, baseCostAmount: null }), 500);
  assert.equal(resolveEarningsItemCost({ earnings: 5, rate: 0, baseCostAmount: null }), 0);
  assert.equal(resolveEarningsItemCost({ earnings: -5, rate: -2, baseCostAmount: null }), 250);
});
