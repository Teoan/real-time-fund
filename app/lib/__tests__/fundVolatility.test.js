/**
 * 基金波动信号引擎单元测试
 *
 * 覆盖：
 *   - 净值归一化（排序、去重、日收益率补齐的优先级）
 *   - 年化波动率、滚动窗口、最大回撤、当前回撤
 *   - 历史分位的参照窗口与样本下限
 *   - 信号阈值边界、同族互斥、状态归并优先级
 *   - 风险评分的兜底与夹紧
 *   - 净值合并/裁剪（「补最新交易日」的实现基础）
 *
 * 运行：node --test app/lib/__tests__/fundVolatility.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ABSOLUTE_VOLATILITY_CEILING,
  DRAWDOWN_SIGNAL_KEYS,
  MAIN_VOLATILITY_WINDOW,
  MIN_PERCENTILE_SAMPLES,
  PERCENTILE_WINDOW_YEARS,
  SIGNAL_DEFS,
  SIGNAL_FAMILIES,
  SIGNAL_THRESHOLDS,
  TRADING_DAYS_PER_YEAR,
  VOLATILITY_STATES,
  VOLATILITY_STATE_SEVERITY,
  analyzeFundVolatility,
  annualizeVolatility,
  computeCurrentDrawdown,
  computeMaxDrawdown,
  computeRiskScore,
  computeRollingVolatility,
  computeRollingVolatilitySeries,
  computeVolatilityMetrics,
  computeVolatilitySignals,
  mergeNavSeries,
  normalizeNavSeries,
  pickPrimarySignals,
  resolveVolatilityState,
  trimNavSeries
} from '../fundVolatility.js';

// ── 测试工具 ──────────────────────────────────────────────────────────────

/** 确定性伪随机（避免测试抖动） */
const makeSeededRandom = (seed) => {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
};

