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
  if (key === 'roe') {
    return roeToScore(value);
  }

  // 其他指标暂时返回 null（需要历史分位才能评分）
  // 后续可扩展：revenueGrowth、fcf、grossMargin 等
  return null;
}

/**
 * 计算一组数值的百分位
 * @param {number[]} values - 历史数值数组
 * @param {number} current - 当前值
 * @returns {number} 0-100 的百分位（当前值在历史中的位置）
 */
export function computePercentile(values, current) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(current)) return null;

  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return null;

  let below = 0;
  for (const v of valid) {
    if (v < current) below++;
  }
  return (below / valid.length) * 100;
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

  for (const { key, weight, usePercentile } of indicators) {
    const rawValue = metrics?.[key];
    const indicatorDef = getIndicatorDef(key);

    let score;
    if (rawValue == null) {
      score = null;
    } else if (key === 'peg') {
      score = pegToScore(rawValue, pegThresholds);
    } else if (key.endsWith('Percentile')) {
      // 分位数直接映射
      score = normalizeToScore(key, rawValue, indicatorDef);
    } else if (usePercentile && rawValue != null) {
      // 标记为 usePercentile 的指标（如股息率），优先用历史分位评分；
      // 分位数据缺失时回退到原始值阈值评分（如股息率 4%+ → 低分），
      // 避免"有当前值却完全不参与评分"
      const percentileKey = `${key}Percentile`;
      const percentileValue = metrics?.[percentileKey];
      score =
        percentileValue != null
          ? normalizeToScore(percentileKey, percentileValue, indicatorDef)
          : normalizeToScore(key, rawValue, indicatorDef);
    } else {
      score = normalizeToScore(key, rawValue, indicatorDef);
    }

    details.push({
      key,
      label: indicatorDef?.label || key,
      rawValue: rawValue ?? null,
      score,
      weight,
      contributed: score != null
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
      classification,
      details
    };
  }

  const finalScore = totalScore / totalWeight;
  const rating = scoreToRating(finalScore);
  // 置信度 = 实际参与计算的权重占比
  const confidence = Math.round(totalWeight * 100);

  return {
    score: Math.round(finalScore * 10) / 10,
    rating: rating.label,
    ratingColor: rating.color,
    confidence,
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
    dividendYield: m.dividendYield ?? null,
    roe: m.roe ?? null
  };
}

export const __test__ = {
  pegToScore,
  dividendYieldToScore,
  epsGrowthToScore,
  roeToScore,
  normalizeToScore,
  computePercentile,
  scoreToRating,
  RATINGS
};
