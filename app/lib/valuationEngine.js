/**
 * 估值评分引擎
 *
 * 核心算法：
 *   1. 根据基金分类获取对应的估值规则
 *   2. 遍历规则中的指标，将每个指标的原始值转换为 0-100 分
 *   3. 按权重加权平均，得到最终评分
 *   4. 映射到 7 级评级标签
 *
 * 评分方向统一为：分数越高 = 越贵（高估）
 *   - PE/PB/PS 等"越低越便宜"的指标：分位数直接映射（低分位 = 低分 = 便宜）
 *   - 股息率等"越高越便宜"的指标：反向映射（高分位 = 低分 = 便宜）
 *   - PEG：通过阈值映射
 */

import { getValuationRule, getIndicatorDef } from './valuationRules.js';

/**
 * 评级标签
 */
const RATINGS = [
  { max: 15, label: '极度低估', color: 'emerald-600' },
  { max: 30, label: '低估', color: 'emerald-500' },
  { max: 45, label: '偏低', color: 'green-400' },
  { max: 60, label: '合理', color: 'gray-400' },
  { max: 75, label: '偏高', color: 'orange-400' },
  { max: 90, label: '高估', color: 'red-400' },
  { max: 100, label: '极度高估', color: 'red-600' }
];

/**
 * 将评分映射到评级标签
 * @param {number} score - 0-100
 * @returns {{ label: string, color: string }}
 */
export function scoreToRating(score) {
  if (score == null || !Number.isFinite(score)) {
    return { label: '数据不足', color: 'gray-300' };
  }
  for (const rating of RATINGS) {
    if (score < rating.max) return { label: rating.label, color: rating.color };
  }
  return { label: '极度高估', color: 'red-600' };
}

/**
 * PEG 评分
 * PEG < 0.8 → 低估（低分）
 * PEG 0.8-1.2 → 合理
 * PEG 1.2-1.8 → 偏高
 * PEG 1.8-2.5 → 高估
 * PEG > 2.5 → 极高估
 *
 * @param {number} peg
 * @param {object} thresholds
 * @returns {number} 0-100 分
 */
export function pegToScore(peg, thresholds) {
  const t = thresholds || { low: 0.8, fair: 1.2, slightlyHigh: 1.8, high: 2.5 };
  if (!Number.isFinite(peg) || peg <= 0) return 50; // 负增长/无数据，中性
  if (peg < t.low) return 15;
  if (peg < t.fair) return 35;
  if (peg < t.slightlyHigh) return 55;
  if (peg < t.high) return 75;
  return 92;
}

/**
 * 股息率评分（原始值阈值映射，分位数据缺失时的回退口径）
 * 股息率越高 = 越便宜 = 分越低；数值单位为 %
 *
 * @param {number} yieldPct - 股息率（%）
 * @returns {number|null} 0-100 分
 */
export function dividendYieldToScore(yieldPct) {
  if (!Number.isFinite(yieldPct)) return null;
  if (yieldPct >= 5) return 10;
  if (yieldPct >= 4) return 20;
  if (yieldPct >= 3) return 35;
  if (yieldPct >= 2) return 50;
  if (yieldPct >= 1) return 65;
  if (yieldPct > 0) return 80;
  return 90; // 不分红，对股息策略而言接近"最贵"
}

/**
 * 盈利增速评分（原始值阈值映射，分位数据缺失时的回退口径）
 * 增速越高 = 增长越能消化估值 = 分越低；数值单位为 %
 *
 * @param {number} growthPct - 净利润同比（%）
 * @returns {number|null} 0-100 分
 */
export function epsGrowthToScore(growthPct) {
  if (!Number.isFinite(growthPct)) return null;
  if (growthPct >= 30) return 15;
  if (growthPct >= 15) return 30;
  if (growthPct >= 5) return 45;
  if (growthPct >= 0) return 55;
  if (growthPct >= -15) return 70;
  return 85;
}