const isoDate = (dayOffset) => new Date(Date.UTC(2020, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

/**
 * 构造合成净值序列：前段基础波动，末段可选择放大波动。
 * @returns {Array<{date: string, unitNetValue: number, accumulatedNetValue: number, equityReturn: number}>}
 */
const buildSeries = ({ days, baseAmplitude = 0.01, tailDays = 0, tailAmplitude = 0, seed = 1 }) => {
  const rnd = makeSeededRandom(seed);
  const rows = [];
  let nav = 1;
  for (let i = 0; i < days; i++) {
    const amplitude = i >= days - tailDays ? tailAmplitude : baseAmplitude;
    const ret = rnd() * amplitude * 2;
    nav *= 1 + ret;
    rows.push({ date: isoDate(i), unitNetValue: nav, accumulatedNetValue: nav, equityReturn: ret * 100 });
  }
  return rows;
};

// ── normalizeNavSeries ────────────────────────────────────────────────────

describe('normalizeNavSeries', () => {
  it('按日期升序排列并丢弃无净值行', () => {
    const out = normalizeNavSeries([
      { date: '2024-01-03', unitNetValue: 1.3 },
      { date: '2024-01-01', unitNetValue: 1.1 },
      { date: '2024-01-02' },
      { date: '2024-01-02', unitNetValue: 1.2 }
    ]);
    assert.deepEqual(
      out.map((r) => r.date),
      ['2024-01-01', '2024-01-02', '2024-01-03']
    );
  });

  it('同日重复保留后出现的一条', () => {
    const out = normalizeNavSeries([
      { date: '2024-01-01', unitNetValue: 1.1 },
      { date: '2024-01-01', unitNetValue: 9.9 }
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].unitNav, 9.9);
  });

  it('兼容 app/api/fund.js 的原始字段名（unitNetValue / equityReturn）', () => {
    const out = normalizeNavSeries([
      { date: '2024-01-01', unitNetValue: 1.5, accumulatedNetValue: 2.5, equityReturn: 0.8 }
    ]);
    assert.equal(out[0].unitNav, 1.5);
    assert.equal(out[0].accumulatedNav, 2.5);
    assert.equal(out[0].dailyReturn, 0.8);
  });

  it('缺 equityReturn 时由累计净值推算（分子是绝对额之差，不是累计净值环比）', () => {
    const out = normalizeNavSeries([
      { date: '2024-01-01', unitNetValue: 1.0, accumulatedNetValue: 1.0 },
      // 分红除权：单位净值跌 5%，累计净值只涨 0.5% → 真实收益 +0.5%
      { date: '2024-01-02', unitNetValue: 0.95, accumulatedNetValue: 1.005 }
    ]);
    assert.equal(out[1].dailyReturn.toFixed(4), '0.5000');
  });

  it('回归护栏：累计净值只能取「绝对额之差 ÷ 前一日单位净值」，不能取它自身的百分比变化', () => {
    // 天天基金的 Data_ACWorthTrend 是「单位净值 + 累计分红」的绝对额相加，
    // 不是复权净值指数。对分红多的基金，两种算法差好几倍（实测 161725 稀释到约 1/4）。
    const out = normalizeNavSeries([
      { date: '2024-01-01', unitNetValue: 0.5, accumulatedNetValue: 2.0 },
      { date: '2024-01-02', unitNetValue: 0.5, accumulatedNetValue: 2.002 }
    ]);
    // 正确： (2.002 − 2.0) ÷ 0.5 = 0.4%
    // 错误： 2.002 ÷ 2.0 − 1 = 0.1%
    assert.equal(out[1].dailyReturn.toFixed(4), '0.4000');
  });

  it('前一日单位净值为 0 或缺失时不硬算收益率', () => {
    const zero = normalizeNavSeries([
      { date: '2024-01-01', unitNetValue: 0, accumulatedNetValue: 1 },
      { date: '2024-01-02', unitNetValue: 0.5, accumulatedNetValue: 1.001 }
    ]);
    assert.equal(zero[1].dailyReturn, null);

    const missing = normalizeNavSeries([
      { date: '2024-01-01', accumulatedNetValue: 1 },
      { date: '2024-01-02', unitNetValue: 0.5, accumulatedNetValue: 1.001 }
    ]);
    assert.equal(missing[1].dailyReturn, null);
  });

  it('累计净值缺失时回落单位净值推算', () => {
    const out = normalizeNavSeries([
      { date: '2024-01-01', unitNetValue: 1.0 },
      { date: '2024-01-02', unitNetValue: 1.1 }
    ]);
    assert.equal(out[1].dailyReturn.toFixed(4), '10.0000');
  });

  it('首行没有前一日，日收益率保持 null', () => {
    const out = normalizeNavSeries([{ date: '2024-01-01', unitNetValue: 1.0 }]);
    assert.equal(out[0].dailyReturn, null);
  });

  it('幂等：已归一化序列再归一化不改变结果', () => {
    const once = normalizeNavSeries([
      { date: '2024-01-01', unitNetValue: 1.0 },
      { date: '2024-01-02', unitNetValue: 1.1 }
    ]);
    assert.deepEqual(normalizeNavSeries(once), once);
  });

  it('非数组输入返回空数组', () => {
    assert.deepEqual(normalizeNavSeries(null), []);
    assert.deepEqual(normalizeNavSeries(undefined), []);
    assert.deepEqual(normalizeNavSeries('nope'), []);
  });
});

// ── 波动率 ────────────────────────────────────────────────────────────────

describe('annualizeVolatility', () => {
  it('收益率恒定时波动率为 0', () => {
    assert.equal(annualizeVolatility([1, 1, 1, 1, 1]), 0);
  });

  it('样本不足 2 个返回 null', () => {
    assert.equal(annualizeVolatility([1]), null);
    assert.equal(annualizeVolatility([]), null);
  });

  it('按样本标准差（n-1）年化：[-1, 1] → √2 × √252', () => {
    const expected = Math.sqrt(2) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    assert.ok(Math.abs(annualizeVolatility([-1, 1]) - expected) < 1e-9);
  });
});

describe('computeRollingVolatility', () => {
  it('样本不足窗口返回 null', () => {
    assert.equal(computeRollingVolatility([1, 2, 3], 20), null);
  });

  it('只取最后 window 个收益率', () => {
    const returns = [10, 10, 1, 1, 1];
    assert.equal(computeRollingVolatility(returns, 3), 0);
  });

  it('window < 2 视为非法', () => {
    assert.equal(computeRollingVolatility([1, 2, 3], 1), null);
  });
});

describe('computeRollingVolatilitySeries', () => {
  it('长度为 returns.length - window + 1', () => {
    assert.equal(computeRollingVolatilitySeries([1, 2, 3, 4, 5], 2).length, 4);
    assert.equal(computeRollingVolatilitySeries([1, 2, 3], 20).length, 0);
  });
});

// ── 回撤 ──────────────────────────────────────────────────────────────────

describe('computeMaxDrawdown', () => {
  it('单调上升无回撤 → 0', () => {
    assert.equal(computeMaxDrawdown([1, 1.1, 1.2, 1.3]), 0);
  });

  it('峰值 1.1 → 谷值 0.99 → -10%', () => {
    assert.equal(computeMaxDrawdown([1, 1.1, 0.99]).toFixed(4), '-10.0000');
  });

  it('窗口外的深回撤不计入', () => {
    // 全序列含 -50% 深坑，但只回看最近 2 个点
    assert.equal(computeMaxDrawdown([1, 0.5, 1.0, 1.05], 2), 0);
    assert.equal(computeMaxDrawdown([1, 0.5, 1.0, 1.05], 3).toFixed(4), '0.0000');
    assert.equal(computeMaxDrawdown([1, 0.5, 1.0, 1.05]).toFixed(4), '-50.0000');
  });

  it('净值点不足 2 个返回 null', () => {
    assert.equal(computeMaxDrawdown([1]), null);
    assert.equal(computeMaxDrawdown([]), null);
  });
});

describe('computeCurrentDrawdown', () => {
  it('当前即为最高点 → 0', () => {
    assert.equal(computeCurrentDrawdown([1, 1.1, 1.2]), 0);
  });

  it('从窗口内高点回落', () => {
    assert.equal(computeCurrentDrawdown([1, 1.2, 1.08]).toFixed(4), '-10.0000');
  });

  it('高点在窗口之外时以窗口内高点为准', () => {
    // 全序列高点 2.0 在最前面，只回看最近 2 个点 → 窗口内高点 1.1
    assert.equal(computeCurrentDrawdown([2.0, 1.0, 1.1, 1.045], 2).toFixed(4), '-5.0000');
  });
});

// ── 指标汇总 ──────────────────────────────────────────────────────────────

describe('computeVolatilityMetrics', () => {
  it('样本不足时波动率与分位都为 null', () => {
    const m = computeVolatilityMetrics(buildSeries({ days: 10 }));
    assert.equal(m.vol60, null);
    assert.equal(m.vol20Percentile, null);
    assert.equal(m.navCount, 10);
  });

  it('长序列：三个窗口都有值，分位样本取近 5 年上限', () => {
    const m = computeVolatilityMetrics(buildSeries({ days: 1400 }));
    assert.ok(Number.isFinite(m.vol5) && Number.isFinite(m.vol20) && Number.isFinite(m.vol60));
    assert.equal(m.percentileSamples, PERCENTILE_WINDOW_YEARS * TRADING_DAYS_PER_YEAR);
    assert.ok(m.vol20Percentile >= 0 && m.vol20Percentile <= 100);
  });

  it('样本数刚好达到下限才给分位', () => {
    // buildSeries 每行都带 equityReturn，故收益率条数 = 净值条数；
    // 参照样本数 = 收益率条数 - 20 + 1，故 30 个样本需要 49 个净值点
    const daysEnough = MIN_PERCENTILE_SAMPLES + MAIN_VOLATILITY_WINDOW - 1;
    const m = computeVolatilityMetrics(buildSeries({ days: daysEnough }));
    assert.equal(m.percentileSamples, MIN_PERCENTILE_SAMPLES);
    assert.ok(Number.isFinite(m.vol20Percentile));

    // 少一个净值点 → 样本不足 → 不给分位
    const mShort = computeVolatilityMetrics(buildSeries({ days: daysEnough - 1 }));
    assert.equal(mShort.percentileSamples, MIN_PERCENTILE_SAMPLES - 1);
    assert.equal(mShort.vol20Percentile, null);
  });

  it('asOfDate 取最后一行的日期', () => {
    const rows = buildSeries({ days: 5 });
    assert.equal(computeVolatilityMetrics(rows).asOfDate, rows[rows.length - 1].date);
  });

  it('5日/20日比值 = vol5 / vol20', () => {
    const m = computeVolatilityMetrics(buildSeries({ days: 300 }));
    assert.ok(Math.abs(m.volRatio - m.vol5 / m.vol20) < 1e-12);
  });

  it('波动率为 0 时比值给 null（不做除零）', () => {
    const flat = Array.from({ length: 80 }, (_, i) => ({ date: isoDate(i), unitNetValue: 1, accumulatedNetValue: 1 }));
    const m = computeVolatilityMetrics(flat);
    assert.equal(m.vol20, 0);
    assert.equal(m.volRatio, null);
  });

  it('空序列不抛异常', () => {
    const m = computeVolatilityMetrics([]);
    assert.equal(m.navCount, 0);
    assert.equal(m.vol20, null);
    assert.equal(m.asOfDate, null);
  });
});

// ── 信号 ──────────────────────────────────────────────────────────────────

describe('computeVolatilitySignals', () => {
  const metricsWith = (patch) => ({
    vol5: null,
    vol20: null,
    vol60: null,
    vol20Percentile: null,
    volRatio: null,
    maxDrawdown20: null,
    maxDrawdown60: null,
    currentDrawdown: null,
    ...patch
  });

  it('分位 80（阈值边界）→ 命中高波动', () => {
    const signals = computeVolatilitySignals(metricsWith({ vol20Percentile: 80 }));
    assert.deepEqual(
      signals.map((s) => s.key),
      ['highVolatility']
    );
    assert.equal(signals[0].label, '波动率处于历史高位');
  });

  it('分位 79.9 → 不命中', () => {
    assert.equal(computeVolatilitySignals(metricsWith({ vol20Percentile: 79.9 })).length, 0);
  });

  it('分位 95 → 只报极端波动（同族互斥）', () => {
    const signals = computeVolatilitySignals(metricsWith({ vol20Percentile: 95 }));
    assert.deepEqual(
      signals.map((s) => s.key),
      ['extremeVolatility']
    );
    assert.equal(signals[0].level, 'danger');
  });

  it('比值 1.15（阈值边界）→ 命中波动扩大', () => {
    assert.deepEqual(
      computeVolatilitySignals(metricsWith({ volRatio: SIGNAL_THRESHOLDS.VOLATILITY_EXPANDING_RATIO })).map(
        (s) => s.key
      ),
      ['volatilityExpanding']
    );
  });

  it('比值 1.30 → 只报快速扩大（同族互斥）', () => {
    assert.deepEqual(
      computeVolatilitySignals(metricsWith({ volRatio: 1.3 })).map((s) => s.key),
      ['volatilityExpandingFast']
    );
  });

  it('20 日最大回撤 -8（阈值边界）→ 命中较大回撤', () => {
    assert.deepEqual(
      computeVolatilitySignals(metricsWith({ maxDrawdown20: -8 })).map((s) => s.key),
      ['largeDrawdown']
    );
  });

  it('-7.9% 不命中', () => {
    assert.equal(computeVolatilitySignals(metricsWith({ maxDrawdown20: -7.9 })).length, 0);
  });

  it('60 日最大回撤 -12（阈值边界）→ 命中中期回撤加深', () => {
    const signals = computeVolatilitySignals(metricsWith({ maxDrawdown60: -12 }));
    assert.deepEqual(
      signals.map((s) => s.key),
      ['deepDrawdown']
    );
    assert.equal(signals[0].family, 'drawdown');
  });

  it('当前回撤 -12（阈值边界）→ 命中深度回撤', () => {
    const signals = computeVolatilitySignals(metricsWith({ currentDrawdown: -12 }));
    assert.deepEqual(
      signals.map((s) => s.key),
      ['deepCurrentDrawdown']
    );
  });

  it('回撤维度各自独立命中，不做互斥（20日/60日/当前可能同时成立）', () => {
    const keys = computeVolatilitySignals(
      metricsWith({ maxDrawdown20: -9, maxDrawdown60: -14, currentDrawdown: -18 })
    ).map((s) => s.key);
    assert.deepEqual(keys, ['deepDrawdown', 'deepCurrentDrawdown', 'largeDrawdown']);
  });

  it('DRAWDOWN_SIGNAL_KEYS 覆盖全部回撤族信号（防止新增信号漏改状态机）', () => {
    const drawdownKeysInDefs = Object.entries(SIGNAL_DEFS)
      .filter(([, def]) => def.family === SIGNAL_FAMILIES.DRAWDOWN)
      .map(([key]) => key)
      .sort();
    assert.deepEqual([...DRAWDOWN_SIGNAL_KEYS].sort(), drawdownKeysInDefs);
  });

  it('多个族可同时命中，且危险信号排在前面', () => {
    const signals = computeVolatilitySignals(metricsWith({ vol20Percentile: 97, volRatio: 1.4, maxDrawdown20: -12 }));
    assert.deepEqual(
      signals.map((s) => s.key),
      ['extremeVolatility', 'volatilityExpandingFast', 'largeDrawdown']
    );
    assert.ok(signals.every((s) => s.detail.length > 0));
  });

  it('非对象输入返回空数组', () => {
    assert.deepEqual(computeVolatilitySignals(null), []);
  });
});

describe('pickPrimarySignals', () => {
  it('同一互斥组内只保留 severity 最高的一条', () => {
    const signals = [
      { key: 'a', family: 'volLevel', group: 'volLevel', severity: 1, level: 'warn', label: '', detail: '' },
      { key: 'b', family: 'volLevel', group: 'volLevel', severity: 2, level: 'danger', label: '', detail: '' },
      { key: 'c', family: 'drawdown', group: 'drawdownRecent', severity: 1, level: 'warn', label: '', detail: '' }
    ];
    assert.deepEqual(
      pickPrimarySignals(signals).map((s) => s.key),
      ['b', 'c']
    );
  });

  it('没有 group 时回落到 family 去重（兼容外部构造的信号）', () => {
    const signals = [
      { key: 'a', family: 'volLevel', severity: 1, level: 'warn', label: '', detail: '' },
      { key: 'b', family: 'volLevel', severity: 2, level: 'danger', label: '', detail: '' }
    ];
    assert.deepEqual(
      pickPrimarySignals(signals).map((s) => s.key),
      ['b']
    );
  });

  it('回撤的三个维度各自成组，必须全部保留（不能互相遮蔽）', () => {
    const signals = computeVolatilitySignals({
      vol5: null,
      vol20: 12,
      vol60: null,
      vol20Percentile: 10,
      volRatio: 1.0,
      maxDrawdown20: -9,
      maxDrawdown60: -14,
      currentDrawdown: -18
    });
    assert.deepEqual(
      pickPrimarySignals(signals).map((s) => s.key),
      ['deepDrawdown', 'deepCurrentDrawdown', 'largeDrawdown']
    );
  });

  it('展示顺序稳定：族顺序在前，族内 severity 降序', () => {
    const signals = computeVolatilitySignals({
      vol5: null,
      vol20: 12,
      vol60: null,
      vol20Percentile: 96,
      volRatio: 1.4,
      maxDrawdown20: -9,
      maxDrawdown60: null,
      currentDrawdown: null
    });
    assert.deepEqual(
      pickPrimarySignals(signals).map((s) => s.key),
      ['extremeVolatility', 'volatilityExpandingFast', 'largeDrawdown']
    );
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(pickPrimarySignals([]), []);
    assert.deepEqual(pickPrimarySignals(null), []);
  });
});

// ── 状态归并 ──────────────────────────────────────────────────────────────

describe('resolveVolatilityState', () => {
  const metricsWith = (patch) => ({
    vol20: 10,
    vol20Percentile: null,
    volRatio: null,
    maxDrawdown20: null,
    maxDrawdown60: null,
    currentDrawdown: null,
    ...patch
  });

  it('无信号 → 正常', () => {
    assert.equal(resolveVolatilityState(metricsWith({ vol20Percentile: 10, volRatio: 0.9 })), VOLATILITY_STATES.NORMAL);
  });

  it('高波动 + 较大回撤 → 独立合并状态', () => {
    assert.equal(
      resolveVolatilityState(metricsWith({ vol20Percentile: 85, maxDrawdown20: -10 })),
      VOLATILITY_STATES.HIGH_WITH_DRAWDOWN
    );
  });

  it('高波动 + 任意回撤维度 → 仍是合并状态（不只认 20 日口径）', () => {
    assert.equal(
      resolveVolatilityState(metricsWith({ vol20Percentile: 85, maxDrawdown60: -13 })),
      VOLATILITY_STATES.HIGH_WITH_DRAWDOWN
    );
    assert.equal(
      resolveVolatilityState(metricsWith({ vol20Percentile: 85, currentDrawdown: -13 })),
      VOLATILITY_STATES.HIGH_WITH_DRAWDOWN
    );
  });

  it('单纯较大回撤 → 回撤加深（不再错报为「正常」）', () => {
    assert.equal(resolveVolatilityState(metricsWith({ maxDrawdown20: -12 })), VOLATILITY_STATES.DRAWDOWN_DEEP);
  });

  it('60 日阴跌（20 日窗口看不到）→ 回撤加深', () => {
    assert.equal(resolveVolatilityState(metricsWith({ maxDrawdown60: -15 })), VOLATILITY_STATES.DRAWDOWN_DEEP);
  });

  it('回撤发生在更早、现已走平但仍深套 → 回撤加深', () => {
    assert.equal(resolveVolatilityState(metricsWith({ currentDrawdown: -18 })), VOLATILITY_STATES.DRAWDOWN_DEEP);
  });

  it('只有高波动 → 高波动', () => {
    assert.equal(resolveVolatilityState(metricsWith({ vol20Percentile: 85 })), VOLATILITY_STATES.HIGH);
  });

  it('回撤加深优先于波动扩大', () => {
    assert.equal(
      resolveVolatilityState(metricsWith({ volRatio: 1.2, maxDrawdown20: -12 })),
      VOLATILITY_STATES.DRAWDOWN_DEEP
    );
  });

  it('波动扩大 → 波动扩大', () => {
    assert.equal(resolveVolatilityState(metricsWith({ volRatio: 1.2 })), VOLATILITY_STATES.EXPANDING);
  });

  it('极端波动优先于「高波动 + 较大回撤」', () => {
    assert.equal(
      resolveVolatilityState(metricsWith({ vol20Percentile: 97, maxDrawdown20: -12 })),
      VOLATILITY_STATES.EXTREME
    );
  });

  it('无波动数据 → 数据不足', () => {
    assert.equal(resolveVolatilityState(metricsWith({ vol20: null })), VOLATILITY_STATES.INSUFFICIENT);
    assert.equal(resolveVolatilityState(null), VOLATILITY_STATES.INSUFFICIENT);
  });

  it('分位缺失但有绝对波动率时仍可判定「波动扩大」', () => {
    const state = resolveVolatilityState(metricsWith({ vol20Percentile: null, volRatio: 1.35 }));
    assert.equal(state, VOLATILITY_STATES.EXPANDING);
  });
});

// ── 状态与信号的一致性（「联动」的可测试形式） ────────────────────────────

describe('状态与信号永不矛盾', () => {
  /**
   * 穷举各维度阈值上下的组合，断言核心不变量：
   *   状态 === 正常  ⟺  没有任何信号命中
   * 状态必须能由 UI 里同时展示的那份信号列表解释，
   * 否则就会出现「状态说高波动、信号列表里一条高波动都没有」这类新矛盾。
   */
  const grid = [];
  for (const pct of [null, 10, 79.9, 80, 96]) {
    for (const ratio of [null, 1.0, 1.14, 1.15, 1.4]) {
      for (const mdd20 of [null, -3, -7.9, -8, -14]) {
        for (const mdd60 of [null, -5, -11.9, -12, -20]) {
          for (const cur of [null, -3, -11.9, -12, -25]) {
            grid.push({
              vol20: 12,
              vol20Percentile: pct,
              volRatio: ratio,
              maxDrawdown20: mdd20,
              maxDrawdown60: mdd60,
              currentDrawdown: cur
            });
          }
        }
      }
    }
  }

  it(`穷举 ${grid.length} 组阈值组合：正常 ⟺ 无信号`, () => {
    for (const metrics of grid) {
      const signals = computeVolatilitySignals(metrics);
      const state = resolveVolatilityState(metrics, signals);
      const label = JSON.stringify(metrics);

      if (signals.length === 0) {
        assert.equal(state, VOLATILITY_STATES.NORMAL, `无信号却不是正常：${label}`);
      } else {
        assert.notEqual(state, VOLATILITY_STATES.NORMAL, `有信号却显示正常：${label} → ${state}`);
      }
      // 高波动及以上必须真的命中了高波动信号
      const keys = new Set(signals.map((s) => s.key));
      if ([VOLATILITY_STATES.HIGH, VOLATILITY_STATES.HIGH_WITH_DRAWDOWN, VOLATILITY_STATES.EXTREME].includes(state)) {
        assert.ok(keys.has('highVolatility') || keys.has('extremeVolatility'), `高波动状态却没有对应信号：${label}`);
      }
      // 回撤加深必须真的命中了某个回撤信号
      if (state === VOLATILITY_STATES.DRAWDOWN_DEEP) {
        assert.ok(
          DRAWDOWN_SIGNAL_KEYS.some((k) => keys.has(k)),
          `回撤加深却没有回撤信号：${label}`
        );
      }
    }
  });

  it('状态严重度与信号强度单调：信号越多越强，状态不会更轻', () => {
    // 固定其他维度，只放开一个维度 → 状态严重度必须单调不减
    const base = {
      vol20: 12,
      vol20Percentile: 10,
      volRatio: 1.0,
      maxDrawdown20: -1,
      maxDrawdown60: -1,
      currentDrawdown: -1
    };
    let prev = -1;
    for (const pct of [10, 50, 79.9, 80, 90, 96]) {
      const severity = VOLATILITY_STATE_SEVERITY[resolveVolatilityState({ ...base, vol20Percentile: pct })];
      assert.ok(severity >= prev, `分位升到 ${pct} 时状态反而变轻了`);
      prev = severity;
    }
  });
});

// ── 风险评分 ──────────────────────────────────────────────────────────────

describe('computeRiskScore', () => {
  it('全部维度缺失 → null', () => {
    assert.equal(computeRiskScore({}), null);
    assert.equal(computeRiskScore(null), null);
  });

  it('分位越高分数越高', () => {
    const low = computeRiskScore({ vol20Percentile: 5, maxDrawdown20: 0, currentDrawdown: 0 });
    const high = computeRiskScore({ vol20Percentile: 95, maxDrawdown20: 0, currentDrawdown: 0 });
    assert.ok(high > low);
    assert.equal(low, 3);
    assert.equal(high, 48);
  });

  it('分位缺失时用绝对年化波动率兜底', () => {
    const score = computeRiskScore({ vol20Percentile: null, vol20: ABSOLUTE_VOLATILITY_CEILING });
    assert.equal(score, 100);
  });

  it('回撤到上限即满分', () => {
    assert.equal(computeRiskScore({ maxDrawdown20: -15, currentDrawdown: -12 }), 100);
  });

  it('结果夹紧在 0-100', () => {
    const score = computeRiskScore({ vol20Percentile: 100, maxDrawdown20: -999, currentDrawdown: -999 });
    assert.equal(score, 100);
  });

  it('缺失维度按剩余权重归一化，不当作 0 分', () => {
    // 只有分位一个维度时，分数应等于分位本身
    assert.equal(computeRiskScore({ vol20Percentile: 60 }), 60);
  });

  it('回撤维度取 20 日与 60 日的更深者（与状态机的输入保持一致）', () => {
    // 只看 20 日回撤会漏掉「60 日阴跌」，导致「状态=回撤加深、评分却很低」
    const onlyMdd20 = computeRiskScore({
      vol20Percentile: 0,
      maxDrawdown20: -5,
      maxDrawdown60: -14,
      currentDrawdown: -14
    });
    const withoutMdd60 = computeRiskScore({ vol20Percentile: 0, maxDrawdown20: -5, currentDrawdown: -5 });
    assert.ok(onlyMdd20 > withoutMdd60, `${onlyMdd20} 应大于 ${withoutMdd60}`);

    // 20 日与 60 日都给了 → 取更深的那个（-14），而不是相加或取平均
    const a = computeRiskScore({ vol20Percentile: null, maxDrawdown20: -14, maxDrawdown60: -3 });
    const b = computeRiskScore({ vol20Percentile: null, maxDrawdown20: -3, maxDrawdown60: -14 });
    assert.equal(a, b);
    assert.equal(a, 93);
  });

  it('评分与状态同向：状态越严重，评分不会反而更低', () => {
    const base = {
      vol20: 12,
      vol20Percentile: 10,
      volRatio: 1.0,
      maxDrawdown20: -1,
      maxDrawdown60: -1,
      currentDrawdown: -1
    };
    let prevScore = -1;
    let prevSeverity = -1;
    for (const patch of [
      {},
      { volRatio: 1.2 },
      { maxDrawdown20: -9 },
      { vol20Percentile: 85 },
      { vol20Percentile: 85, maxDrawdown20: -9 },
      { vol20Percentile: 96, maxDrawdown20: -9 }
    ]) {
      const metrics = { ...base, ...patch };
      const severity = VOLATILITY_STATE_SEVERITY[resolveVolatilityState(metrics)];
      const score = computeRiskScore(metrics);
      assert.ok(severity >= prevSeverity, `状态严重度倒退了：${JSON.stringify(patch)}`);
      assert.ok(score >= prevScore, `评分倒退了：${JSON.stringify(patch)} 得分 ${score} < ${prevScore}`);
      prevSeverity = severity;
      prevScore = score;
    }
  });
});

// ── 合并 / 裁剪 ───────────────────────────────────────────────────────────

describe('mergeNavSeries', () => {
  it('按日期求并集且新数据覆盖旧数据', () => {
    const merged = mergeNavSeries(
      [
        { date: '2024-01-01', unitNetValue: 1.0 },
        { date: '2024-01-02', unitNetValue: 1.1 }
      ],
      [
        { date: '2024-01-02', unitNetValue: 9.9 },
        { date: '2024-01-03', unitNetValue: 1.2 }
      ]
    );
    assert.deepEqual(
      merged.map((r) => r.date),
      ['2024-01-01', '2024-01-02', '2024-01-03']
    );
    assert.equal(merged[1].unitNav, 9.9);
  });

  it('任一侧为空时退化为另一侧', () => {
    assert.equal(mergeNavSeries(null, [{ date: '2024-01-01', unitNetValue: 1 }]).length, 1);
    assert.equal(mergeNavSeries([{ date: '2024-01-01', unitNetValue: 1 }], null).length, 1);
    assert.equal(mergeNavSeries(null, null).length, 0);
  });
});

describe('trimNavSeries', () => {
  it('超出上限时保留最近的 N 条', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ date: isoDate(i), unitNav: i }));
    const out = trimNavSeries(rows, 3);
    assert.equal(out.length, 3);
    assert.equal(out[2].date, isoDate(9));
  });

  it('未超上限时原样返回副本', () => {
    const rows = [{ date: isoDate(0), unitNav: 0 }];
    const out = trimNavSeries(rows, 3);
    assert.deepEqual(out, rows);
    assert.notEqual(out, rows);
  });

  it('非法上限不裁剪', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ date: isoDate(i), unitNav: i }));
    assert.equal(trimNavSeries(rows, 0).length, 5);
    assert.equal(trimNavSeries(rows, null).length, 5);
  });
});

