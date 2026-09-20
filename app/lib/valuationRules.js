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
 */
const VALUATION_RULES = {
  // ========== 宽基指数 ==========
  [FUND_CATEGORIES.BROAD_INDEX]: {
    name: '宽基指数',
    indicators: [
      { key: 'pePercentile', weight: 0.25 },
      { key: 'pbPercentile', weight: 0.15 },
      { key: 'dividendYieldPercentile', weight: 0.15 },
      { key: 'pe', weight: 0.25, usePercentile: true },
      { key: 'roe', weight: 0.1 },
      { key: 'epsGrowth', weight: 0.1 }
    ]
  },

  // ========== 红利/高股息 ==========
  [FUND_CATEGORIES.DIVIDEND]: {
    name: '红利/高股息',
    indicators: [
      { key: 'dividendYieldPercentile', weight: 0.3 },
      { key: 'dividendYield', weight: 0.2, usePercentile: true },
      { key: 'pbPercentile', weight: 0.2 },
      { key: 'pePercentile', weight: 0.15 },
      { key: 'roe', weight: 0.1 },
      { key: 'dividendPayoutRatio', weight: 0.05 }
    ]
  },

  // ========== 成长型 ==========
  [FUND_CATEGORIES.GROWTH]: {
    name: '成长型',
    indicators: [
      { key: 'peg', weight: 0.25 },
      { key: 'pePercentile', weight: 0.15 },
      { key: 'epsGrowth', weight: 0.2 },
      { key: 'revenueGrowth', weight: 0.1 },
      { key: 'roe', weight: 0.15 },
      { key: 'earningsRevision', weight: 0.15 }
    ],
    pegThresholds: DEFAULT_PEG_THRESHOLDS
  },

  // ========== 科技/AI ==========
  // 注：PE/PB 历史分位是港股科技基金唯一可得的指标（港股无 PEG、且市销率历史不可得），
  // 若 TECH 规则只保留 psPercentile/peg/营收增速等，港股科技基金将无法出分。
  // 因此纳入 pePercentile / pbPercentile，并从本就没有数据源的指标上等量下调权重。
  [FUND_CATEGORIES.TECH]: {
    name: '科技/AI',
    indicators: [
      { key: 'psPercentile', weight: 0.2 },
      { key: 'pePercentile', weight: 0.15 },
      { key: 'pbPercentile', weight: 0.1 },
      { key: 'peg', weight: 0.15 },
      { key: 'revenueGrowth', weight: 0.1 },
      { key: 'grossMargin', weight: 0.05 },
      { key: 'fcfMargin', weight: 0.05 },
      { key: 'roic', weight: 0.05 },
      { key: 'evSales', weight: 0.15 }
    ],
    pegThresholds: { low: 1.0, fair: 1.5, slightlyHigh: 2.0, high: 3.0 }
  },

  // ========== 医药 ==========
  [FUND_CATEGORIES.PHARMA]: {
    name: '医药',
    indicators: [
      { key: 'pePercentile', weight: 0.2 },
      { key: 'psPercentile', weight: 0.15 },
      { key: 'peg', weight: 0.2 },
      { key: 'roe', weight: 0.1 },
      { key: 'epsGrowth', weight: 0.15 },
      { key: 'revenueGrowth', weight: 0.1 },
      { key: 'fcf', weight: 0.1 }
    ],
    pegThresholds: { low: 0.8, fair: 1.2, slightlyHigh: 1.8, high: 2.5 }
  },

  // ========== 消费 ==========
  [FUND_CATEGORIES.CONSUMER]: {
    name: '消费',
    indicators: [
      { key: 'pePercentile', weight: 0.3 },
      { key: 'peg', weight: 0.2 },
      { key: 'pbPercentile', weight: 0.1 },
      { key: 'roe', weight: 0.15 },
      { key: 'epsGrowth', weight: 0.15 },
      { key: 'fcf', weight: 0.1 }
    ],
    pegThresholds: { low: 0.8, fair: 1.2, slightlyHigh: 1.8, high: 2.5 }
  },

  // ========== 金融 ==========
  [FUND_CATEGORIES.FINANCE]: {
    name: '金融',
    indicators: [
      { key: 'pbPercentile', weight: 0.3 },
      { key: 'roe', weight: 0.25 },
      { key: 'dividendYield', weight: 0.2, usePercentile: true },
      { key: 'pePercentile', weight: 0.1 },
      { key: 'nplRatio', weight: 0.1 },
      { key: 'capitalAdequacy', weight: 0.05 }
    ]
  },

  // ========== 周期 ==========
  [FUND_CATEGORIES.CYCLICAL]: {
    name: '周期',
    indicators: [
      { key: 'pbPercentile', weight: 0.2 },
      { key: 'evEbitda', weight: 0.2 },
      { key: 'pePercentile', weight: 0.15 },
      { key: 'epsGrowth', weight: 0.15 },
      { key: 'roe', weight: 0.1 },
      { key: 'psPercentile', weight: 0.2 }
    ],
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
      { key: 'pbPercentile', weight: 0.3 },
      { key: 'pePercentile', weight: 0.15 },
      { key: 'dividendYield', weight: 0.15, usePercentile: true },
      { key: 'evEbitda', weight: 0.2 },
      { key: 'roe', weight: 0.1 },
      { key: 'psPercentile', weight: 0.1 }
    ]
  },

  // ========== REITs ==========
  [FUND_CATEGORIES.REITS]: {
    name: 'REITs',
    indicators: [
      { key: 'dividendYield', weight: 0.35, usePercentile: true },
      { key: 'dividendYieldPercentile', weight: 0.25 },
      { key: 'pbPercentile', weight: 0.2 },
      { key: 'pePercentile', weight: 0.2 }
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

  // ========== 债券 ==========
  [FUND_CATEGORIES.BOND]: {
    name: '债券',
    indicators: [
      { key: 'dividendYield', weight: 0.5, usePercentile: true },
      { key: 'dividendYieldPercentile', weight: 0.5 }
    ],
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
 * 获取指标定义
 * @param {string} key
 * @returns {object|undefined}
 */
export function getIndicatorDef(key) {
  return INDICATOR_DEFS[key];
}

export { VALUATION_RULES, INDICATOR_DEFS, DEFAULT_PEG_THRESHOLDS };
export const __test__ = { INDICATOR_DEFS, VALUATION_RULES };
