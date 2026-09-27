/**
 * 估值区间走势（近 1 月 / 近 3 月）单元测试
 *
 * 覆盖：
 *   - 序列归一化 / as-of 取值 / 日期轴构建
 *   - 基金级评分序列重放（分位加权、E/P 法、区间常量指标）
 *   - 区间统计（当前/均值/最高/最低/变动/位置/方向）
 *   - 边界：空持仓、无历史、参照样本不足、单点
 *
 * 运行：node --test app/lib/__tests__/valuationHistory.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePoints,
  asOfValue,
  buildDateAxis,
  getPeriodRange,
  createRanker,
  buildValuationScoreSeries,
  summarizeValuationSeries,
  VALUATION_PERIODS,
  PERIOD_ORDER,
  DEFAULT_VALUATION_PERIOD,
  __test__ as historyInternals
} from '../valuationHistory.js';
import { computePercentile } from '../valuationEngine.js';
import { FUND_CATEGORIES } from '../fundClassifier.js';

// ========== 序列工具 ==========

describe('normalizePoints', () => {
  it('过滤非法行、按日期升序', () => {
    const out = normalizePoints([
      { date: '2026-09-02', value: 12 },
      { date: '2026-09-01', value: 10 },
      { date: '2026-09-03', value: NaN },
      { date: null, value: 5 },
      { value: 7 }
    ]);
    assert.deepEqual(out, [
      { date: '2026-09-01', value: 10 },
      { date: '2026-09-02', value: 12 }
    ]);
  });

  it('同日重复取后者', () => {
    const out = normalizePoints([
      { date: '2026-09-01', value: 10 },
      { date: '2026-09-01T00:00:00.000', value: 11 }
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].value, 11);
  });

  it('非法输入 → 空数组', () => {
    assert.deepEqual(normalizePoints(null), []);
    assert.deepEqual(normalizePoints('x'), []);
  });
});

describe('asOfValue', () => {
  const series = [
    { date: '2026-09-01', value: 10 },
    { date: '2026-09-05', value: 20 },
    { date: '2026-09-10', value: 30 }
  ];

  it('命中当日', () => {
    assert.equal(asOfValue(series, '2026-09-05'), 20);
  });

  it('落在两点之间 → 取前一点（向前填充）', () => {
    assert.equal(asOfValue(series, '2026-09-07'), 20);
  });

  it('晚于最后一点 → 取最后一点', () => {
    assert.equal(asOfValue(series, '2026-10-01'), 30);
  });

  it('早于第一点 → null', () => {
    assert.equal(asOfValue(series, '2026-08-01'), null);
  });

  it('空序列 → null', () => {
    assert.equal(asOfValue([], '2026-09-01'), null);
    assert.equal(asOfValue(null, '2026-09-01'), null);
  });
});

describe('buildDateAxis', () => {
  it('取区间内所有序列的日期并集并升序', () => {
    const a = [{ date: '2026-09-01' }, { date: '2026-09-03' }];
    const b = [{ date: '2026-09-02' }, { date: '2026-09-20' }];
    assert.deepEqual(buildDateAxis([a, b], '2026-09-01', '2026-09-10'), ['2026-09-01', '2026-09-02', '2026-09-03']);
  });

  it('空输入 → 空数组', () => {
    assert.deepEqual(buildDateAxis([], '2026-01-01', '2026-12-31'), []);
    assert.deepEqual(buildDateAxis(null, '2026-01-01', '2026-12-31'), []);
  });
});

describe('getPeriodRange', () => {
  it('产出 YYYY-MM-DD 且末端含缓冲', () => {
    const { from, to } = getPeriodRange(30, new Date(2026, 8, 26)); // 2026-09-26 本地时间
    assert.equal(from, '2026-08-27');
    assert.equal(to, '2026-09-27');
  });

  it('近6月/近1年/近3年 的起点', () => {
    const now = new Date(2026, 8, 26);
    assert.equal(getPeriodRange(VALUATION_PERIODS['6m'].days, now).from, '2026-03-28');
    assert.equal(getPeriodRange(VALUATION_PERIODS['1y'].days, now).from, '2025-09-26');
    assert.equal(getPeriodRange(VALUATION_PERIODS['3y'].days, now).from, '2023-09-27');
  });

  it('成立来（days=null）→ 不设下界，收纳全部点位', () => {
    const { from, to } = getPeriodRange(null, new Date(2026, 8, 26));
    assert.equal(from, historyInternals.EPOCH_FROM);
    assert.ok(from < '2000-01-01');
    assert.equal(to, '2026-09-27');
  });

  it('区间档位与「业绩走势」一致（6 档）', () => {
    assert.deepEqual(PERIOD_ORDER, ['1m', '3m', '6m', '1y', '3y', 'all']);
    for (const key of PERIOD_ORDER) {
      assert.ok(VALUATION_PERIODS[key], `缺少区间定义: ${key}`);
      assert.ok(VALUATION_PERIODS[key].label, `缺少区间名: ${key}`);
    }
    assert.equal(VALUATION_PERIODS['1m'].days, 30);
    assert.equal(VALUATION_PERIODS['3m'].days, 90);
    assert.equal(VALUATION_PERIODS['6m'].days, 182);
    assert.equal(VALUATION_PERIODS['1y'].days, 365);
    assert.equal(VALUATION_PERIODS['3y'].days, 1095);
    assert.equal(VALUATION_PERIODS.all.days, null);
    assert.equal(DEFAULT_VALUATION_PERIOD, '3m');
  });
});

describe('createRanker（长区间分位性能优化）', () => {
  const ref = [5, 1, 9, 3, 7, 3, 11, NaN, 2];

  it('与 computePercentile 口径完全一致（严格小于）', () => {
    const rank = createRanker(ref);
    const clean = ref.filter((v) => Number.isFinite(v));
    for (const v of [0, 1, 2, 3, 5, 6, 9, 11, 12]) {
      assert.equal(rank(v), computePercentile(clean, v), `value=${v}`);
    }
  });

  it('空/非法参照 → 恒返回 null', () => {
    assert.equal(createRanker([])(5), null);
    assert.equal(createRanker(null)(5), null);
    assert.equal(createRanker([NaN])(5), null);
  });

  it('对当前值传非法数 → null', () => {
    const rank = createRanker([1, 2, 3]);
    assert.equal(rank(NaN), null);
    assert.equal(rank(null), null);
  });

  it('不会因排序而改变原始参照数组', () => {
    const input = [5, 1, 9];
    createRanker(input);
    assert.deepEqual(input, [5, 1, 9]);
  });
});

// ========== 评分序列重放 ==========

/** 构造一只持仓的最小可用历史 */
const makeStock = ({ code = '600519', weight = 100, market = 'A', peDates, pbDates } = {}) => {
  const ref = Array.from({ length: 40 }, () => 10); // 参照分布：全部 10 → 分位只由当前值决定
  return {
    perStock: [{ code, weight, market }],
    historyByCode: {
      [code]: {
        pe: peDates.map(([date, value]) => ({ date, value })),
        pb: pbDates.map(([date, value]) => ({ date, value })),
        ps: []
      }
    },
    referenceByCode: { [code]: { pe: ref, pb: ref, ps: null } }
  };
};

