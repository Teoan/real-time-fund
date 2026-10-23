/**
 * 基金估值规则配置
 *
 * 每种基金类型定义：
 *   - 核心估值指标列表（key + 权重）
 *   - 是否使用历史分位
 *   - 特殊阈值（如 PEG 阈值）
 *
 * 指标来源：
 *   - 持仓穿透估值：pe, pb, ps, peg, epsGrowth, dividendYield
 *   - 历史分位计算：pePercentile, pbPercentile, psPercentile, dividendYieldPercentile
 *   - 待扩展：roe, revenueGrowth, fcf, grossMargin, evSales, evEbitda 等
 */

import { FUND_CATEGORIES } from './fundClassifier.js';

/**
 * 估值指标权重配置
 *
 * 每个指标定义：
 *   key: 指标标识（对应 metrics 对象的属性名）
 *   weight: 权重（0-1）
 *   usePercentile: 是否将原始值转换为历史分位后再评分
 *   lowerIsBetter: 值越低表示越便宜（PE/PB/PS），反之（股息率）越高越便宜
 *   label: 指标中文名（UI 展示用）
 */
const INDICATOR_DEFS = {
  pe: { label: 'PE-TTM', lowerIsBetter: true },
  pb: { label: 'PB', lowerIsBetter: true },
  ps: { label: 'PS', lowerIsBetter: true },
  peg: { label: 'PEG', lowerIsBetter: true },
  pePercentile: { label: 'PE历史分位', lowerIsBetter: true },
  pbPercentile: { label: 'PB历史分位', lowerIsBetter: true },
  psPercentile: { label: 'PS历史分位', lowerIsBetter: true },
  dividendYield: { label: '股息率', lowerIsBetter: false },
  dividendYieldPercentile: { label: '股息率历史分位', lowerIsBetter: false },
  epsGrowth: { label: '盈利增速', lowerIsBetter: false },
  roe: { label: 'ROE', lowerIsBetter: false },
  revenueGrowth: { label: '营收增速', lowerIsBetter: false },
  fcf: { label: '自由现金流', lowerIsBetter: false },
  grossMargin: { label: '毛利率', lowerIsBetter: false },
  fcfMargin: { label: 'FCF利润率', lowerIsBetter: false },
  roic: { label: 'ROIC', lowerIsBetter: false },
  evSales: { label: 'EV/Sales', lowerIsBetter: true },
  evEbitda: { label: 'EV/EBITDA', lowerIsBetter: true },
  dividendPayoutRatio: { label: '股息支付率', lowerIsBetter: null },
  nplRatio: { label: '不良率', lowerIsBetter: true },
  capitalAdequacy: { label: '资本充足率', lowerIsBetter: false },
  earningsRevision: { label: '盈利预期修正', lowerIsBetter: false }
};

/**
 * PEG 评分阈值
 */
const DEFAULT_PEG_THRESHOLDS = { low: 0.8, fair: 1.2, slightlyHigh: 1.8, high: 2.5 };

/**
 * 各类型估值规则
 *
 * 三条约定（2026-03 审计修复，勿回退）：
 *
 * 1. **一个指标只出现一次**。`{ key: 'pe', usePercentile: true }` 与独立的
 *    `{ key: 'pePercentile' }` 指向同一份数据（引擎的 usePercentile 分支读的就是
 *    `${key}Percentile`），同时写入会让同一信息被计两次权重——宽基曾因此把 PE 分位
 *    算成 50%。要表达「分位优先、绝对值兜底」，用 `usePercentile + absolute`。
 *
 * 2. **只允许列出有数据源的指标**。当前 `fund.js` 实际产出的指标只有
 *    pe/pb/ps/peg/epsGrowth/revenueGrowth/dividendYield/roe/dividendPayoutRatio
 *    （payout 由 dividendYield × pe 派生）+ 分位型 pePercentile/pbPercentile/psPercentile。
 *    其余指标（earningsRevision、fcf、grossMargin、fcfMargin、roic、evSales、
 *    evEbitda、nplRatio、capitalAdequacy、dividendYieldPercentile）没有任何数据源，
 *    列在 indicators 里只会永久拉低碳信度的理论上限（债券曾只有 50%）。
 *    这些指标改放 `pendingIndicators`，补到数据源后再挪回 indicators 并重新归一。
 *
 * 3. **`indicators` 权重之和必须为 1**。这样「指标覆盖率 100%」才等于「数据齐全」，
 *    置信度才只是数据质量的函数，而不是分类的函数。
 */
