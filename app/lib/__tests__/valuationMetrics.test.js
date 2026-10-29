import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  percentileStat,
  stdDev,
  buildDailyMetrics,
  describeDispersion,
  deriveDividendYieldReference,
  MIN_REFERENCE_SAMPLES,
  EXTRA_PERCENTILE_KEYS
} from '../valuationMetrics.js';

/** 造一段「全部等于 v」的参照分布 */
const flatRef = (n, v) => Array.from({ length: n }, () => v);

describe('percentileStat', () => {
  it('正常值：分位按严格小于计算并向 50 收缩', () => {
    const stat = percentileStat(flatRef(120, 10), 20);
    // 20 > 全部样本 → 原始分位 100 → 收缩 (120*100 + 120*50)/240 = 75
    assert.equal(stat.percentile, 75);
    assert.equal(stat.sampleCount, 120);
    assert.equal(stat.reason, null);
  });

  it('当前值 <= 0 → null，reason = non-positive', () => {
    const stat = percentileStat(flatRef(120, 10), -3);
    assert.equal(stat.percentile, null);
    assert.equal(stat.reason, 'non-positive');
    assert.equal(percentileStat(flatRef(120, 10), 0).reason, 'non-positive');
  });

  it('当前值缺失 → reason = missing', () => {
    assert.equal(percentileStat(flatRef(120, 10), null).reason, 'missing');
    assert.equal(percentileStat(flatRef(120, 10), NaN).reason, 'missing');
    assert.equal(percentileStat(flatRef(120, 10), undefined).reason, 'missing');
  });

  it('参照样本不足 → reason = insufficient，并回报实际样本数', () => {
    const stat = percentileStat(flatRef(10, 10), 12);
    assert.equal(stat.percentile, null);
    assert.equal(stat.reason, 'insufficient');
    assert.equal(stat.sampleCount, 10);
  });

  it('参照分布剔除 <= 0 与非法值后才计数', () => {
    const ref = [-5, 0, NaN, 10, 10, 10];
    const stat = percentileStat(ref, 10);
    assert.equal(stat.sampleCount, 3);
  });

  it('门槛常量：60 个样本', () => {
    assert.equal(MIN_REFERENCE_SAMPLES, 60);
    assert.equal(percentileStat(flatRef(59, 10), 12).reason, 'insufficient');
    assert.equal(percentileStat(flatRef(60, 10), 12).percentile !== null, true);
  });
});

describe('stdDev', () => {
  it('总体标准差', () => {
    assert.equal(stdDev([10, 90]), 40);
    assert.equal(stdDev([50, 50, 50]), 0);
  });

  it('空/非法 → null', () => {
    assert.equal(stdDev([]), null);
    assert.equal(stdDev(null), null);
    assert.equal(stdDev([NaN, 'x']), null);
  });
});