describe('buildValuationScoreSeries', () => {
  it('按日期轴重放评分：估值上行 → 分数上行', () => {
    const { perStock, historyByCode, referenceByCode } = makeStock({
      peDates: [
        ['2026-09-01', 10],
        ['2026-09-15', 30]
      ],
      pbDates: [
        ['2026-09-01', 10],
        ['2026-09-15', 30]
      ]
    });
    const series = buildValuationScoreSeries({
      perStock,
      historyByCode,
      referenceByCode,
      category: FUND_CATEGORIES.BROAD_INDEX,
      from: '2026-09-01',
      to: '2026-09-30'
    });
    assert.equal(series.length, 2);
    assert.equal(series[0].date, '2026-09-01');
    assert.equal(series[1].date, '2026-09-15');
    // 估值从参照分布最低升到最高 → 评分上升
    assert.ok(series[1].score > series[0].score, `${series[1].score} 应大于 ${series[0].score}`);
    // 分位随值变化：10 对全 10 → 0 分位；30 对全 10 → 100 分位
    assert.equal(Math.round(series[0].metrics.pePercentile), 0);
    assert.equal(Math.round(series[1].metrics.pePercentile), 100);
  });

  it('as-of 向前填充：缺数据的日期沿用上一有效值', () => {
    // 两只股票：A 在 09-01/09-10 有数据，B 只在 09-05 有数据
    const ref = Array.from({ length: 40 }, () => 10);
    const series = buildValuationScoreSeries({
      perStock: [
        { code: 'A', weight: 50, market: 'A' },
        { code: 'B', weight: 50, market: 'A' }
      ],
      historyByCode: {
        A: {
          pe: [
            { date: '2026-09-01', value: 10 },
            { date: '2026-09-10', value: 20 }
          ],
          pb: [],
          ps: []
        },
        B: { pe: [{ date: '2026-09-05', value: 20 }], pb: [], ps: [] }
      },
      referenceByCode: { A: { pe: ref }, B: { pe: ref } },
      category: FUND_CATEGORIES.BROAD_INDEX,
      from: '2026-09-01',
      to: '2026-09-30'
    });
    // 日期轴 = 09-01 / 09-05 / 09-10
    assert.deepEqual(
      series.map((p) => p.date),
      ['2026-09-01', '2026-09-05', '2026-09-10']
    );
    // 09-05 时 A 仍为 10（向前填充），覆盖权重为 A+B
    assert.equal(series[1].coverage, 100);
    const pePct = series[1].metrics.pePercentile;
    // A 的 10 对 ref(全10) → 0；B 的 20 → 100；等权 → 50
    assert.equal(Math.round(pePct), 50);
  });

  it('PE 走 E/P 加权倒数法', () => {
    const ref = Array.from({ length: 40 }, () => 10);
    const series = buildValuationScoreSeries({
      perStock: [
        { code: 'A', weight: 50, market: 'A' },
        { code: 'B', weight: 50, market: 'A' }
      ],
      historyByCode: {
        A: { pe: [{ date: '2026-09-01', value: 10 }], pb: [], ps: [] },
        B: { pe: [{ date: '2026-09-01', value: 20 }], pb: [], ps: [] }
      },
      referenceByCode: { A: { pe: ref }, B: { pe: ref } },
      category: FUND_CATEGORIES.BROAD_INDEX,
      from: '2026-09-01',
      to: '2026-09-30'
    });
    // E/P = 0.5/10 + 0.5/20 = 0.075 → PE = 13.33（而非算术平均 15）
    assert.ok(Math.abs(series[0].metrics.pe - 13.333) < 0.01, `实际 ${series[0].metrics.pe}`);
  });

  it('参照样本不足（<30）→ 该指标不计入，评分仍可产出', () => {
    const series = buildValuationScoreSeries({
      perStock: [{ code: 'A', weight: 100, market: 'A' }],
      historyByCode: {
        A: {
          pe: [{ date: '2026-09-01', value: 10 }],
          pb: [{ date: '2026-09-01', value: 2 }],
          ps: []
        }
      },
      referenceByCode: { A: { pe: [10, 11, 12], pb: [2, 2, 2] } },
      category: FUND_CATEGORIES.BROAD_INDEX,
      from: '2026-09-01',
      to: '2026-09-30'
    });
    assert.equal(series.length, 1);
    assert.equal(series[0].metrics.pePercentile, null);
    assert.equal(series[0].metrics.pbPercentile, null);
    // 分位全缺失 → 该规则下无指标可算 → 数据不足
    assert.equal(series[0].score, null);
  });

  it('季度指标（ROE/增速）作为区间常量带入每一天', () => {
    const ref = Array.from({ length: 40 }, () => 10);
    const series = buildValuationScoreSeries({
      perStock: [{ code: 'A', weight: 100, market: 'A' }],
      historyByCode: {
        A: {
          pe: [
            { date: '2026-09-01', value: 10 },
            { date: '2026-09-02', value: 10 }
          ],
          pb: [],
          ps: []
        }
      },
      referenceByCode: { A: { pe: ref } },
      fundamentals: { roe: 18, epsGrowth: 20 },
      category: FUND_CATEGORIES.BROAD_INDEX,
      from: '2026-09-01',
      to: '2026-09-30'
    });
    assert.equal(series.length, 2);
    for (const p of series) {
      assert.equal(p.metrics.roe, 18);
      assert.equal(p.metrics.epsGrowth, 20);
    }
  });

  it('无持仓 / 无历史 → 空序列', () => {
    const base = {
      referenceByCode: {},
      category: FUND_CATEGORIES.BROAD_INDEX,
      from: '2026-09-01',
      to: '2026-09-30'
    };
    assert.deepEqual(buildValuationScoreSeries({ ...base, perStock: [], historyByCode: {} }), []);
    assert.deepEqual(
      buildValuationScoreSeries({
        ...base,
        perStock: [{ code: 'AAPL', weight: 100, market: 'US' }],
        historyByCode: {}
      }),
      []
    );
  });

  it('权重为 0 的持仓被忽略', () => {
    const ref = Array.from({ length: 40 }, () => 10);
    const series = buildValuationScoreSeries({
      perStock: [
        { code: 'A', weight: 0, market: 'A' },
        { code: 'B', weight: 100, market: 'A' }
      ],
      historyByCode: {
        A: { pe: [{ date: '2026-09-01', value: 10 }] },
        B: { pe: [{ date: '2026-09-01', value: 10 }] }
      },
      referenceByCode: { A: { pe: ref }, B: { pe: ref } },
      category: FUND_CATEGORIES.BROAD_INDEX,
      from: '2026-09-01',
      to: '2026-09-30'
    });
    assert.equal(series.length, 1);
    assert.equal(series[0].coverage, 100);
  });
});