const VALUATION_RULES = {
  // ========== 宽基指数 ==========
  // 原规则：pePercentile 0.25 + pe(usePercentile) 0.25 → PE 分位被双计成 50%，
  // 且 dividendYieldPercentile 0.15 无数据源。合并为单列 pe 0.35（分位驱动，
  // 缺分位时不参与评分，不用绝对值兜底），无源的股息率分位换成有源的股息率绝对值。
  [FUND_CATEGORIES.BROAD_INDEX]: {
    name: '宽基指数',
    indicators: [
      { key: 'pe', weight: 0.35, usePercentile: true },
      { key: 'pbPercentile', weight: 0.2 },
      { key: 'dividendYield', weight: 0.15 },
      { key: 'roe', weight: 0.15 },
      { key: 'epsGrowth', weight: 0.15 }
    ],
    pendingIndicators: [{ key: 'dividendYieldPercentile', weight: 0.15, reason: '股息率历史序列无数据源' }]
  },

  // ========== 红利/高股息 ==========
  // 原规则：dividendYieldPercentile 0.3（无数据源）+ dividendYield 0.2(usePercentile)
  // 同一份股息率数据两次计权。合并为单列 dividendYield 0.5，分位优先、绝对值兜底。
  [FUND_CATEGORIES.DIVIDEND]: {
    name: '红利/高股息',
    indicators: [
      { key: 'dividendYield', weight: 0.5, usePercentile: true, absolute: true },
      { key: 'pbPercentile', weight: 0.2 },
      { key: 'pePercentile', weight: 0.15 },
      { key: 'roe', weight: 0.1 },
      { key: 'dividendPayoutRatio', weight: 0.05 }
    ]
  },

  // ========== 成长型 ==========
  // earningsRevision（盈利预期修正）无数据源 → pending，其余按原比例归一。
  [FUND_CATEGORIES.GROWTH]: {
    name: '成长型',
    indicators: [
      { key: 'peg', weight: 0.29 },
      { key: 'pePercentile', weight: 0.18 },
      { key: 'epsGrowth', weight: 0.24 },
      { key: 'revenueGrowth', weight: 0.12 },
      { key: 'roe', weight: 0.17 }
    ],
    pendingIndicators: [{ key: 'earningsRevision', weight: 0.15, reason: '卖方预期修正数据无源' }],
    pegThresholds: DEFAULT_PEG_THRESHOLDS
  },

  // ========== 科技/AI ==========
  // 注：PE/PB 历史分位是港股科技基金唯一可得的指标（港股无 PEG、且市销率历史不可得），
  // 若 TECH 规则只保留 psPercentile/peg/营收增速等，港股科技基金将无法出分。
  // 因此纳入 pePercentile / pbPercentile，并从本就没有数据源的指标上等量下调权重
  // （grossMargin/fcfMargin/roic/evSales 已移入 pendingIndicators）。
  [FUND_CATEGORIES.TECH]: {
    name: '科技/AI',
    indicators: [
      { key: 'psPercentile', weight: 0.29 },
      { key: 'pePercentile', weight: 0.21 },
      { key: 'pbPercentile', weight: 0.14 },
      { key: 'peg', weight: 0.22 },
      { key: 'revenueGrowth', weight: 0.14 }
    ],
    pendingIndicators: [
      { key: 'grossMargin', weight: 0.05, reason: '跨行业不可比，无稳定数据源' },
      { key: 'fcfMargin', weight: 0.05, reason: '无数据源' },
      { key: 'roic', weight: 0.05, reason: '无数据源' },
      { key: 'evSales', weight: 0.15, reason: 'EV 无数据源' }
    ],
    pegThresholds: { low: 1.0, fair: 1.5, slightlyHigh: 2.0, high: 3.0 }
  },

  // ========== 医药 ==========
  [FUND_CATEGORIES.PHARMA]: {
    name: '医药',
    indicators: [
      { key: 'pePercentile', weight: 0.22 },
      { key: 'psPercentile', weight: 0.17 },
      { key: 'peg', weight: 0.22 },
      { key: 'roe', weight: 0.11 },
      { key: 'epsGrowth', weight: 0.17 },
      { key: 'revenueGrowth', weight: 0.11 }
    ],
    pendingIndicators: [{ key: 'fcf', weight: 0.1, reason: '自由现金流无数据源' }],
    pegThresholds: { low: 0.8, fair: 1.2, slightlyHigh: 1.8, high: 2.5 }
  },

  // ========== 消费 ==========
  [FUND_CATEGORIES.CONSUMER]: {
    name: '消费',
    indicators: [
      { key: 'pePercentile', weight: 0.33 },
      { key: 'peg', weight: 0.22 },
      { key: 'pbPercentile', weight: 0.11 },
      { key: 'roe', weight: 0.17 },
      { key: 'epsGrowth', weight: 0.17 }
    ],
    pendingIndicators: [{ key: 'fcf', weight: 0.1, reason: '自由现金流无数据源' }],
    pegThresholds: { low: 0.8, fair: 1.2, slightlyHigh: 1.8, high: 2.5 }
  },

  // ========== 金融 ==========
  [FUND_CATEGORIES.FINANCE]: {
    name: '金融',
    indicators: [
      { key: 'pbPercentile', weight: 0.35 },
      { key: 'roe', weight: 0.3 },
      { key: 'dividendYield', weight: 0.23, usePercentile: true, absolute: true },
      { key: 'pePercentile', weight: 0.12 }
    ],
    pendingIndicators: [
      { key: 'nplRatio', weight: 0.1, reason: '不良率需银行财报明细，无数据源' },
      { key: 'capitalAdequacy', weight: 0.05, reason: '资本充足率无数据源' }
    ]
  },

  // ========== 周期 ==========
  [FUND_CATEGORIES.CYCLICAL]: {
    name: '周期',
    indicators: [
      { key: 'pbPercentile', weight: 0.25 },
      { key: 'psPercentile', weight: 0.25 },
      { key: 'pePercentile', weight: 0.2 },
      { key: 'epsGrowth', weight: 0.2 },
      { key: 'roe', weight: 0.1 }
    ],
    pendingIndicators: [{ key: 'evEbitda', weight: 0.2, reason: 'EV/EBITDA 无数据源' }],
    note: '周期股 PE 低可能是景气高峰，需结合 PB 和盈利中枢判断'
  },

  // ========== 新能源 ==========
  [FUND_CATEGORIES.NEW_ENERGY]: {
    name: '新能源',
    indicators: [
      { key: 'peg', weight: 0.25 },
      { key: 'pePercentile', weight: 0.15 },
      { key: 'psPercentile', weight: 0.15 },
      { key: 'epsGrowth', weight: 0.2 },
      { key: 'roe', weight: 0.1 },
      { key: 'revenueGrowth', weight: 0.15 }
    ],
    pegThresholds: { low: 0.8, fair: 1.2, slightlyHigh: 1.8, high: 2.5 }
  },

  // ========== 军工 ==========
  [FUND_CATEGORIES.MILITARY]: {
    name: '军工',
    indicators: [
      { key: 'pePercentile', weight: 0.25 },
      { key: 'pbPercentile', weight: 0.15 },
      { key: 'peg', weight: 0.2 },
      { key: 'epsGrowth', weight: 0.2 },
      { key: 'roe', weight: 0.1 },
      { key: 'psPercentile', weight: 0.1 }
    ],
    pegThresholds: { low: 0.8, fair: 1.2, slightlyHigh: 1.8, high: 2.5 }
  },

  // ========== 地产 ==========
  [FUND_CATEGORIES.REAL_ESTATE]: {
    name: '地产',
    indicators: [
      { key: 'pbPercentile', weight: 0.38 },
      { key: 'pePercentile', weight: 0.19 },
      { key: 'dividendYield', weight: 0.19, usePercentile: true, absolute: true },
      { key: 'roe', weight: 0.12 },
      { key: 'psPercentile', weight: 0.12 }
    ],
    pendingIndicators: [{ key: 'evEbitda', weight: 0.2, reason: 'EV/EBITDA 无数据源' }]
  },

  // ========== REITs ==========
  // 原规则 dividendYield 0.35(usePercentile) 与 dividendYieldPercentile 0.25 双计 → 合并为 0.47。
  [FUND_CATEGORIES.REITS]: {
    name: 'REITs',
    indicators: [
      { key: 'dividendYield', weight: 0.47, usePercentile: true, absolute: true },
      { key: 'pbPercentile', weight: 0.27 },
      { key: 'pePercentile', weight: 0.26 }
    ]
  },

  // ========== 行业指数 ==========
  [FUND_CATEGORIES.SECTOR_INDEX]: {
    name: '行业指数',
    indicators: [
      { key: 'pePercentile', weight: 0.3 },
      { key: 'pbPercentile', weight: 0.2 },
      { key: 'psPercentile', weight: 0.15 },
      { key: 'peg', weight: 0.15 },
      { key: 'epsGrowth', weight: 0.1 },
      { key: 'roe', weight: 0.1 }
    ],
    pegThresholds: DEFAULT_PEG_THRESHOLDS
  },

  // ========== QDII ==========
  [FUND_CATEGORIES.QDII]: {
    name: 'QDII',
    indicators: [
      { key: 'pePercentile', weight: 0.3 },
      { key: 'pbPercentile', weight: 0.2 },
      { key: 'peg', weight: 0.2 },
      { key: 'epsGrowth', weight: 0.15 },
      { key: 'roe', weight: 0.15 }
    ],
    pegThresholds: DEFAULT_PEG_THRESHOLDS
  },

  // ========== 美股 ==========
  // 美股无可用估值历史源（AKTools stock_us_valuation_baidu / stock_us_spot_em / stock_us_hist
  // 实测均 500），无法计算 PE/PB/PS 历史分位，因此 PE/PB/PS 标记 absolute: true，
  // 在分位缺失时回退到绝对阈值评分；若将来出现可用历史源，分位会自动优先生效。
  //
  // 指标来源：
  //   pe / pb / ps            ← 东财 push2（105./106. secid）
  //   epsGrowth               ← AKTools stock_financial_us_analysis_indicator_em（归母净利润同比）
  //   revenueGrowth           ← 同上（营业收入同比）
  //   roe                     ← 同上（ROE_AVG）
  // 未纳入：
  //   peg        —— 无美股 PEG 数据源
  //   grossMargin—— 跨行业不可比（实测 SMCI 10.8% vs META 82.0%）
  //   dividendYield —— 美股低股息会被阈值判为"贵"，与成长型口径冲突
  // ROE 仅给 0.10：美股回购导致 ROE 系统性虚高（实测 AAPL 171% / NVDA 101%），
  // 通用阈值会把 ≥25% 一律判为便宜，需限制其影响。
  [FUND_CATEGORIES.US_STOCK]: {
    name: '美股',
    indicators: [
      { key: 'pe', weight: 0.25, usePercentile: true, absolute: true },
      { key: 'pb', weight: 0.15, usePercentile: true, absolute: true },
      { key: 'ps', weight: 0.15, usePercentile: true, absolute: true },
      { key: 'epsGrowth', weight: 0.2 },
      { key: 'revenueGrowth', weight: 0.15 },
      { key: 'roe', weight: 0.1 }
    ],
    note: '美股无历史分位源，PE/PB/PS 采用绝对阈值；ROE 已降权以抵消回购导致的虚高'
  },

  // ========== 债券 ==========
  // 债券基金本就没有 PE/PB，股息率（份额分红率）是唯一可用信号：单列 100%，
  // 缺分位时回退到绝对值阈值——原规则把 50% 押在无源的 dividendYieldPercentile 上。
  [FUND_CATEGORIES.BOND]: {
    name: '债券',
    indicators: [{ key: 'dividendYield', weight: 1, usePercentile: true, absolute: true }],
    note: '债券基金主要看到期收益率/分红率，不适用 PE/PB 估值'
  },

  // ========== 其他/默认 ==========
  [FUND_CATEGORIES.OTHER]: {
    name: '其他',
    indicators: [
      { key: 'pePercentile', weight: 0.35 },
      { key: 'pbPercentile', weight: 0.25 },
      { key: 'peg', weight: 0.2 },
      { key: 'roe', weight: 0.2 }
    ],
    pegThresholds: DEFAULT_PEG_THRESHOLDS
  }
};