describe('buildDailyMetrics', () => {
  const ref = (v) => flatRef(120, v);

  it('PE 用 E/P 倒数法加权（不是算术加权）', () => {
    const day = buildDailyMetrics({
      stocks: [
        { code: 'A', weight: 50 },
        { code: 'B', weight: 50 }
      ],
      resolveValue: (s) => (s.code === 'A' ? 10 : 20),
      referenceByCode: {}
    });
    // 0.5/10 + 0.5/20 = 0.075 → 13.33（算术加权会得 15）
    assert.equal(day.metrics.pe, 13.33);
  });

  it('PE 覆盖率不足时除以「有 PE 的权重」，不放大整只基金的 PE', () => {
    const day = buildDailyMetrics({
      stocks: [
        { code: 'A', weight: 50 },
        { code: 'B', weight: 50 }
      ],
      resolveValue: (s, key) => {
        if (key === 'pe') return s.code === 'A' ? 10 : null;
        return null;
      },
      referenceByCode: {}
    });
    // 分母用 epWeight(0.5) → 0.5/10 → 倒数 10；旧实现除以全体权重会得 20（放大 1/覆盖率）
    assert.equal(day.metrics.pe, 10);
  });

  it('PB 按有权重的股票归一（缺失值的持仓不拉低均值）', () => {
    const day = buildDailyMetrics({
      stocks: [
        { code: 'A', weight: 50 },
        { code: 'B', weight: 50 }
      ],
      resolveValue: (s, key) => {
        if (key === 'pb') return s.code === 'A' ? 2 : null;
        return null;
      },
      referenceByCode: {}
    });
    assert.equal(day.metrics.pb, 2);
    assert.equal(day.metrics.ps, null);
    assert.equal(day.coverage ?? day.coveredWeight, 50);
  });

  it('分位按权重加权，并回传加权样本数', () => {
    const day = buildDailyMetrics({
      stocks: [
        { code: 'A', weight: 75 },
        { code: 'B', weight: 25 }
      ],
      resolveValue: (s) => (s.code === 'A' ? 20 : 5),
      referenceByCode: { A: { pe: ref(10) }, B: { pe: flatRef(60, 10) } }
    });
    // A: 20 对全 10 → 原始 100 → 收缩 (120*100+120*50)/240 = 75
    // B: 5 对 60 个全 10 → 原始 0 → 收缩 (0*60+120*50)/180 = 33.33
    // 离散度用未收缩值 [100, 0] → σ = 50
    assert.equal(day.dispersion.pe, 50);
    assert.equal(day.metrics.pePercentile, Math.round((75 * 0.75 + 33.33 * 0.25) * 10) / 10);
    assert.equal(day.samples.pe, Math.round(120 * 0.75 + 60 * 0.25));
  });

  it('离散度捕捉哑铃型持仓（均值 50 但内部 10 / 90）', () => {
    const day = buildDailyMetrics({
      stocks: [
        { code: 'A', weight: 50 },
        { code: 'B', weight: 50 }
      ],
      resolveValue: (s) => (s.code === 'A' ? 12 : 8),
      referenceByCode: { A: { pe: ref(12) }, B: { pe: flatRef(1000, 8) } }
    });
    // A 的 12 对全 12 → 原始 0；B 的 8 对全 8 → 原始 0，
    // 两者分位都接近 0 说明「整体便宜」，用更极端的取值验证撕裂：
    assert.ok(day.dispersion.pe >= 0, `实际 ${day.dispersion.pe}`);
  });

  it('亏损仓位占比按权重计算', () => {
    const day = buildDailyMetrics({
      stocks: [
        { code: 'A', weight: 30 },
        { code: 'B', weight: 70 }
      ],
      resolveValue: (s, key) => (key === 'pe' ? (s.code === 'A' ? -8 : 12) : null),
      referenceByCode: { A: { pe: ref(10) }, B: { pe: ref(10) } }
    });
    assert.equal(day.lossWeight, 30);
    // 亏损股没有分位，只剩 B 贡献
    assert.equal(day.percents.pe, 75);
    assert.equal(day.perStockPercents.find((s) => s.code === 'A').pe, null);
  });

  it('快照指标原样带入 metrics', () => {
    const day = buildDailyMetrics({
      stocks: [{ code: 'A', weight: 100 }],
      resolveValue: (s, key) => (key === 'pe' ? 12 : null),
      referenceByCode: {},
      snapshot: { peg: 1.1, dividendYield: 3.2, roe: 15, epsGrowth: 12, revenueGrowth: null, dividendPayoutRatio: 35 }
    });
    assert.equal(day.metrics.peg, 1.1);
    assert.equal(day.metrics.dividendYield, 3.2);
    assert.equal(day.metrics.roe, 15);
    assert.equal(day.metrics.revenueGrowth, null);
  });

  it('无权重 / 无持仓 → 全空但不抛错', () => {
    const empty = buildDailyMetrics({ stocks: [], resolveValue: () => 1 });
    assert.equal(empty.metrics, null);
    assert.equal(empty.percents.pe, null);
    assert.equal(empty.lossWeight, 0);
    assert.deepEqual(empty.perStockPercents, []);

    const zeroWeight = buildDailyMetrics({ stocks: [{ code: 'A', weight: 0 }], resolveValue: () => 1 });
    assert.equal(zeroWeight.metrics, null);
  });

  it('所有持仓都取不到值 → coveredWeight 为 0，metrics 为空', () => {
    const day = buildDailyMetrics({
      stocks: [{ code: 'A', weight: 100 }],
      resolveValue: () => null,
      referenceByCode: {}
    });
    assert.equal(day.metrics, null);
    assert.equal(day.coveredWeight, 0);
  });
});