/**
 * 营收增速评分（原始值阈值映射）
 * 营收增速越高 = 成长性越强 = 相对越"便宜"（分越低）；数值单位为 %
 *
 * 用于美股规则：美股无可用估值历史，成长性指标（AKTools 美股财务指标）承担主要区分度。
 *
 * @param {number} growthPct - 营业收入同比（%）
 * @returns {number|null} 0-100 分
 */
export function revenueGrowthToScore(growthPct) {
  if (!Number.isFinite(growthPct)) return null;
  if (growthPct >= 30) return 15;
  if (growthPct >= 15) return 30;
  if (growthPct >= 8) return 45;
  if (growthPct >= 0) return 58;
  if (growthPct >= -10) return 72;
  return 85;
}

/**
 * PE-TTM 绝对阈值评分（分位数据缺失时的回退口径）
 * PE 越低 = 越便宜 = 分越低；数值单位为倍。
 *
 * 仅在规则项显式声明 `absolute: true` 时启用（如美股规则）——
 * A 股/港股宽基等规则依赖历史分位，不应被绝对阈值改写。
 *
 * @param {number} pe
 * @returns {number|null} 0-100 分
 */
export function peToScore(pe) {
  if (!Number.isFinite(pe) || pe <= 0) return null; // 亏损（PE 为负/0）无法用 PE 衡量
  if (pe < 8) return 10;
  if (pe < 12) return 25;
  if (pe < 18) return 40;
  if (pe < 25) return 55;
  if (pe < 35) return 70;
  if (pe < 50) return 85;
  return 95;
}

/**
 * PB 绝对阈值评分（分位数据缺失时的回退口径）
 * PB 越低 = 越便宜 = 分越低；数值单位为倍。
 *
 * @param {number} pb
 * @returns {number|null} 0-100 分
 */
export function pbToScore(pb) {
  if (!Number.isFinite(pb) || pb <= 0) return null;
  if (pb < 1) return 10;
  if (pb < 2) return 25;
  if (pb < 3) return 40;
  if (pb < 5) return 55;
  if (pb < 8) return 70;
  if (pb < 12) return 85;
  return 95;
}

/**
 * PS 绝对阈值评分（分位数据缺失时的回退口径）
 * PS 越低 = 越便宜 = 分越低；数值单位为倍。
 *
 * @param {number} ps
 * @returns {number|null} 0-100 分
 */
export function psToScore(ps) {
  if (!Number.isFinite(ps) || ps <= 0) return null;
  if (ps < 1) return 10;
  if (ps < 2) return 25;
  if (ps < 4) return 40;
  if (ps < 7) return 55;
  if (ps < 12) return 70;
  if (ps < 20) return 85;
  return 95;
}

/**
 * 股息支付率评分（原始值阈值映射）
 *
 * 支付率与"贵不贵"不是单调关系：分红太少（留存逻辑不明）与分红过多（不可持续、
 * 或股价已跌到股息率高企）都偏贵，40%~70% 最健康。
 * 数值单位为 %（0-100 以上，>100% 表示分红超过当年利润）。
 *
 * @param {number} payoutPct - 股息支付率（%）
 * @returns {number|null} 0-100 分
 */
export function dividendPayoutRatioToScore(payoutPct) {
  if (!Number.isFinite(payoutPct) || payoutPct < 0) return null;
  if (payoutPct < 20) return 70; // 几乎不分红，红利策略视角偏贵
  if (payoutPct < 40) return 50;
  if (payoutPct <= 70) return 30; // 健康区间
  if (payoutPct <= 100) return 45;
  return 90; // 超过当年利润，不可持续
}

/**
 * ROE 评分（原始值阈值映射，行业无关的粗略口径）
 * ROE 越高 = 盈利能力越强 = 相对越"便宜"（分越低）
 * 数值单位为 %
 *
 * 注意：ROE 行业差异较大（银行 ~10%、白酒 ~30%），这里是通用阈值；
 * 后续可改为行业基准映射或历史分位（对应 valuationRules 中的待办注释）。
 *
 * @param {number} roePct - 加权净资产收益率（%）
 * @returns {number|null} 0-100 分
 */
