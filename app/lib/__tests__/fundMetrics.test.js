/**
 * 基金指标引擎单元测试
 *
 * 覆盖：
 *   - 13 项指标的解析解（CAGR / 年化波动率 / 最大回撤 / 夏普 / 索提诺 / 卡尔玛 /
 *     信息比率 / Alpha / Beta / VaR / CVaR / 胜率 / 盈亏比）
 *   - 分位数插值、下行标准差、尾部均值的边界
 *   - 基准日期对齐（同日精确匹配、lag 位移、缺口丢弃）
 *   - 数据不足门槛、缺失基准、除零兜底（绝不返回 NaN/Infinity）
 *   - 统计窗口常量与净值缓存保留窗口的一致性（防「网络取数 15 年、缓存命中 5 年」）
 *   - loadFundMetrics 编排：网络/缓存两条路径结果必须一致
 *
 * 运行：node --test app/lib/__tests__/fundMetrics.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RISK_FREE_RATE,
  METRICS_WINDOW_TRADING_DAYS,
  MIN_METRIC_SAMPLES,
  TRADING_DAYS_PER_YEAR,
  alignReturnsByDate,
  buildBenchmarkReturns,
  buildFundReturnPoints,
  computeArithmeticAnnualizedReturn,
  computeCVaR,
  computeCagr,
  computeDownsideDeviation,
  computeFundMetrics,
  computePairedMetrics,
  computeProfitLossRatio,
  computeQuantile,
  computeVaR,
  computeWinRate,
  detectCalendarOffset,
  yearsBetweenDates
} from '../fundMetrics.js';
import { NAV_RETENTION_DAYS, createFundVolatilityCache } from '../fundVolatilityCache.js';
import { createFundBenchmarkCache } from '../fundBenchmarkCache.js';
import { loadFundMetrics } from '../fundMetricsService.js';
import { normalizeNavSeries, trimNavSeries } from '../fundVolatility.js';

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

/** 'YYYY-MM-DD' 加减自然日（用于构造「整体错位一天」的日历） */
const shiftIso = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** 只落在工作日的日期序列（模拟真实交易日历，跳过周末） */
const BUSINESS_DAYS = (() => {
  const out = [];
  let ms = Date.UTC(2020, 0, 1);
  while (out.length < 6000) {
    const d = new Date(ms);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    ms += 86400000;
  }
  return out;
})();

/**
 * 由显式日收益率序列（%）构造净值行。
 * 每一行都声明 equityReturn，因此 normalizeNavSeries 产生的日收益个数 == returns.length。
 */
const buildRows = (returns, { startOffset = 0, dates = null } = {}) => {
  let nav = 1;
  return returns.map((ret, i) => {
    nav *= 1 + ret / 100;
    return {
      date: dates ? dates[startOffset + i] : isoDate(startOffset + i),
      unitNetValue: nav,
      accumulatedNetValue: nav,
      equityReturn: ret
    };
  });
};

/** 由收盘价构造基准日线行 */
const buildBenchmarkRows = (closes, { startOffset = 0, dates = null } = {}) =>
  closes.map((close, i) => ({ date: dates ? dates[startOffset + i] : isoDate(startOffset + i), close }));

/** 用「日收益率序列」反推收盘价：保证基准日收益率与给定序列逐日相等 */
const closesFromReturns = (returns, { base = 100 } = {}) => {
  const closes = [base];
  for (const ret of returns) closes.push(closes[closes.length - 1] * (1 + ret / 100));
  return closes;
};

/** 生成 m 个日收益率（%）的确定性随机序列 */
const randomReturns = (m, { seed = 7, amplitude = 1 } = {}) => {
  const rnd = makeSeededRandom(seed);
  return Array.from({ length: m }, () => rnd() * amplitude * 2);
};

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const sampleStd = (values) => {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
};

/** 断言「全部 13 项指标都是 null」，用于数据不足场景 */
const assertAllMetricsNull = (m) => {
  for (const key of [
    'cagr',
    'annualizedVolatility',
    'maxDrawdown',
    'sharpe',
    'sortino',
    'calmar',
    'informationRatio',
    'alpha',
    'beta',
    'var95',
    'cvar95',
    'winRate',
    'profitLossRatio'
  ]) {
    assert.equal(m[key], null, `${key} 应为 null`);
  }
};