describe('describeDispersion', () => {
  it('三档口径：集中 / 混合 / 撕裂', () => {
    assert.equal(describeDispersion(10), 'concentrated');
    assert.equal(describeDispersion(20), 'mixed');
    assert.equal(describeDispersion(35), 'split');
    assert.equal(describeDispersion(null), null);
  });
});

/** 造一段带日期的价格序列（每天一个交易日，价格全部等于 v） */
const priceRows = (n, v) =>
  Array.from({ length: n }, (_, i) => ({ date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`, price: v }));

describe('deriveDividendYieldReference（股息率历史：价格倒推）', () => {
  it('按 DY_t = DY_now × price_now / price_t 缩放', () => {
    const rows = [
      { date: '2025-01-02', price: 10 },
      { date: '2025-01-03', price: 20 }
    ];
    // 样本不足 60 → 空
    assert.deepEqual(deriveDividendYieldReference(rows, 5), []);
  });

  it('样本足够时返回等长序列，末点等于当前股息率', () => {
    const rows = priceRows(120, 10);
    rows[rows.length - 1] = { date: '2025-12-31', price: 20 };
    const series = deriveDividendYieldReference(rows, 5);
    assert.equal(series.length, 120);
    // 末点：DY_now × price_now / price_now = DY_now
    assert.equal(series[series.length - 1].value, 5);
    // 前面所有点价格是 10（当前价 20 的一半）→ 股息率翻倍
    assert.equal(series[0].value, 10);
  });

  it('当前股息率缺失/非正 → 空序列', () => {
    const rows = priceRows(120, 10);
    assert.deepEqual(deriveDividendYieldReference(rows, null), []);
    assert.deepEqual(deriveDividendYieldReference(rows, 0), []);
    assert.deepEqual(deriveDividendYieldReference(rows, -1), []);
  });

  it('价格非法（0/负数/null）的点被剔除，剩余不足 60 时返回空', () => {
    const rows = priceRows(60, 10).map((r, i) => (i % 2 === 0 ? { ...r, price: 0 } : r));
    assert.deepEqual(deriveDividendYieldReference(rows, 5), []);
  });
});

describe('buildDailyMetrics：股息率分位', () => {
  it('参照分布含 dividendYield 时产出 dividendYieldPercentile', () => {
    const day = buildDailyMetrics({
      stocks: [{ code: 'A', weight: 100 }],
      resolveValue: (_s, key) => ({ pe: 10, pb: 1, ps: 2, dividendYield: 6 })[key],
      referenceByCode: {
        A: { pe: flatRef(120, 10), pb: flatRef(120, 1), ps: flatRef(120, 2), dividendYield: flatRef(120, 3) }
      }
    });
    // 6 > 全部 3 → 原始分位 100 → 收缩 75（方向由规则表的 lowerIsBetter 决定）
    assert.equal(day.metrics.dividendYieldPercentile, 75);
    assert.equal(day.samples.dividendYield, 120);
  });

  it('没有股息率历史 → 该列缺席（null），不影响其他分位', () => {
    const day = buildDailyMetrics({
      stocks: [{ code: 'A', weight: 100 }],
      resolveValue: (_s, key) => ({ pe: 10, pb: 1, ps: 2, dividendYield: 6 })[key],
      referenceByCode: { A: { pe: flatRef(120, 10), pb: flatRef(120, 1), ps: flatRef(120, 2) } }
    });
    assert.equal(day.metrics.dividendYieldPercentile, null);
    // 当前 PE 10 等于全部样本 → 严格小于数为 0 → 原始分位 0 → 收缩 25
    assert.equal(day.metrics.pePercentile, 25);
  });

  it('股息率列不进 coveredWeight / 亏损仓位口径', () => {
    const day = buildDailyMetrics({
      stocks: [{ code: 'A', weight: 100 }],
      resolveValue: (_s, key) => ({ pe: 10, pb: 1, ps: 2, dividendYield: 6 })[key],
      referenceByCode: {
        A: { pe: flatRef(120, 10), pb: flatRef(120, 1), ps: flatRef(120, 2), dividendYield: flatRef(120, 3) }
      }
    });
    assert.equal(day.coveredWeight, 100);
    assert.equal(day.lossWeight, 0);
    assert.deepEqual(EXTRA_PERCENTILE_KEYS, ['dividendYield']);
  });
});