// ── 端到端 ────────────────────────────────────────────────────────────────

describe('analyzeFundVolatility', () => {
  it('平稳序列 → 正常状态，无信号', () => {
    // 日收益率恒为 0：波动率精确为 0 → 比值退化为 null、分位为 0、回撤为 0，各条规则都不触发
    const flat = Array.from({ length: 300 }, (_, i) => ({
      date: isoDate(i),
      unitNetValue: 1,
      accumulatedNetValue: 1,
      equityReturn: 0
    }));
    const out = analyzeFundVolatility(flat);
    assert.equal(out.metrics.vol20, 0);
    assert.equal(out.metrics.volRatio, null);
    assert.equal(out.state, VOLATILITY_STATES.NORMAL);
    assert.equal(out.signals.length, 0);
    assert.equal(out.stateLevel, 'normal');
  });

  it('末尾波动剧烈放大 → 进入高波动及以上，并给出短期波动扩大信号', () => {
    const out = analyzeFundVolatility(
      buildSeries({ days: 1400, baseAmplitude: 0.005, tailDays: 25, tailAmplitude: 0.06 })
    );
    assert.ok(
      [VOLATILITY_STATES.HIGH, VOLATILITY_STATES.EXTREME, VOLATILITY_STATES.HIGH_WITH_DRAWDOWN].includes(out.state),
      `实际状态：${out.state}`
    );
    assert.ok(out.primarySignals.some((s) => s.family === 'volLevel' || s.family === 'volTrend'));
    assert.ok(Number.isFinite(out.riskScore));
  });

  it('确定性：同输入两次结果一致', () => {
    const rows = buildSeries({ days: 500, seed: 7 });
    assert.deepEqual(analyzeFundVolatility(rows), analyzeFundVolatility(rows));
  });

  it('空输入 → 数据不足且不抛异常', () => {
    const out = analyzeFundVolatility([]);
    assert.equal(out.state, VOLATILITY_STATES.INSUFFICIENT);
    assert.equal(out.riskScore, null);
  });
});