/** 断言输出里没有任何 NaN / Infinity */
const assertAllFinite = (m) => {
  for (const [key, value] of Object.entries(m)) {
    if (value == null) continue;
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} 不是有限数：${value}`);
  }
};

// ── 分位数 / 基础工具 ─────────────────────────────────────────────────────

describe('computeQuantile', () => {
  it('线性插值（等价 numpy 默认行为）', () => {
    const sorted = [1, 2, 3, 4, 5];
    assert.equal(computeQuantile(sorted, 0), 1);
    assert.equal(computeQuantile(sorted, 1), 5);
    assert.equal(computeQuantile(sorted, 0.5), 3);
    // pos = 0.25 × 4 = 1 → 2
    assert.equal(computeQuantile(sorted, 0.25), 2);
    // pos = 0.125 × 4 = 0.5 → 1.5
    assert.equal(computeQuantile(sorted, 0.125), 1.5);
  });

  it('空样本返回 null，越界 p 夹紧到 [0,1]', () => {
    assert.equal(computeQuantile([], 0.05), null);
    assert.equal(computeQuantile(null, 0.05), null);
    assert.equal(computeQuantile([1, 2, 3], -1), 1);
    assert.equal(computeQuantile([1, 2, 3], 2), 3);
  });
});

// ── CAGR ──────────────────────────────────────────────────────────────────

describe('computeCagr', () => {
  it('恒定日收益 → (1+r)^252 − 1（解析解）', () => {
    const r = 0.1; // 每日 +0.1%
    const index = [1];
    for (let i = 0; i < 252; i++) index.push(index[index.length - 1] * (1 + r / 100));
    const cagr = computeCagr(index);
    const expected = (Math.pow(1 + r / 100, TRADING_DAYS_PER_YEAR) - 1) * 100;
    assert.ok(Math.abs(cagr - expected) < 1e-9, `${cagr} vs ${expected}`);
    // (1.001)^252 − 1 ≈ 28.64%
    assert.ok(Math.abs(cagr - 28.64) < 0.01, `cagr=${cagr}`);
  });

  it('恒定日收益与「按交易日数缩放」自洽：半年数据也能还原同一个年化', () => {
    const r = 0.05;
    const half = [1];
    for (let i = 0; i < 126; i++) half.push(half[half.length - 1] * (1 + r / 100));
    const cagr = computeCagr(half);
    const expected = (Math.pow(1 + r / 100, TRADING_DAYS_PER_YEAR) - 1) * 100;
    assert.ok(Math.abs(cagr - expected) < 1e-9);
  });

  it('传 options.years 时按真实年数年化（点数有缺口时不再被放大）', () => {
    const index = [1, 1.21];
    // 只有一个步长时点数口径会把 21% 当成「一年 252 步」→ 天文数字
    assert.ok(computeCagr(index) > 1000);
    const cagr = computeCagr(index, { years: 2 });
    assert.ok(Math.abs(cagr - 10) < 1e-9, `cagr=${cagr}`);
    // 非法 years 回退点数口径
    assert.ok(computeCagr(index, { years: 0 }) > 1000);
    assert.ok(computeCagr(index, { years: Number.NaN }) > 1000);
  });

  it('computeFundMetrics 的 CAGR 用净值首尾日期年化，而不是「点数/252」', () => {
    const rows = buildRows(new Array(300).fill(0.1));
    const m = computeFundMetrics({ rows });
    const years = (Date.parse(rows[rows.length - 1].date) - Date.parse(rows[0].date)) / (365.25 * 24 * 60 * 60 * 1000);
    const ratio = Math.pow(1.001, 300);
    const expected = (Math.pow(ratio, 1 / years) - 1) * 100;
    assert.ok(Math.abs(m.cagr - expected) < 0.01, `${m.cagr} vs ${expected}`);
    // 旧口径（299 点当作 299/252 年）会显著低估
    const pointBased = (Math.pow(ratio, TRADING_DAYS_PER_YEAR / 299) - 1) * 100;
    assert.ok(m.cagr - pointBased > 10, `日历年化应明显高于点数口径（${m.cagr} vs ${pointBased}）`);
  });

  it('全零收益 → 0；只剩一个点/非法值 → null', () => {
    assert.equal(computeCagr([1, 1, 1]), 0);
    assert.equal(computeCagr([1]), null);
    assert.equal(computeCagr(null), null);
    assert.equal(computeCagr([1, 0]), null, '指数为 0 时不可取对数增长率');
    assert.equal(computeCagr([1, -2]), null);
  });
});

describe('yearsBetweenDates', () => {
  it('按 365.25 天/年计算，非法输入返回 null', () => {
    assert.ok(Math.abs(yearsBetweenDates('2024-01-01', '2025-12-31') - 2) < 0.01);
    assert.equal(yearsBetweenDates(null, '2025-01-01'), null);
    assert.equal(yearsBetweenDates('2025-01-01', '2025-01-01'), null);
    assert.equal(yearsBetweenDates('2025-12-31', '2025-01-01'), null, '倒序不算年数');
  });
});

// ── 波动 / 回撤 / 下行风险 ────────────────────────────────────────────────

describe('年化波动率 / 最大回撤 / 下行标准差', () => {
  it('恒定收益 → 年化波动率 0、下行标准差 0', () => {
    const m = computeFundMetrics({ rows: buildRows(new Array(120).fill(0.2)) });
    // 浮点累加会留下 ~1e-15 的残差，故用容差；绝对值上必须可视为 0
    assert.ok(Math.abs(m.annualizedVolatility) < 1e-9, `vol=${m.annualizedVolatility}`);
    assert.equal(m.sortino, null, '下行标准差为 0 → 索提诺不可比');
    assert.equal(m.sharpe, null, '年化波动率 0 → 夏普不可比');
    assert.equal(m.cagr > 0, true);
  });

  it('年化波动率 = 样本标准差 × √252（独立手算对照）', () => {
    const returns = randomReturns(200);
    const m = computeFundMetrics({ rows: buildRows(returns) });
    const expected = sampleStd(returns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    assert.ok(Math.abs(m.annualizedVolatility - expected) < 1e-9);
  });

  it('最大回撤取「峰值到谷底」：+10% / −50% / +20% → −50%', () => {
    const m = computeFundMetrics({ rows: buildRows([10, -50, 20]) });
    // 样本不足 60，故直接验证单指标的等价序列（用 normalize + 复权指数走 computeMaxDrawdown 的入口）
    assert.equal(m.maxDrawdown, null);
    assert.equal(m.insufficient, true);

    const many = [...new Array(MIN_METRIC_SAMPLES).fill(0.5), 10, -50, 20];
    const full = computeFundMetrics({ rows: buildRows(many) });
    // 峰值出现在 +10% 那天，谷底在 −50% 那天 → 相对峰值 −50%
    assert.ok(Math.abs(full.maxDrawdown - -50) < 1e-9, `实际 ${full.maxDrawdown}`);
  });

  it('单调上涨 → 最大回撤 0 → 卡尔玛为 null（不做除零）', () => {
    const m = computeFundMetrics({ rows: buildRows(new Array(120).fill(0.3)) });
    assert.equal(m.maxDrawdown, 0);
    assert.equal(m.calmar, null);
  });

  it('下行标准差只统计低于 MAR 的部分，分母是全部周期（样本口径 n−1）', () => {
    const returns = [1, -2, 3, -4, 5];
    const mar = 0;
    // 样本口径 ddof=1（n−1=4），与夏普分母的 annualizeVolatility 对齐
    const expected = Math.sqrt((4 + 16) / 4) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    assert.ok(Math.abs(computeDownsideDeviation(returns, mar) - expected) < 1e-9);
    // 全部为正 → 0
    assert.equal(computeDownsideDeviation([1, 2, 3], 0), 0);
    assert.equal(computeDownsideDeviation([], 0), null);
  });
});

// ── 风险调整后收益 ────────────────────────────────────────────────────────

describe('夏普 / 索提诺 / 卡尔玛', () => {
  it('夏普 = (算术年化收益 − 无风险) / 年化波动率', () => {
    const returns = randomReturns(220, { seed: 11 });
    const m = computeFundMetrics({ rows: buildRows(returns), riskFreeRate: 2 });
    const expected =
      (mean(returns) * TRADING_DAYS_PER_YEAR - 2) / (sampleStd(returns) * Math.sqrt(TRADING_DAYS_PER_YEAR));
    assert.ok(Math.abs(m.sharpe - expected) < 1e-9);
    assert.ok(Math.abs(m.arithmeticAnnualizedReturn - mean(returns) * TRADING_DAYS_PER_YEAR) < 1e-9);
  });

  it('索提诺 = (算术年化收益 − 无风险) / 下行标准差', () => {
    const returns = randomReturns(220, { seed: 13 });
    const m = computeFundMetrics({ rows: buildRows(returns), riskFreeRate: 2 });
    const dd = computeDownsideDeviation(returns, 2 / TRADING_DAYS_PER_YEAR);
    const expected = (mean(returns) * TRADING_DAYS_PER_YEAR - 2) / dd;
    assert.ok(Math.abs(m.sortino - expected) < 1e-9);
  });

  it('卡尔玛 = CAGR / |最大回撤|（几何口径）', () => {
    const returns = [...new Array(120).fill(0.2), -30];
    const m = computeFundMetrics({ rows: buildRows(returns) });
    assert.ok(m.maxDrawdown < 0);
    assert.ok(Math.abs(m.calmar - m.cagr / Math.abs(m.maxDrawdown)) < 1e-9);
  });

  it('自定义无风险利率会改夏普 / 索提诺 / Alpha，但不动 CAGR', () => {
    const returns = randomReturns(150, { seed: 17 });
    const rows = buildRows(returns);
    const low = computeFundMetrics({ rows, riskFreeRate: 0 });
    const high = computeFundMetrics({ rows, riskFreeRate: 5 });
    assert.equal(low.cagr, high.cagr);
    assert.notEqual(low.sharpe, high.sharpe);
    assert.ok(low.sharpe > high.sharpe, '无风险利率越高，夏普越低');
  });
});

// ── VaR / CVaR / 胜率 / 盈亏比 ───────────────────────────────────────────

describe('VaR / CVaR / 胜率 / 盈亏比', () => {
  it('VaR 是 5% 分位（线性插值），CVaR 是尾部均值', () => {
    const seq = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    assert.ok(Math.abs(computeVaR(seq) - 5.95) < 1e-9);
    assert.equal(computeCVaR(seq), 3); // (1+2+3+4+5) / 5
  });

  it('全为正收益时 VaR 仍可计算；全为负收益时 CVaR = 均值', () => {
    assert.ok(computeVaR([1, 2, 3]) > 0);
    assert.equal(computeCVaR([-1, -1, -1]), -1);
    assert.equal(computeVaR([]), null);
    assert.equal(computeCVaR([], 0.95), null);
  });

  it('胜率分母是全部有效交易日（收益 0 计入分母不计入分子）', () => {
    assert.equal(computeWinRate([1, -1, 0, 2]), 50);
    assert.equal(computeWinRate([1, 2, 3]), 100);
    assert.equal(computeWinRate([-1, -2]), 0);
    assert.equal(computeWinRate([]), null);
  });

  it('盈亏比 = 正收益之和 / 负收益绝对值之和', () => {
    assert.equal(computeProfitLossRatio([1, -1, 2, -3]), 0.75);
    assert.equal(computeProfitLossRatio([2, -1]), 2);
    assert.equal(computeProfitLossRatio([1, 2, 3]), null, '无亏损日 → null 而不是 Infinity');
    assert.equal(computeProfitLossRatio([]), null);
  });
});

// ── 基准：对齐 + Beta / Alpha / 信息比率 ─────────────────────────────────

describe('alignReturnsByDate', () => {
  const fund = [
    { date: '2024-01-01', ret: 1 },
    { date: '2024-01-02', ret: 2 },
    { date: '2024-01-03', ret: 3 }
  ];
  const bench = [
    { date: '2024-01-01', ret: 10 },
    { date: '2024-01-02', ret: 20 },
    { date: '2024-01-03', ret: 30 }
  ];

  it('按日期精确匹配', () => {
    const pairs = alignReturnsByDate(fund, [{ date: '2024-01-02', ret: 20 }]);
    assert.deepEqual(pairs, [{ date: '2024-01-02', fund: 2, bench: 20 }]);
  });

  it('基准缺该日 → 丢弃，而不是沿用前一日（carry-forward 会把同一段涨跌数两遍）', () => {
    // 基准只有 01-01：01-02 / 01-03 均无同日基准收益 → 只能配出 1 条
    const pairs = alignReturnsByDate(fund, [{ date: '2024-01-01', ret: 10 }]);
    assert.deepEqual(pairs, [{ date: '2024-01-01', fund: 1, bench: 10 }]);

    // 稀疏基准（中间断档）：断档日一律不配对
    const sparseBench = [
      { date: '2024-01-01', ret: 10 },
      { date: '2024-01-04', ret: 40 }
    ];
    assert.deepEqual(alignReturnsByDate(fund, sparseBench), [{ date: '2024-01-01', fund: 1, bench: 10 }]);
  });

  it('基准早于基金起点 / 空输入 → 空配对', () => {
    assert.deepEqual(alignReturnsByDate(fund, [{ date: '2023-12-31', ret: 5 }]), []);
    assert.deepEqual(alignReturnsByDate([], bench), []);
    assert.deepEqual(alignReturnsByDate(fund, []), []);
    assert.deepEqual(alignReturnsByDate(null, null), []);
  });

  it('基准收益缺失或非法 → 该点丢弃，不产出 NaN 配对', () => {
    const dirtyBench = [
      { date: '2024-01-01', ret: 10 },
      { date: '2024-01-02', ret: null },
      { date: '2024-01-03', ret: 30 }
    ];
    assert.deepEqual(alignReturnsByDate(fund, dirtyBench), [
      { date: '2024-01-01', fund: 1, bench: 10 },
      { date: '2024-01-03', fund: 3, bench: 30 }
    ]);
  });

  it('offsetDays 会把基金日期校准到基准日历上（不校准就是错配一天）', () => {
    // 模拟「非 UTC+8 浏览器」：基金日期整体早一天，基准日期是绝对日历日
    const shiftedFund = fund.map((p) => ({ date: shiftIso(p.date, -1), ret: p.ret }));

    // 不校准：日期仍然命中，但配到的是**前一天的基准收益**——这正是产生假 Beta 的路径
    assert.deepEqual(alignReturnsByDate(shiftedFund, bench, { offsetDays: 0 }), [
      { date: '2024-01-01', fund: 2, bench: 10 },
      { date: '2024-01-02', fund: 3, bench: 20 }
    ]);

    // 校准 +1 天：日期与收益一一对应
    assert.deepEqual(alignReturnsByDate(shiftedFund, bench, { offsetDays: 1 }), [
      { date: shiftIso('2024-01-01', -1), fund: 1, bench: 10 },
      { date: shiftIso('2024-01-02', -1), fund: 2, bench: 20 },
      { date: shiftIso('2024-01-03', -1), fund: 3, bench: 30 }
    ]);
  });
});

describe('detectCalendarOffset', () => {
  const benchDates = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'];
  const benchPoints = benchDates.map((date) => ({ date, ret: 1 }));

  it('两侧日历天然对齐 → 偏移 0', () => {
    const fundPoints = benchDates.map((date) => ({ date, ret: 2 }));
    const out = detectCalendarOffset(fundPoints, benchPoints);
    assert.equal(out.offsetDays, 0);
    assert.equal(out.matchRatio, 1);
  });

  it('基金日期整体早一天 → 探测出 +1', () => {
    const fundPoints = benchDates.map((date) => ({ date: shiftIso(date, -1), ret: 2 }));
    const out = detectCalendarOffset(fundPoints, benchPoints);
    assert.equal(out.offsetDays, 1);
    assert.equal(out.matchRatio, 1);
  });

  it('基金日期整体晚一天 → 探测出 −1', () => {
    const fundPoints = benchDates.map((date) => ({ date: shiftIso(date, 1), ret: 2 }));
    assert.equal(detectCalendarOffset(fundPoints, benchPoints).offsetDays, -1);
  });

  it('命中率不足阈值 → 偏移退回 0（不做无根据的平移）', () => {
    // 只有 1/5 命中，任何候选都不足 60%
    const fundPoints = [benchDates[0], '2030-01-01', '2030-01-02', '2030-01-03', '2030-01-04'].map((date) => ({
      date,
      ret: 1
    }));
    const out = detectCalendarOffset(fundPoints, benchPoints);
    assert.equal(out.offsetDays, 0);
    assert.ok(out.matchRatio < 0.6);
  });

  it('空输入安全返回 0', () => {
    assert.deepEqual(detectCalendarOffset([], benchPoints), { offsetDays: 0, matchRatio: 0, bestMatches: 0 });
    assert.deepEqual(detectCalendarOffset(benchPoints, []), { offsetDays: 0, matchRatio: 0, bestMatches: 0 });
    assert.deepEqual(detectCalendarOffset(null, null), { offsetDays: 0, matchRatio: 0, bestMatches: 0 });
  });
});

describe('Beta / Alpha / 信息比率', () => {
  const m = 200;
  const baseReturns = randomReturns(m, { seed: 23 });
  // 用「跳过周末」的日历：否则相邻自然日全都是「交易日」，
  // 整体错位一天仍然能命中，无法区分对齐与错配（真实交易日历正是靠周末制造差异）
  const benchRows = buildBenchmarkRows(closesFromReturns(baseReturns), { dates: BUSINESS_DAYS });

  /** 基准日收益率（与 baseReturns 逐日相等） */
  const benchReturns = buildBenchmarkReturns(benchRows);
  const benchPoints = benchReturns.map((r, i) => ({ date: isoDate(i), ret: r.ret }));

  it('基金 == 基准 → Beta≈1、Alpha≈0、信息比率 null（主动收益恒为 0）', () => {
    const fundRows = buildRows([0, ...baseReturns], { dates: BUSINESS_DAYS });
    const metrics = computeFundMetrics({
      rows: fundRows,
      benchmark: { secid: '1.000300', name: '沪深300', rows: benchRows }
    });
    assert.ok(Math.abs(metrics.beta - 1) < 1e-9, `beta=${metrics.beta}`);
    assert.ok(Math.abs(metrics.alpha) < 1e-9, `alpha=${metrics.alpha}`);
    assert.equal(metrics.informationRatio, null);
    assert.equal(metrics.benchmarkName, '沪深300');
    assert.ok(metrics.pairedSampleCount >= MIN_METRIC_SAMPLES);
  });

  it('基金 == 2 × 基准 → Beta≈2、Alpha = 无风险利率 × (β − 1)', () => {
    // 注意 alpha 不会因为「同比例放大」而归零：β=2 时 CAPM 已经把 2 倍无风险收益算进基准项，
    // 于是 alpha = (2μ_b·252 − rf) − 2(μ_b·252 − rf) = rf × (β − 1)
    const benchRowsHere = buildBenchmarkRows(closesFromReturns(baseReturns), { dates: BUSINESS_DAYS });
    const fundRows = buildRows([0, ...baseReturns.map((r) => r * 2)], { dates: BUSINESS_DAYS });
    const metrics = computeFundMetrics({
      rows: fundRows,
      benchmark: { secid: '1.000300', name: '沪深300', rows: benchRowsHere },
      riskFreeRate: 2
    });
    assert.ok(Math.abs(metrics.beta - 2) < 1e-9, `beta=${metrics.beta}`);
    assert.ok(Math.abs(metrics.alpha - 2 * (metrics.beta - 1)) < 1e-9, `alpha=${metrics.alpha}`);
    // 主动收益 = 基准收益（2×基准 − 基准），信息比率可由手算公式复核
    const active = baseReturns;
    const expectedIr = (mean(active) * TRADING_DAYS_PER_YEAR) / (sampleStd(active) * Math.sqrt(TRADING_DAYS_PER_YEAR));
    assert.ok(Math.abs(metrics.informationRatio - expectedIr) < 1e-9, `ir=${metrics.informationRatio}`);
  });

  it('配对样本不足门槛 → 三项为 null，其余指标照常', () => {
    const fewBench = buildBenchmarkRows(closesFromReturns(randomReturns(20, { seed: 31 })), { dates: BUSINESS_DAYS });
    const metrics = computeFundMetrics({
      rows: buildRows([0, ...baseReturns], { dates: BUSINESS_DAYS }),
      benchmark: { secid: '1.000300', name: '沪深300', rows: fewBench }
    });
    assert.equal(metrics.beta, null);
    assert.equal(metrics.alpha, null);
    assert.equal(metrics.informationRatio, null);
    assert.ok(Number.isFinite(metrics.cagr));
    assert.equal(metrics.insufficient, false);
  });

  it('基准恒定（方差 0）→ Beta / Alpha 为 null，不返回 NaN', () => {
    const flat = buildBenchmarkRows(new Array(150).fill(100), { dates: BUSINESS_DAYS });
    const metrics = computeFundMetrics({
      rows: buildRows([0, ...baseReturns], { dates: BUSINESS_DAYS }),
      benchmark: { secid: '1.000300', name: '沪深300', rows: flat }
    });
    assert.equal(metrics.beta, null, '基准方差为 0 → Beta 无定义');
    assert.equal(metrics.alpha, null, 'Beta 缺失 → Alpha 无法计算');
    // 信息比率仍可计算：基准恒为 0 收益时主动收益就等于基金收益本身，跟踪误差 = 基金波动率
    assert.ok(Number.isFinite(metrics.informationRatio));
    assertAllFinite(metrics);
  });

  it('回归护栏：基金与基准完全相同时，浮点噪声不得变成天文数字的信息比率', () => {
    // 基准收益率由收盘价反推，存在 ~1e-15 的往返误差；std(主动收益) 会是 1e-15 而不是 0。
    // 没有离散度下限时这里会算出 1.19 这种纯噪声值。
    const metrics = computeFundMetrics({
      rows: buildRows([0, ...baseReturns], { dates: BUSINESS_DAYS }),
      benchmark: { secid: '1.000300', name: '沪深300', rows: benchRows }
    });
    assert.equal(metrics.informationRatio, null);
    assert.ok(Math.abs(metrics.alpha) < 1e-9);
  });

  it('回归护栏：净值日期整体早一天（非 UTC+8 浏览器）时，Beta/Alpha 必须与对齐情形一致', () => {
    // 天天基金净值时间戳是 CST 零点（16:00Z），app/api/fund.js 用浏览器时区还原日期：
    // 在 UTC / 美洲时区下全部净值日期会早一天。若不探测日历偏移，
    // 精确匹配只剩约 78%，其余点错配一天 —— 实测 Beta 会从 ≈1 掉到 -0.06（静默的错值）。
    const alignedRows = buildRows([0, ...baseReturns], { dates: BUSINESS_DAYS });
    const shiftedRows = buildRows([0, ...baseReturns], { dates: BUSINESS_DAYS }).map((row) => ({
      ...row,
      date: shiftIso(row.date, -1)
    }));
    const benchmark = { secid: '1.000300', name: '沪深300', rows: benchRows };

    const aligned = computeFundMetrics({ rows: alignedRows, benchmark });
    const shifted = computeFundMetrics({ rows: shiftedRows, benchmark });

    assert.equal(aligned.alignmentOffsetDays, 0);
    assert.equal(shifted.alignmentOffsetDays, 1, '应探测出「基金日期 → 基准日期」偏移 +1 天');
    assert.ok(Math.abs(shifted.beta - aligned.beta) < 1e-9, `beta ${shifted.beta} vs ${aligned.beta}`);
    assert.ok(Math.abs(shifted.beta - 1) < 1e-9);
    assert.ok(Math.abs(shifted.alpha - aligned.alpha) < 1e-9);
    assert.equal(shifted.pairedSampleCount, aligned.pairedSampleCount);
    // 基金自身指标完全不受日历偏移影响
    assert.equal(shifted.cagr, aligned.cagr);
    assert.equal(shifted.maxDrawdown, aligned.maxDrawdown);
  });

  it('computePairedMetrics 对样本不足 / 非法输入一律返回全 null', () => {
    assert.deepEqual(computePairedMetrics([]), {
      beta: null,
      alpha: null,
      informationRatio: null,
      trackingError: null,
      activeReturn: null
    });
    assert.equal(computePairedMetrics(new Array(59).fill({ fund: 1, bench: 1 })).beta, null);
  });

  it('信息比率 = 年化主动收益 / 年化跟踪误差', () => {
    // 主动收益必须是有波动的：恒定主动收益会让跟踪误差为 0，信息比率退化为 null
    const pairs = benchPoints.map((p, i) => ({ fund: p.ret + ((i % 7) - 3) * 0.02, bench: p.ret }));
    const stats = computePairedMetrics(pairs, { riskFreeRate: 2 });
    const active = pairs.map((p) => p.fund - p.bench);
    assert.ok(Math.abs(stats.activeReturn - mean(active) * TRADING_DAYS_PER_YEAR) < 1e-9);
    assert.ok(Math.abs(stats.trackingError - sampleStd(active) * Math.sqrt(TRADING_DAYS_PER_YEAR)) < 1e-9);
    assert.ok(Math.abs(stats.informationRatio - stats.activeReturn / stats.trackingError) < 1e-9);
  });
});

// ── 整体入口 ──────────────────────────────────────────────────────────────

describe('computeFundMetrics', () => {
  it('样本不足门槛 → 全部指标 null 且 insufficient=true', () => {
    const m = computeFundMetrics({ rows: buildRows(randomReturns(MIN_METRIC_SAMPLES - 1)) });
    assert.equal(m.insufficient, true);
    assert.equal(m.sampleCount, MIN_METRIC_SAMPLES - 1);
    assertAllMetricsNull(m);
    assert.equal(m.startDate, isoDate(0));
    assert.equal(m.endDate, isoDate(MIN_METRIC_SAMPLES - 2));
  });

  it('恰好达到门槛即可计算', () => {
    const m = computeFundMetrics({ rows: buildRows(randomReturns(MIN_METRIC_SAMPLES)) });
    assert.equal(m.insufficient, false);
    assert.equal(m.sampleCount, MIN_METRIC_SAMPLES);
    assert.ok(Number.isFinite(m.cagr));
  });

  it('无基准时仅信息比率 / Alpha / Beta 缺失', () => {
    const m = computeFundMetrics({ rows: buildRows(randomReturns(200, { seed: 41 })) });
    assert.equal(m.benchmarkSecid, null);
    assert.equal(m.benchmarkName, null);
    assert.equal(m.beta, null);
    assert.equal(m.alpha, null);
    assert.equal(m.informationRatio, null);
    assert.ok(Number.isFinite(m.cagr));
    assert.ok(Number.isFinite(m.var95));
    assert.ok(Number.isFinite(m.winRate));
  });

  it('空序列 / null 输入安全降级', () => {
    assertAllMetricsNull(computeFundMetrics({ rows: [] }));
    assertAllMetricsNull(computeFundMetrics({}));
    assertAllMetricsNull(computeFundMetrics());
    assert.equal(computeFundMetrics({ rows: [] }).insufficient, true);
  });

  it('输出不含 NaN / Infinity（含极端序列）', () => {
    const wild = [...randomReturns(200, { seed: 43, amplitude: 5 }), -99, 500, -80];
    assertAllFinite(computeFundMetrics({ rows: buildRows(wild) }));
    assertAllFinite(computeFundMetrics({ rows: buildRows(new Array(100).fill(0)) }));
    assertAllFinite(
      computeFundMetrics({
        rows: buildRows(randomReturns(100, { seed: 47 })),
        benchmark: { secid: 'x', name: 'x', rows: [] }
      })
    );
  });

  it('确定性：同输入两次调用结果完全一致', () => {
    const rows = buildRows(randomReturns(180, { seed: 53 }));
    const first = computeFundMetrics({ rows });
    const second = computeFundMetrics({ rows });
    assert.deepEqual(second, first);
  });

  it('buildFundReturnPoints 保留日期与收益率的配对（dailyReturn 缺失行不会错位）', () => {
    const series = normalizeNavSeries([
      // 首日单位净值为 0 → 次日无法推算收益，normalizeNavSeries 会留下 dailyReturn = null 的行
      { date: '2024-01-01', unitNetValue: 0, equityReturn: 1 },
      { date: '2024-01-02', unitNetValue: 0.5 },
      { date: '2024-01-03', unitNetValue: 1, equityReturn: 3 }
    ]);
    assert.equal(series[1].dailyReturn, null, '前提：中间行确实没有收益率');

    const points = buildFundReturnPoints(series);
    assert.deepEqual(points, [
      { date: '2024-01-01', ret: 1 },
      { date: '2024-01-03', ret: 3 }
    ]);
    // 反例守卫：若按「过滤后的下标」去取 series[i+1].date，第二个点会错标成 2024-01-02
    assert.equal(points[1].date, '2024-01-03');
  });

  it('算术年化收益 = 均值 × 252', () => {
    const returns = randomReturns(100, { seed: 59 });
    assert.ok(Math.abs(computeArithmeticAnnualizedReturn(returns) - mean(returns) * TRADING_DAYS_PER_YEAR) < 1e-9);
    assert.equal(computeArithmeticAnnualizedReturn([]), null);
  });

  it('无风险利率默认值与常量一致', () => {
    const m = computeFundMetrics({ rows: buildRows(randomReturns(100, { seed: 61 })) });
    assert.equal(m.riskFreeRate, DEFAULT_RISK_FREE_RATE);
    assert.equal(DEFAULT_RISK_FREE_RATE, 2);
  });
});

// ── 窗口一致性（回归护栏） ────────────────────────────────────────────────

describe('统计窗口与净值缓存保留窗口一致（回归护栏）', () => {
  it('METRICS_WINDOW_TRADING_DAYS 必须等于 NAV_RETENTION_DAYS', () => {
    // 净值缓存只保留这么多天。若指标窗口比它大，命中缓存时拿不到足够历史，
    // 就会退化成「网络取数算 15 年、刷新后命中缓存算 5 年」，同一只基金出现两个年化收益。
    assert.equal(METRICS_WINDOW_TRADING_DAYS, NAV_RETENTION_DAYS);
  });

  it('先裁剪再计算 == 只喂裁剪后的序列', () => {
    const returns = randomReturns(METRICS_WINDOW_TRADING_DAYS + 200, { seed: 67 });
    const rows = buildRows(returns);
    const trimmed = trimNavSeries(rows, METRICS_WINDOW_TRADING_DAYS);
    assert.deepEqual(
      computeFundMetrics({ rows: trimmed }),
      computeFundMetrics({ rows: trimNavSeries(rows, METRICS_WINDOW_TRADING_DAYS) })
    );
    assert.equal(computeFundMetrics({ rows: trimmed }).sampleCount, METRICS_WINDOW_TRADING_DAYS);
  });
});

// ── 编排层 ────────────────────────────────────────────────────────────────

/** 内存版 adapter：接口与 app/lib/idb.js 的 4 个函数一致 */
const createMemoryAdapter = () => {
  const map = new Map();
  const key = (store, k) => `${store}\u001f${k}`;
  return {
    async get(store, k) {
      const v = map.get(key(store, k));
      return v === undefined ? null : structuredClone(v);
    },
    async set(store, k, value) {
      map.set(key(store, k), structuredClone(value));
      return true;
    },
    async delete(store, k) {
      return map.delete(key(store, k));
    },
    async clear(store) {
      for (const k of [...map.keys()]) {
        if (k.startsWith(`${store}\u001f`)) map.delete(k);
      }
      return true;
    },
    size: () => map.size
  };
};

describe('loadFundMetrics', () => {
  const navReturns = randomReturns(1400, { seed: 71 });
  const navRows = buildRows(navReturns);
  const benchBase = randomReturns(1300, { seed: 73 });
  const benchRows = buildBenchmarkRows(closesFromReturns(benchBase));
  const benchmarkPayload = { secid: '1.000300', name: '沪深300', rows: benchRows };

  const makeFetchHistory = (rows, { fail = false } = {}) => {
    const calls = [];
    const fn = async (code) => {
      calls.push(code);
      if (fail) throw new Error('净值源不可达');
      return rows;
    };
    fn.calls = calls;
    return fn;
  };

  const makeFetchBenchmark = (payload, { fail = false } = {}) => {
    const calls = [];
    const fn = async (secid) => {
      calls.push(secid);
      if (fail) throw new Error('基准源不可达');
      return payload;
    };
    fn.calls = calls;
    return fn;
  };

  const setup = () => {
    const adapter = createMemoryAdapter();
    return {
      adapter,
      cache: createFundVolatilityCache(adapter),
      benchmarkCache: createFundBenchmarkCache(adapter)
    };
  };

  it('首次调用：净值与基准都走网络并回写缓存，窗口被裁剪到保留窗口', async () => {
    const { cache, benchmarkCache } = setup();
    const fetchHistory = makeFetchHistory(navRows);
    const fetchBenchmark = makeFetchBenchmark(benchmarkPayload);

    const result = await loadFundMetrics('110022', {
      fetchHistory,
      fetchBenchmark,
      cache,
      benchmarkCache,
      basic: { code: '110022', name: '易方达消费行业股票' }
    });

    assert.equal(result.code, '110022');
    assert.equal(result.sources.nav, 'network');
    assert.equal(result.sources.benchmark, 'network');
    assert.equal(result.metrics.insufficient, false);
    assert.equal(result.metrics.sampleCount, METRICS_WINDOW_TRADING_DAYS, '必须裁剪到净值缓存保留窗口');
    assert.equal(result.benchmark.secid, '1.000300');
    assert.equal(result.benchmark.name, '沪深300');
    assert.ok(Number.isFinite(result.metrics.beta));
    assert.ok(Number.isFinite(result.metrics.cagr));
    assert.equal(fetchHistory.calls.length, 1);
    assert.equal(fetchBenchmark.calls.length, 1);
    assertAllFinite(result.metrics);
  });

  it('二次调用命中缓存：不再发起任何请求，指标与首次完全一致', async () => {
    const { cache, benchmarkCache } = setup();
    const fetchHistory = makeFetchHistory(navRows);
    const fetchBenchmark = makeFetchBenchmark(benchmarkPayload);
    const basic = { code: '110022', name: '易方达消费行业股票' };

    const first = await loadFundMetrics('110022', { fetchHistory, fetchBenchmark, cache, benchmarkCache, basic });
    const second = await loadFundMetrics('110022', { fetchHistory, fetchBenchmark, cache, benchmarkCache });

    assert.equal(fetchHistory.calls.length, 1);
    assert.equal(fetchBenchmark.calls.length, 1);
    assert.equal(second.sources.nav, 'cache');
    assert.equal(second.sources.benchmark, 'cache');
    // 回归护栏：网络取数（内存里是 1400 行）与缓存命中（落盘 1285 行）必须算出同一组指标
    assert.deepEqual(second.metrics, first.metrics);
  });

  it('债券型基金不配基准：仅信息比率 / Alpha / Beta 为 null', async () => {
    const { cache, benchmarkCache } = setup();
    const fetchBenchmark = makeFetchBenchmark(benchmarkPayload);

    const result = await loadFundMetrics('000001', {
      fetchHistory: makeFetchHistory(navRows),
      fetchBenchmark,
      cache,
      benchmarkCache,
      basic: { code: '000001', name: '某某纯债债券A' }
    });

    assert.equal(result.benchmark, null);
    assert.equal(result.sources.benchmark, 'none');
    assert.equal(fetchBenchmark.calls.length, 0);
    assert.equal(result.metrics.beta, null);
    assert.equal(result.metrics.alpha, null);
    assert.equal(result.metrics.informationRatio, null);
    assert.ok(Number.isFinite(result.metrics.cagr));
    assert.ok(Number.isFinite(result.metrics.maxDrawdown));
  });

  it('基准取数失败：基金侧指标照常，只记 benchmarkError', async () => {
    const { cache, benchmarkCache } = setup();
    const result = await loadFundMetrics('110022', {
      fetchHistory: makeFetchHistory(navRows),
      fetchBenchmark: makeFetchBenchmark(null, { fail: true }),
      cache,
      benchmarkCache,
      basic: { code: '110022', name: '易方达消费行业股票' }
    });

    assert.equal(result.benchmark, null);
    assert.equal(result.benchmarkError, '基准源不可达');
    assert.equal(result.sources.benchmark, 'none');
    assert.ok(Number.isFinite(result.metrics.cagr));
    assert.equal(result.metrics.beta, null);
  });

  it('未提供基准取数函数 → 明确的 benchmarkError，而不是静默缺失', async () => {
    const { cache, benchmarkCache } = setup();
    const result = await loadFundMetrics('110022', {
      fetchHistory: makeFetchHistory(navRows),
      cache,
      benchmarkCache,
      basic: { code: '110022', name: '易方达消费行业股票' }
    });
    assert.equal(result.benchmark, null);
    assert.match(result.benchmarkError, /未提供基准指数取数函数/);
  });

  it('基准取数成功但为空 → 退回本地旧基准并提示', async () => {
    const { cache, benchmarkCache } = setup();
    const basic = { code: '110022', name: '易方达消费行业股票' };

    // 第一次拿到并落盘基准
    await loadFundMetrics('110022', {
      fetchHistory: makeFetchHistory(navRows),
      fetchBenchmark: makeFetchBenchmark(benchmarkPayload),
      cache,
      benchmarkCache,
      basic
    });

    // 第二次强制刷新：净值取回，但基准上游静默返回空
    const result = await loadFundMetrics('110022', {
      fetchHistory: makeFetchHistory(navRows),
      fetchBenchmark: makeFetchBenchmark({ secid: '1.000300', name: '沪深300', rows: [] }),
      cache,
      benchmarkCache,
      basic,
      forceRefresh: true
    });

    assert.ok(result.benchmark, '应退回本地旧基准');
    assert.equal(result.sources.benchmark, 'cache');
    assert.match(result.benchmarkError, /未取到新基准数据/);
    assert.ok(Number.isFinite(result.metrics.beta));
  });

  it('净值取数失败但本地有历史 → 用缓存出结果并带 error', async () => {
    const { cache, benchmarkCache } = setup();
    await loadFundMetrics('110022', {
      fetchHistory: makeFetchHistory(navRows),
      fetchBenchmark: makeFetchBenchmark(benchmarkPayload),
      cache,
      benchmarkCache
    });

    const result = await loadFundMetrics('110022', {
      fetchHistory: makeFetchHistory(null, { fail: true }),
      fetchBenchmark: makeFetchBenchmark(benchmarkPayload),
      cache,
      benchmarkCache,
      forceRefresh: true
    });

    assert.equal(result.error, '净值源不可达');
    assert.equal(result.sources.nav, 'cache');
    assert.ok(Number.isFinite(result.metrics.cagr));
  });

  it('净值取数失败且无缓存 → 数据不足（不抛出）', async () => {
    const { cache, benchmarkCache } = setup();
    const result = await loadFundMetrics('110022', {
      fetchHistory: makeFetchHistory(null, { fail: true }),
      fetchBenchmark: makeFetchBenchmark(benchmarkPayload),
      cache,
      benchmarkCache,
      forceRefresh: true
    });
    assert.equal(result.error, '净值源不可达');
    assert.equal(result.metrics.insufficient, true);
    assert.equal(result.benchmark, null);
    assert.equal(result.sources.nav, 'none');
  });

  it('未提供净值取数函数 / 空代码 → 明确原因', async () => {
    const missing = await loadFundMetrics('110022', { cache: setup().cache });
    assert.match(missing.error, /未提供历史净值取数函数/);

    const blank = await loadFundMetrics('  ', { fetchHistory: makeFetchHistory(navRows) });
    assert.match(blank.error, /缺少基金代码/);
  });

  it('支持取数函数返回 { rows } 包装结构', async () => {
    const { cache, benchmarkCache } = setup();
    const result = await loadFundMetrics('110022', {
      fetchHistory: async () => ({ rows: navRows }),
      fetchBenchmark: async () => benchmarkPayload,
      cache,
      benchmarkCache
    });
    assert.equal(result.metrics.insufficient, false);
    assert.equal(result.sources.nav, 'network');
  });

  it('基准缓存按 secid 跨基金共享（第二只基金不重复取基准）', async () => {
    const { cache, benchmarkCache } = setup();
    const fetchBenchmark = makeFetchBenchmark(benchmarkPayload);

    await loadFundMetrics('110022', {
      fetchHistory: makeFetchHistory(navRows),
      fetchBenchmark,
      cache,
      benchmarkCache,
      basic: { code: '110022', name: '易方达消费行业股票' }
    });
    await loadFundMetrics('161725', {
      fetchHistory: makeFetchHistory(navRows),
      fetchBenchmark,
      cache,
      benchmarkCache,
      basic: { code: '161725', name: '招商中证白酒指数' }
    });

    assert.equal(fetchBenchmark.calls.length, 1, '同一 secid 只应取一次');
  });
});