// ========== 区间统计 ==========

describe('summarizeValuationSeries', () => {
  const series = [
    { date: '2026-09-01', score: 40 },
    { date: '2026-09-05', score: 50 },
    { date: '2026-09-10', score: 70 }
  ];

  it('当前/起点/均值/最高/最低', () => {
    const s = summarizeValuationSeries(series);
    assert.equal(s.validPoints, 3);
    assert.equal(s.current.score, 70);
    assert.equal(s.first.score, 40);
    assert.equal(s.change, 30);
    assert.ok(Math.abs(s.avg - 53.3) < 0.05);
    assert.equal(s.max.score, 70);
    assert.equal(s.min.score, 40);
  });

  it('方向：分数上升 → 变贵；下降 → 变便宜；小幅 → 走平', () => {
    assert.equal(summarizeValuationSeries(series).direction, 'expensive');
    assert.equal(
      summarizeValuationSeries([
        { date: '2026-09-01', score: 60 },
        { date: '2026-09-10', score: 40 }
      ]).direction,
      'cheaper'
    );
    // 变动 2 分（< 3 分阈值）视为走平，避免噪声被读成趋势
    assert.equal(
      summarizeValuationSeries([
        { date: '2026-09-01', score: 50 },
        { date: '2026-09-10', score: 52 }
      ]).direction,
      'flat'
    );
  });

  it('位置：当前值在区间内的分位', () => {
    const s = summarizeValuationSeries(series);
    // 70 高于 40/50 → 2/3 = 67%
    assert.equal(s.position, 67);
  });

  it('null 分数被剔除，仅剩 1 个点时也能统计', () => {
    const s = summarizeValuationSeries([
      { date: '2026-09-01', score: null },
      { date: '2026-09-10', score: 55 }
    ]);
    assert.equal(s.points, 2);
    assert.equal(s.validPoints, 1);
    assert.equal(s.current.score, 55);
    assert.equal(s.change, 0);
    assert.equal(s.position, 0);
  });

  it('空序列 → 全 null 且不抛错', () => {
    const s = summarizeValuationSeries([]);
    assert.equal(s.validPoints, 0);
    assert.equal(s.current, null);
    assert.equal(s.change, null);
    assert.equal(s.direction, null);
  });
});

describe('内部常量', () => {
  it('分位样本下限与 fund.js 保持一致', () => {
    assert.equal(historyInternals.MIN_REFERENCE_SAMPLES, 30);
  });
});