export function roeToScore(roePct) {
  if (!Number.isFinite(roePct)) return null;
  if (roePct >= 25) return 10;
  if (roePct >= 20) return 20;
  if (roePct >= 15) return 35;
  if (roePct >= 10) return 50;
  if (roePct >= 5) return 65;
  if (roePct >= 0) return 78;
  return 90; // 亏损，盈利质量为负
}

/**
 * 将指标原始值转换为 0-100 分（分数越高 = 越贵）
 *
 * @param {string} key - 指标 key
 * @param {number} value - 原始值
 * @param {object} [indicatorDef] - 指标定义（含 lowerIsBetter）
 * @returns {number|null}
 */
export function normalizeToScore(key, value, indicatorDef) {
  if (value == null || !Number.isFinite(value)) return null;

  // 分位数指标：需要判断方向
  // lowerIsBetter=true（PE/PB/PS）：低分位 = 便宜 = 低分 → 直接使用
  // lowerIsBetter=false（股息率）：高分位 = 便宜 = 低分 → 反转
  if (key.endsWith('Percentile')) {
    const clamped = Math.max(0, Math.min(100, value));
    // 股息率相关指标：分位越高表示越便宜，需要反转
    if (key === 'dividendYieldPercentile') {
      return 100 - clamped;
    }
    return clamped;
  }

  // 阈值映射类指标
  if (key === 'peg') {
    return pegToScore(value);
  }
  if (key === 'dividendYield') {
    return dividendYieldToScore(value);
  }
  if (key === 'epsGrowth') {
    return epsGrowthToScore(value);
  }
  if (key === 'revenueGrowth') {
    return revenueGrowthToScore(value);
  }
  if (key === 'pe') {
    return peToScore(value);
  }
  if (key === 'pb') {
    return pbToScore(value);
  }
  if (key === 'ps') {
    return psToScore(value);
  }
  if (key === 'roe') {
    return roeToScore(value);
  }
  if (key === 'dividendPayoutRatio') {
    return dividendPayoutRatioToScore(value);
  }

  // 其他指标暂时返回 null（需要历史分位才能评分）
  // 后续可扩展：fcf、grossMargin 等
  return null;
}

/**
 * 分位收缩的参照样本数（经验贝叶斯式向 50 分位收缩的强度）。
 *
 * 30 个样本算出的分位，标准误约 9 个百分点，直接把两端标成「极度低估/极度高估」
 * 噪声太大；把分位与 50 按 n:(k) 混合，n 越大越接近真实分位：
 *   n=60  → 权重 0.33，30 分位 → 43.3
 *   n=250 → 权重 0.68，30 分位 → 36.4
 *   n=1212（A 股近 5 年）→ 权重 0.91，30 分位 → 31.8
 * 即：样本越少越保守，但不会把有效样本彻底拉平。
 */
export const PERCENTILE_SHRINK_REFERENCE = 120;

/**
 * 计算一组数值的百分位
 * @param {number[]} values - 历史数值数组
 * @param {number} current - 当前值
 * @param {{ excludeNonPositive?: boolean }} [options]
 *        excludeNonPositive：剔除 <= 0 的样本。
 *        PE/PB/PS 必须开启——亏损股的负 PE 会排在分布最左端，
 *        使「亏损」被算成「极度低估」，是完全反向的信号。
 * @returns {number} 0-100 的百分位（当前值在历史中的位置）
 */