// ── 回撤口径（复权收益指数） ──────────────────────────────────────────────

describe('回撤口径（复权收益指数）', () => {
  it('回归护栏：分红除权日不得造出假回撤', () => {
    // 单位净值 0.5 / 累计净值 2.0 的基金，最后一日分红除权：
    // 单位净值跌 13%，但真实收益只有 -0.14%
    //（累计净值是绝对额相加，其绝对变化 ÷ 前一日单位净值才是真实盈亏）
    const rows = [];
    for (let i = 0; i < 24; i++) {
      rows.push({ date: isoDate(i), unitNetValue: 0.5, accumulatedNetValue: 2.0 });
    }
    rows.push({ date: isoDate(24), unitNetValue: 0.435, accumulatedNetValue: 1.9993 });

    const m = computeVolatilityMetrics(rows);
    assert.equal(m.navCount, 25);
    // 误用单位净值会得到 -13%，误用累计净值环比会得到 -0.035%，两者都是错的
    assert.ok(Math.abs(m.maxDrawdown20 - -0.14) < 1e-9, `20 日最大回撤实际为 ${m.maxDrawdown20}`);
    assert.ok(m.maxDrawdown20 > -1, '不得出现由分红造成的假深坑');
    assert.ok(Math.abs(m.currentDrawdown - -0.14) < 1e-9, `当前回撤实际为 ${m.currentDrawdown}`);
  });

  it('复权收益指数在分红/拆分日保持连续（不把净值下跌当成真跌）', () => {
    const rows = [];
    for (let i = 0; i < 60; i++) {
      rows.push({ date: isoDate(i), unitNetValue: 1, accumulatedNetValue: 1, equityReturn: 0 });
    }
    // 份额拆分：单位净值腰斩，但当日真实收益为 0
    rows.push({ date: isoDate(60), unitNetValue: 0.5, accumulatedNetValue: 1, equityReturn: 0 });

    const m = computeVolatilityMetrics(rows);
    assert.equal(m.vol5, 0);
    assert.equal(m.maxDrawdown20, 0);
    assert.equal(m.currentDrawdown, 0);
  });

  it('真实下跌仍然被正确计入（护栏不能把真回撤一起挡掉）', () => {
    const rows = [];
    for (let i = 0; i < 24; i++) {
      rows.push({ date: isoDate(i), unitNetValue: 1, accumulatedNetValue: 1, equityReturn: 0 });
    }
    rows.push({ date: isoDate(24), unitNetValue: 0.9, accumulatedNetValue: 0.9, equityReturn: -10 });

    const m = computeVolatilityMetrics(rows);
    assert.ok(Math.abs(m.maxDrawdown20 - -10) < 1e-9, `20 日最大回撤实际为 ${m.maxDrawdown20}`);
    assert.ok(Math.abs(m.currentDrawdown - -10) < 1e-9);
  });
});