/**
 * 获取指定分类的估值规则
 * @param {string} category - FUND_CATEGORIES 枚举值
 * @returns {object} 估值规则
 */
export function getValuationRule(category) {
  return VALUATION_RULES[category] || VALUATION_RULES[FUND_CATEGORIES.OTHER];
}

/**
 * 获取指定分类「已声明但暂无数据源」的指标
 *
 * 这些指标不参与评分、不计入置信度分母，只作为待补清单存在。
 *
 * @param {string} category
 * @returns {Array<{key: string, weight: number, reason: string}>}
 */
export function getPendingIndicators(category) {
  const rule = getValuationRule(category);
  return Array.isArray(rule.pendingIndicators) ? rule.pendingIndicators : [];
}

/**
 * 校验规则表的三条约定（一个指标只出现一次 / 权重和为 1 / 不出现无源指标）。
 * 供单测与开发期自检使用。
 *
 * @returns {Array<string>} 问题描述列表，空数组表示全部通过
 */
export function validateValuationRules() {
  const problems = [];
  const LIVE_METRICS = new Set([
    'pe',
    'pb',
    'ps',
    'peg',
    'epsGrowth',
    'revenueGrowth',
    'dividendYield',
    'roe',
    'dividendPayoutRatio',
    'pePercentile',
    'pbPercentile',
    'psPercentile'
  ]);
  for (const [category, rule] of Object.entries(VALUATION_RULES)) {
    const indicators = Array.isArray(rule.indicators) ? rule.indicators : [];
    const seen = new Set();
    let total = 0;
    for (const item of indicators) {
      if (seen.has(item.key)) problems.push(`${category}: 指标 ${item.key} 重复出现`);
      seen.add(item.key);
      if (!LIVE_METRICS.has(item.key))
        problems.push(`${category}: 指标 ${item.key} 无数据源，应移入 pendingIndicators`);
      if (!Number.isFinite(item.weight) || item.weight <= 0) problems.push(`${category}: 指标 ${item.key} 权重非法`);
      total += Number(item.weight) || 0;
    }
    if (Math.abs(total - 1) > 0.001) problems.push(`${category}: 权重之和 ${total} ≠ 1`);
  }
  return problems;
}

/**
 * 获取指标定义
 * @param {string} key
 * @returns {object|undefined}
 */
export function getIndicatorDef(key) {
  return INDICATOR_DEFS[key];
}

export { VALUATION_RULES, INDICATOR_DEFS, DEFAULT_PEG_THRESHOLDS };
export const __test__ = { INDICATOR_DEFS, VALUATION_RULES, validateValuationRules };
