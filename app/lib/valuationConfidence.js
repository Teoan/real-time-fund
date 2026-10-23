import dayjs from 'dayjs';
import lodash from 'lodash';

/**
 * 估值评分的「置信度」构成。
 *
 * 置信度回答的不是「分数多高」，而是「这个分数有多可信」。它由三个互相独立的
 * 粗糙度来源相乘得到：
 *
 *   1. indicatorCoverage —— 该分类的指标里，有多少权重真的算出了分数
 *      （由 valuationEngine.calculateValuationScore 给出，0-100）；
 *   2. coverageFactor    —— 持仓穿透覆盖率不足时的折扣。只披露前十大（常 30%-50% 仓位）
 *      的基金，结论只代表这部分仓位，不能和穿透 90% 的基金同等可信；
 *   3. stalenessFactor   —— 季报时效折扣。季报披露滞后约 1 个月，超过 4 个月仍在用
 *      同一份持仓，等于在用过时快照做判断。
 *
 * 三者相乘而不是取最小值：两个「轻微」缺陷叠加，可信度应当低于任一单项。
 * 输出同时带 breakdown，便于 UI 解释「为什么置信度只有 45」。
 */

/** 持仓穿透「基本覆盖」门槛：前十大合计常在 60%-80%，取 60% 作为满分区 */
const HOLDINGS_COVERAGE_FULL = 60;
/** 季报时效：4 个月内视为最新一季（披露滞后 ≈ 1 个月） */
const HOLDINGS_FRESH_MONTHS = 4;
/** 超过 9 个月（≈3 个季度）仍未更新 → 时效因子跌到下限 */
const HOLDINGS_STALE_MONTHS = 9;
const HOLDINGS_STALE_FLOOR = 0.6;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MONTH_MS = 30.44 * ONE_DAY_MS;

/**
 * 解析季报披露期成毫秒时间戳。
 * 天天基金的 Expansion 字段形如「2025年2季度股票投资明细」「2024年4季度」，也兼容「2025-09-30」「2025/9/30」。
 *
 * @param {string|null} reportDate
 * @returns {number|null}
 */
export const parseHoldingsReportDate = (reportDate) => {
  if (!lodash.isString(reportDate) || !reportDate.trim()) return null;
  const quarter = reportDate.match(/(\d{4})\s*年\s*(?:第)?\s*([1-4])\s*季度/);
  if (quarter) {
    // 季度末：Q1→03-31、Q2→06-30、Q3→09-30、Q4→12-31
    const monthDay = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' }[quarter[2]];
    const d = dayjs(`${quarter[1]}-${monthDay}`, 'YYYY-MM-DD');
    return d.isValid() ? d.valueOf() : null;
  }
  const d = dayjs(reportDate.trim());
  return d.isValid() ? d.valueOf() : null;
};

/**
 * 综合置信度 = 指标覆盖率 × 持仓覆盖因子 × 季报时效因子。
 *
 * 原来的置信度只等于「有多少指标被算出来了」（indicatorCoverage）。问题在于：
 * 一只只披露了前十大（合计 30% 仓位）、且季报已是 8 个月前的基金，同样能把
 * 指标覆盖率算到 100% —— 但它的结论只代表 30% 的仓位、且可能已完全过时。
 * 所以这两个「数据完整度之外的粗糙度」必须单独进置信度。
 *
 * @param {{indicatorCoverage: number, holdingsCoverage: number,
 *   holdingsReportDate?: string|null, now?: number}} params
 * @returns {{confidence: number, breakdown: object}}
 */
export const composeValuationConfidence = ({
  indicatorCoverage,
  holdingsCoverage,
  holdingsReportDate,
  now = Date.now()
}) => {
  const coverage = Number.isFinite(indicatorCoverage) ? indicatorCoverage : 0;
  const holdingsRatio = Number.isFinite(holdingsCoverage) ? holdingsCoverage : 0;
  // 不足 60% 按比例折算（30% → 0.5），下限 0.3：再低也要保留「有结论但很粗」的区分度
  const coverageFactor =
    holdingsRatio >= HOLDINGS_COVERAGE_FULL ? 1 : Math.max(0.3, holdingsRatio / HOLDINGS_COVERAGE_FULL);

  const reportTs = parseHoldingsReportDate(holdingsReportDate);
  let stalenessFactor = 1;
  let holdingsAgeMonths = null;
  if (reportTs != null) {
    holdingsAgeMonths = (now - reportTs) / ONE_MONTH_MS;
    if (holdingsAgeMonths > HOLDINGS_STALE_MONTHS) {
      stalenessFactor = HOLDINGS_STALE_FLOOR;
    } else if (holdingsAgeMonths > HOLDINGS_FRESH_MONTHS) {
      // 4 → 9 个月线性下滑：1 → 0.6
      const t = (holdingsAgeMonths - HOLDINGS_FRESH_MONTHS) / (HOLDINGS_STALE_MONTHS - HOLDINGS_FRESH_MONTHS);
      stalenessFactor = 1 - t * (1 - HOLDINGS_STALE_FLOOR);
    }
  }

  return {
    confidence: Math.round(coverage * coverageFactor * stalenessFactor),
    breakdown: {
      indicatorCoverage: Math.round(coverage),
      coverageFactor: Number(coverageFactor.toFixed(2)),
      stalenessFactor: Number(stalenessFactor.toFixed(2)),
      holdingsCoverage: Math.round(holdingsRatio),
      holdingsAgeMonths: holdingsAgeMonths == null ? null : Number(holdingsAgeMonths.toFixed(1))
    }
  };
};

export const __test__ = {
  HOLDINGS_COVERAGE_FULL,
  HOLDINGS_FRESH_MONTHS,
  HOLDINGS_STALE_MONTHS,
  HOLDINGS_STALE_FLOOR
};
