import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHoldingsReportDate,
  composeValuationConfidence,
  __test__ as confidenceInternals
} from '../valuationConfidence.js';

const TS = (iso) => new Date(`${iso}T00:00:00`).getTime();

describe('parseHoldingsReportDate', () => {
  it('解析「YYYY年N季度」形式（天天基金 Expansion 字段）', () => {
    assert.equal(parseHoldingsReportDate('2025年1季度股票投资明细'), TS('2025-03-31'));
    assert.equal(parseHoldingsReportDate('2025年2季度股票投资明细'), TS('2025-06-30'));
    assert.equal(parseHoldingsReportDate('2025年第3季度'), TS('2025-09-30'));
    assert.equal(parseHoldingsReportDate('2024年4季度'), TS('2024-12-31'));
  });

  it('解析 ISO 日期形式', () => {
    assert.equal(parseHoldingsReportDate('2025-09-30'), TS('2025-09-30'));
    assert.equal(parseHoldingsReportDate('2025/9/30'), TS('2025-09-30'));
  });

  it('空值 / 无法解析 → null', () => {
    assert.equal(parseHoldingsReportDate(null), null);
    assert.equal(parseHoldingsReportDate(''), null);
    assert.equal(parseHoldingsReportDate('   '), null);
    assert.equal(parseHoldingsReportDate('最新季报'), null);
    assert.equal(parseHoldingsReportDate(12345), null);
  });
});

describe('composeValuationConfidence', () => {
  const NOW = TS('2026-03-21');
  const FRESH = '2025年4季度'; // 期末 2025-12-31 → 距 NOW ≈ 2.7 个月
  const AGING = '2025年2季度'; // 期末 2025-06-30 → 距 NOW ≈ 8.7 个月
  const STALE = '2025年1季度'; // 期末 2025-03-31 → 距 NOW ≈ 11.7 个月

  it('覆盖充足 + 最新季报 → 置信度等于指标覆盖率', () => {
    const r = composeValuationConfidence({
      indicatorCoverage: 80,
      holdingsCoverage: 85,
      holdingsReportDate: FRESH,
      now: NOW
    });
    assert.equal(r.confidence, 80);
    assert.equal(r.breakdown.coverageFactor, 1);
    assert.equal(r.breakdown.stalenessFactor, 1);
  });

  it('持仓覆盖不足按比例折算（30% 覆盖 → 0.5 因子）', () => {
    const r = composeValuationConfidence({
      indicatorCoverage: 100,
      holdingsCoverage: 30,
      holdingsReportDate: FRESH,
      now: NOW
    });
    assert.equal(r.breakdown.coverageFactor, 0.5);
    assert.equal(r.confidence, 50);
  });

  it('持仓覆盖率为 0 时不归零而下探到 0.3 下限（保留区分度）', () => {
    const r = composeValuationConfidence({
      indicatorCoverage: 100,
      holdingsCoverage: 0,
      holdingsReportDate: FRESH,
      now: NOW
    });
    assert.equal(r.breakdown.coverageFactor, 0.3);
    assert.equal(r.confidence, 30);
  });

  it('季报滞后 4~9 个月线性下滑', () => {
    const r = composeValuationConfidence({
      indicatorCoverage: 100,
      holdingsCoverage: 90,
      holdingsReportDate: AGING,
      now: NOW
    });
    // ≈8.7 个月 → t≈0.95 → 1 - 0.95*0.4 ≈ 0.62
    assert.ok(r.breakdown.stalenessFactor < 0.7, `实际 ${r.breakdown.stalenessFactor}`);
    assert.ok(r.breakdown.stalenessFactor > 0.6);
    assert.ok(r.confidence < 70 && r.confidence > 60, `实际 ${r.confidence}`);
  });

  it('季报超过 9 个月 → 时效因子跌到 0.6 下限', () => {
    const r = composeValuationConfidence({
      indicatorCoverage: 100,
      holdingsCoverage: 90,
      holdingsReportDate: STALE,
      now: NOW
    });
    assert.equal(r.breakdown.stalenessFactor, 0.6);
    assert.equal(r.confidence, 60);
  });

  it('三个因子相乘：低覆盖 + 过期季报叠加后显著低于任一单项', () => {
    const r = composeValuationConfidence({
      indicatorCoverage: 90,
      holdingsCoverage: 30,
      holdingsReportDate: STALE,
      now: NOW
    });
    // 90 × 0.5 × 0.6 = 27
    assert.equal(r.confidence, 27);
  });

  it('季报日期缺失 → 不做时效惩罚（未知不等于过期）', () => {
    const r = composeValuationConfidence({
      indicatorCoverage: 70,
      holdingsCoverage: 80,
      holdingsReportDate: null,
      now: NOW
    });
    assert.equal(r.breakdown.stalenessFactor, 1);
    assert.equal(r.breakdown.holdingsAgeMonths, null);
    assert.equal(r.confidence, 70);
  });

  it('入参非法时退化为 0，不产生 NaN', () => {
    const r = composeValuationConfidence({ indicatorCoverage: undefined, holdingsCoverage: null });
    assert.equal(r.confidence, 0);
    assert.equal(Number.isNaN(r.confidence), false);
  });

  it('breakdown 四舍五入到可展示的精度', () => {
    const r = composeValuationConfidence({
      indicatorCoverage: 66.6667,
      holdingsCoverage: 41.5,
      holdingsReportDate: FRESH,
      now: NOW
    });
    assert.equal(r.breakdown.indicatorCoverage, 67);
    assert.equal(r.breakdown.holdingsCoverage, 42);
    assert.equal(r.breakdown.coverageFactor, 0.69);
    assert.equal(typeof r.breakdown.holdingsAgeMonths, 'number');
  });

  it('常量口径：满覆盖门槛 60% / 新鲜 4 个月 / 过期 9 个月 / 下限 0.6', () => {
    assert.equal(confidenceInternals.HOLDINGS_COVERAGE_FULL, 60);
    assert.equal(confidenceInternals.HOLDINGS_FRESH_MONTHS, 4);
    assert.equal(confidenceInternals.HOLDINGS_STALE_MONTHS, 9);
    assert.equal(confidenceInternals.HOLDINGS_STALE_FLOOR, 0.6);
  });
});