export function computePercentile(values, current, options = {}) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(current)) return null;
  const excludeNonPositive = options.excludeNonPositive === true;
  // 亏损/负净资产（PE/PB/PS <= 0）的分位没有经济含义：负值永远排在分布最左端，
  // 会被读成「极度低估」。守卫不依赖 excludeNonPositive，默认生效。
  if (current <= 0) return null;

  const valid = values.filter((v) => Number.isFinite(v) && (!excludeNonPositive || v > 0));
  if (valid.length === 0) return null;

  let below = 0;
  for (const v of valid) {
    if (v < current) below++;
  }
  return (below / valid.length) * 100;
}

/**
 * 分位收缩：把「小样本分位」向 50 拉近，样本越多越接近原始分位。
 *
 * @param {number} percentile - 0-100 原始分位
 * @param {number} sampleCount - 参照样本数
 * @param {number} [referenceSize] - 收缩强度 k
 * @returns {number|null} 0-100 收缩后的分位
 */
export function shrinkPercentile(percentile, sampleCount, referenceSize = PERCENTILE_SHRINK_REFERENCE) {
  if (!Number.isFinite(percentile)) return null;
  const n = Number(sampleCount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const k = Number.isFinite(referenceSize) && referenceSize > 0 ? referenceSize : PERCENTILE_SHRINK_REFERENCE;
  const shrunk = (n * percentile + k * 50) / (n + k);
  return Math.max(0, Math.min(100, shrunk));
}

/**
 * 判断某个估值倍数是否处于「亏损/无意义」区间（PE/PB/PS <= 0）。
 *
 * 亏损时 PE 无经济含义，其历史分位也就不能用来判断贵贱。
 *
 * @param {object} metrics
 * @param {string} key - 基础指标 key（pe/pb/ps），不是 *Percentile
 * @returns {boolean}
 */
export function isLossMakingMetric(metrics, key) {
  if (key !== 'pe' && key !== 'pb' && key !== 'ps') return false;
  const raw = metrics?.[key];
  if (raw == null || raw === '') return false;
  const v = Number(raw);
  return Number.isFinite(v) && v <= 0;
}

/**
 * 计算基金估值评分（核心函数）
 *
 * @param {object} metrics - 指标值对象
 * @param {number} [metrics.pe] - PE-TTM
 * @param {number} [metrics.pb] - PB
 * @param {number} [metrics.ps] - PS
 * @param {number} [metrics.peg] - PEG
 * @param {number} [metrics.pePercentile] - PE 历史百分位 (0-100)
 * @param {number} [metrics.pbPercentile] - PB 历史百分位 (0-100)
 * @param {number} [metrics.psPercentile] - PS 历史百分位 (0-100)
 * @param {number} [metrics.dividendYieldPercentile] - 股息率历史百分位 (0-100)
 * @param {number} [metrics.epsGrowth] - 盈利增速 (%)
 * @param {number} [metrics.roe] - ROE (%)
 * @param {string} classification - 基金分类（FUND_CATEGORIES 枚举值）
 * @returns {{ score: number|null, rating: string, confidence: number, classification: string, details: object[] }}
 */
export function calculateValuationScore(metrics, classification) {
  const rules = getValuationRule(classification);
  const { indicators, pegThresholds } = rules;

  let totalScore = 0;
  let totalWeight = 0;
  const details = [];

  for (const { key, weight, usePercentile, absolute } of indicators) {
    const rawValue = metrics?.[key];
    const indicatorDef = getIndicatorDef(key);

    // 亏损守卫：PE/PB/PS <= 0 时，其历史分位会把「亏损」读成「极度低估」，
    // 因此分位类评分一律作废（绝对值路径本来就有 <= 0 → null 的守卫）。
    const baseKey = key.endsWith('Percentile') ? key.slice(0, -'Percentile'.length) : key;
    const lossGuarded = isLossMakingMetric(metrics, baseKey);

    let score;
    // 实际参与评分的是分位还是原始值：UI 要据此说明「这一列用的是历史分位（N 个样本）」
    let scoredBy = 'raw';
    if (key === 'peg') {
      score = rawValue == null ? null : pegToScore(rawValue, pegThresholds);
    } else if (key.endsWith('Percentile')) {
      // 分位数直接映射
      score = rawValue == null || lossGuarded ? null : normalizeToScore(key, rawValue, indicatorDef);
    } else if (usePercentile) {
      // 标记为 usePercentile 的指标优先用历史分位评分；
      // 分位数据缺失时，仅当规则项显式声明 absolute: true 才回退到原始值阈值评分。
      // 显式开关是必要的：PE/PB/PS 的阈值映射同时被美股规则使用，
      // 若此处无条件回退，会把「依赖历史分位」的 A 股宽基等规则一并改写。
      // 注意：这里不能因为 metrics[key] 缺失就提前跳过 —— 有了历史分位时，
      // 原始值（如 pe 本身）只是回退用，分位已足够评分。
      const percentileKey = `${key}Percentile`;
      const percentileValue = metrics?.[percentileKey];
      if (percentileValue != null && !lossGuarded) {
        score = normalizeToScore(percentileKey, percentileValue, indicatorDef);
        scoredBy = 'percentile';
      } else if (absolute === true && rawValue != null) {
        score = normalizeToScore(key, rawValue, indicatorDef);
      } else {
        score = null;
      }
    } else {
      score = rawValue == null ? null : normalizeToScore(key, rawValue, indicatorDef);
    }

    details.push({
      key,
      label: indicatorDef?.label || key,
      rawValue: rawValue ?? null,
      score,
      weight,
      contributed: score != null,
      // 供 UI 解释「有数据但没参与评分」的原因（如亏损股的 PE 分位）
      lossGuarded: lossGuarded && score == null,
      // percentile = 这一列用的是历史分位（而不是绝对阈值）
      scoredBy
    });

    if (score != null) {
      totalScore += score * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) {
    return {
      score: null,
      rating: scoreToRating(null).label,
      confidence: 0,
      indicatorCoverage: 0,
      classification,
      details
    };
  }

  const finalScore = totalScore / totalWeight;
  const rating = scoreToRating(finalScore);
  // 指标覆盖率 = 实际参与计算的权重占比（规则权重已归一，满覆盖即 100%）
  // 注意：这只是「置信度」的一个因子，调用方还需乘上持仓覆盖率与财报时效性
  // （见 app/api/fund.js 的 confidenceOfScore）。
  const indicatorCoverage = Math.round(totalWeight * 100);

  return {
    score: Math.round(finalScore * 10) / 10,
    rating: rating.label,
    ratingColor: rating.color,
    confidence: indicatorCoverage,
    indicatorCoverage,
    classification,
    details
  };
}

/**
 * 从持仓穿透估值结果中提取 metrics 对象
 *
 * @param {object} holdingsValuation - fetchHoldingsValuation 返回值
 * @returns {object} metrics 对象（供 calculateValuationScore 使用）
 */
export function extractMetricsFromHoldingsValuation(holdingsValuation) {
  if (!holdingsValuation?.metrics) {
    return {};
  }
  const m = holdingsValuation.metrics;
  return {
    pe: m.pe ?? null,
    pb: m.pb ?? null,
    ps: m.ps ?? null,
    peg: m.peg ?? null,
    epsGrowth: m.epsGrowth ?? null,
    revenueGrowth: m.revenueGrowth ?? null,
    dividendYield: m.dividendYield ?? null,
    dividendPayoutRatio: m.dividendPayoutRatio ?? null,
    roe: m.roe ?? null
  };
}

export const __test__ = {
  pegToScore,
  dividendYieldToScore,
  dividendPayoutRatioToScore,
  epsGrowthToScore,
  revenueGrowthToScore,
  peToScore,
  pbToScore,
  psToScore,
  roeToScore,
  normalizeToScore,
  computePercentile,
  shrinkPercentile,
  isLossMakingMetric,
  scoreToRating,
  PERCENTILE_SHRINK_REFERENCE,
  RATINGS
};
