/**
 * 估值体系单元测试
 *
 * 覆盖：
 *   - 基金分类器（14 种类型 + 兜底）
 *   - 估值规则完整性（所有类型都有规则）
 *   - 评分引擎（PEG 评分、分位映射、加权计算）
 *   - 边界情况（空数据、NaN、极端值）
 *
 * 运行：node --test app/lib/__tests__/valuation.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFund, FUND_CATEGORIES, CATEGORY_NAMES } from '../fundClassifier.js';
import { getValuationRule, VALUATION_RULES } from '../valuationRules.js';
import {
  calculateValuationScore,
  pegToScore,
  dividendYieldToScore,
  epsGrowthToScore,
  roeToScore,
  computePercentile,
  scoreToRating,
  extractMetricsFromHoldingsValuation,
  __test__ as engineInternals
} from '../valuationEngine.js';

// ========== 基金分类器 ==========

describe('classifyFund', () => {
  it('沪深300 → broad_index', () => {
    const r = classifyFund('指数型-股票', ['沪深300指数']);
    assert.equal(r.category, FUND_CATEGORIES.BROAD_INDEX);
    assert.ok(r.confidence > 0.8);
  });

  it('中证红利 → dividend', () => {
    const r = classifyFund('指数型-股票', ['中证红利指数']);
    assert.equal(r.category, FUND_CATEGORIES.DIVIDEND);
  });

  it('半导体 → tech', () => {
    const r = classifyFund('股票型', ['中证半导体指数']);
    assert.equal(r.category, FUND_CATEGORIES.TECH);
  });

  it('医药 → pharma', () => {
    const r = classifyFund('混合型', ['中证全指医药卫生指数']);
    assert.equal(r.category, FUND_CATEGORIES.PHARMA);
  });

  it('消费 → consumer', () => {
    const r = classifyFund('股票型', ['中证主要消费指数']);
    assert.equal(r.category, FUND_CATEGORIES.CONSUMER);
  });

  it('银行 → finance', () => {
    const r = classifyFund('指数型', ['中证银行指数']);
    assert.equal(r.category, FUND_CATEGORIES.FINANCE);
  });

  it('煤炭 → cyclical', () => {
    const r = classifyFund('股票型', ['中证煤炭指数']);
    assert.equal(r.category, FUND_CATEGORIES.CYCLICAL);
  });

  it('新能源 → new_energy', () => {
    const r = classifyFund('股票型', ['新能源指数']);
    assert.equal(r.category, FUND_CATEGORIES.NEW_ENERGY);
  });

  it('军工 → military', () => {
    const r = classifyFund('股票型', ['中证军工指数']);
    assert.equal(r.category, FUND_CATEGORIES.MILITARY);
  });

  it('地产 → real_estate', () => {
    const r = classifyFund('股票型', ['房地产指数']);
    assert.equal(r.category, FUND_CATEGORIES.REAL_ESTATE);
  });

  it('REIT → reits', () => {
    const r = classifyFund('', ['REIT指数']);
    assert.equal(r.category, FUND_CATEGORIES.REITS);
  });

  it('QDII 类型兜底 → qdii', () => {
    const r = classifyFund('QDII', []);
    assert.equal(r.category, FUND_CATEGORIES.QDII);
  });

  it('指数型兜底 → sector_index', () => {
    const r = classifyFund('指数型-股票', []);
    assert.equal(r.category, FUND_CATEGORIES.SECTOR_INDEX);
  });

  it('债券型兜底 → bond', () => {
    const r = classifyFund('债券型', []);
    assert.equal(r.category, FUND_CATEGORIES.BOND);
  });

  it('股票型兜底 → growth', () => {
    const r = classifyFund('股票型', []);
    assert.equal(r.category, FUND_CATEGORIES.GROWTH);
  });

  it('空输入 → other', () => {
    const r = classifyFund('', []);
    assert.equal(r.category, FUND_CATEGORIES.OTHER);
  });

  it('null 输入 → other', () => {
    const r = classifyFund(null, null);
    assert.equal(r.category, FUND_CATEGORIES.OTHER);
  });

  it('多板块取第一个匹配', () => {
    const r = classifyFund('', ['中证科技传媒通信150指数', '沪深300指数']);
    assert.equal(r.category, FUND_CATEGORIES.TECH);
  });

  // ========== 按基金名称分类（第三优先级） ==========

  it('名称含消费 → consumer', () => {
    const r = classifyFund('股票型-普通', [], '易方达消费行业');
    assert.equal(r.category, FUND_CATEGORIES.CONSUMER);
    assert.equal(r.matchedBy, 'name:易方达消费行业');
  });

  it('名称含沪深300 → broad_index', () => {
    const r = classifyFund('', [], '易方达沪深300ETF联接A');
    assert.equal(r.category, FUND_CATEGORIES.BROAD_INDEX);
  });

  it('名称含医药 → pharma', () => {
    const r = classifyFund('', [], '工银前沿医疗股票');
    assert.equal(r.category, FUND_CATEGORIES.PHARMA);
  });

  it('名称含军工 → military', () => {
    const r = classifyFund('股票型', [], '国泰中证军工ETF');
    assert.equal(r.category, FUND_CATEGORIES.MILITARY);
  });

  it('名称无关键词时回退到类型', () => {
    const r = classifyFund('债券型', [], '易方达稳健收益债券B');
    assert.equal(r.category, FUND_CATEGORIES.BOND);
    assert.equal(r.matchedBy, 'type:债券型');
  });

  it('板块优先级高于名称', () => {
    const r = classifyFund('股票型', ['沪深300指数'], '某某军工股票');
    assert.equal(r.category, FUND_CATEGORIES.BROAD_INDEX);
    assert.ok(r.matchedBy.startsWith('sector:'));
  });

  it('名称优先级高于类型', () => {
    const r = classifyFund('指数型-股票', [], '招商中证白酒指数(LOF)A');
    assert.equal(r.category, FUND_CATEGORIES.CONSUMER);
  });

  it('所有分类都有中文名', () => {
    for (const cat of Object.values(FUND_CATEGORIES)) {
      assert.ok(CATEGORY_NAMES[cat], `Missing name for ${cat}`);
    }
  });
});

// ========== 估值规则 ==========

describe('valuationRules', () => {
  it('所有分类都有规则', () => {
    for (const cat of Object.values(FUND_CATEGORIES)) {
      const rule = getValuationRule(cat);
      assert.ok(rule, `Missing rule for ${cat}`);
      assert.ok(rule.indicators?.length > 0, `Empty indicators for ${cat}`);
    }
  });

  it('每个规则的权重总和 ≈ 1.0', () => {
    for (const cat of Object.values(FUND_CATEGORIES)) {
      const rule = getValuationRule(cat);
      const totalWeight = rule.indicators.reduce((s, i) => s + i.weight, 0);
      assert.ok(Math.abs(totalWeight - 1.0) < 0.01, `Weight sum for ${cat}: ${totalWeight} (expected ~1.0)`);
    }
  });

  it('getValuationRule 对未知分类返回默认规则', () => {
    const rule = getValuationRule('unknown_category');
    assert.ok(rule);
    assert.equal(rule.name, '其他');
  });
});

// ========== 评分引擎 ==========

describe('pegToScore', () => {
  it('PEG < 0.8 → 低估', () => {
    assert.equal(pegToScore(0.5), 15);
    assert.equal(pegToScore(0.79), 15);
  });

  it('PEG 0.8-1.2 → 合理偏低', () => {
    assert.equal(pegToScore(0.8), 35);
    assert.equal(pegToScore(1.0), 35);
    assert.equal(pegToScore(1.19), 35);
  });

  it('PEG 1.2-1.8 → 合理', () => {
    assert.equal(pegToScore(1.2), 55);
    assert.equal(pegToScore(1.5), 55);
  });

  it('PEG 1.8-2.5 → 偏高', () => {
    assert.equal(pegToScore(1.8), 75);
    assert.equal(pegToScore(2.0), 75);
  });

  it('PEG > 2.5 → 高估', () => {
    assert.equal(pegToScore(3.0), 92);
  });

  it('PEG 负值 → 中性', () => {
    assert.equal(pegToScore(-1), 50);
  });

  it('PEG null → 中性', () => {
    assert.equal(pegToScore(null), 50);
  });

  it('自定义阈值', () => {
    const t = { low: 1.0, fair: 1.5, slightlyHigh: 2.0, high: 3.0 };
    assert.equal(pegToScore(0.9, t), 15);
    assert.equal(pegToScore(1.2, t), 35);
  });
});

describe('dividendYieldToScore', () => {
  it('股息率越高分越低（越便宜）', () => {
    assert.ok(dividendYieldToScore(6) < dividendYieldToScore(3));
    assert.ok(dividendYieldToScore(3) < dividendYieldToScore(0.5));
  });

  it('边界档位', () => {
    assert.equal(dividendYieldToScore(5), 10);
    assert.equal(dividendYieldToScore(4), 20);
    assert.equal(dividendYieldToScore(3), 35);
    assert.equal(dividendYieldToScore(2), 50);
    assert.equal(dividendYieldToScore(1), 65);
    assert.equal(dividendYieldToScore(0.5), 80);
    assert.equal(dividendYieldToScore(0), 90);
  });

  it('null/NaN → null', () => {
    assert.equal(dividendYieldToScore(null), null);
    assert.equal(dividendYieldToScore(NaN), null);
  });
});

describe('epsGrowthToScore', () => {
  it('增速越高分越低（增长消化估值）', () => {
    assert.ok(epsGrowthToScore(50) < epsGrowthToScore(10));
    assert.ok(epsGrowthToScore(10) < epsGrowthToScore(-20));
  });

  it('边界档位', () => {
    assert.equal(epsGrowthToScore(30), 15);
    assert.equal(epsGrowthToScore(15), 30);
    assert.equal(epsGrowthToScore(5), 45);
    assert.equal(epsGrowthToScore(0), 55);
    assert.equal(epsGrowthToScore(-15), 70);
    assert.equal(epsGrowthToScore(-30), 85);
  });

  it('null/NaN → null', () => {
    assert.equal(epsGrowthToScore(null), null);
    assert.equal(epsGrowthToScore(NaN), null);
  });
});

describe('roeToScore', () => {
  it('ROE 越高分越低（盈利质量越好越便宜）', () => {
    assert.ok(roeToScore(30) < roeToScore(12));
    assert.ok(roeToScore(12) < roeToScore(2));
    assert.ok(roeToScore(2) < roeToScore(-5));
  });

  it('边界档位', () => {
    assert.equal(roeToScore(25), 10);
    assert.equal(roeToScore(20), 20);
    assert.equal(roeToScore(15), 35);
    assert.equal(roeToScore(10), 50);
    assert.equal(roeToScore(5), 65);
    assert.equal(roeToScore(0), 78);
    assert.equal(roeToScore(-1), 90);
  });

  it('null/NaN/Infinity → null', () => {
    assert.equal(roeToScore(null), null);
    assert.equal(roeToScore(NaN), null);
    assert.equal(roeToScore(Infinity), null);
  });
});

describe('computePercentile', () => {
  it('正常计算', () => {
    const values = [10, 20, 30, 40, 50];
    // 25 在 10,20 之下，2/5 = 40%
    assert.equal(computePercentile(values, 25), 40);
  });

  it('最低值 → 0%', () => {
    assert.equal(computePercentile([10, 20, 30], 5), 0);
  });

  it('最高值 → ~100%', () => {
    const p = computePercentile([10, 20, 30], 35);
    assert.equal(p, 100);
  });

  it('空数组 → null', () => {
    assert.equal(computePercentile([], 10), null);
    assert.equal(computePercentile(null, 10), null);
  });

  it('NaN 值被过滤', () => {
    const values = [10, NaN, 20, Infinity, 30];
    const p = computePercentile(values, 15);
    assert.ok(Math.abs(p - 33.333) < 0.01, `Expected ~33.33, got ${p}`);
  });
});

describe('scoreToRating', () => {
  it('各分界点', () => {
    assert.equal(scoreToRating(0).label, '极度低估');
    assert.equal(scoreToRating(14.9).label, '极度低估');
    assert.equal(scoreToRating(15).label, '低估');
    assert.equal(scoreToRating(29.9).label, '低估');
    assert.equal(scoreToRating(30).label, '偏低');
    assert.equal(scoreToRating(45).label, '合理');
    assert.equal(scoreToRating(60).label, '偏高');
    assert.equal(scoreToRating(75).label, '高估');
    assert.equal(scoreToRating(90).label, '极度高估');
    assert.equal(scoreToRating(100).label, '极度高估');
  });

  it('null → 数据不足', () => {
    assert.equal(scoreToRating(null).label, '数据不足');
    assert.equal(scoreToRating(NaN).label, '数据不足');
  });
});

describe('calculateValuationScore', () => {
  it('宽基指数：PE 分位 25% → 低估', () => {
    const metrics = { pePercentile: 25, pbPercentile: 30 };
    const r = calculateValuationScore(metrics, FUND_CATEGORIES.BROAD_INDEX);
    assert.ok(r.score < 30, `Expected low score, got ${r.score}`);
    assert.ok(['极度低估', '低估'].includes(r.rating));
    assert.ok(r.confidence > 0);
  });

  it('宽基指数：PE 分位 80% → 高估', () => {
    const metrics = { pePercentile: 80, pbPercentile: 75 };
    const r = calculateValuationScore(metrics, FUND_CATEGORIES.BROAD_INDEX);
    assert.ok(r.score > 60, `Expected high score, got ${r.score}`);
    assert.ok(['偏高', '高估', '极度高估'].includes(r.rating));
  });

  it('成长型：PEG 低 → 低估', () => {
    const metrics = { peg: 0.6, pePercentile: 30, epsGrowth: 40 };
    const r = calculateValuationScore(metrics, FUND_CATEGORIES.GROWTH);
    assert.ok(r.score < 40);
  });

  it('成长型：PEG 高 → 高估', () => {
    const metrics = { peg: 3.0, pePercentile: 80 };
    const r = calculateValuationScore(metrics, FUND_CATEGORIES.GROWTH);
    assert.ok(r.score > 60);
  });

  it('全部指标缺失 → 数据不足', () => {
    const r = calculateValuationScore({}, FUND_CATEGORIES.BROAD_INDEX);
    assert.equal(r.score, null);
    assert.equal(r.rating, '数据不足');
    assert.equal(r.confidence, 0);
  });

  it('部分指标缺失 → 降权计算', () => {
    const metrics = { pePercentile: 50 }; // 只有1个指标
    const r = calculateValuationScore(metrics, FUND_CATEGORIES.BROAD_INDEX);
    assert.ok(r.score != null);
    assert.ok(r.confidence < 100);
  });

  it('details 包含每个指标的明细', () => {
    const metrics = { pePercentile: 30, pbPercentile: 40, peg: 1.0 };
    const r = calculateValuationScore(metrics, FUND_CATEGORIES.GROWTH);
    assert.ok(r.details.length > 0);
    const peDetail = r.details.find((d) => d.key === 'pePercentile');
    assert.ok(peDetail);
    assert.equal(peDetail.rawValue, 30);
    assert.equal(peDetail.contributed, true);
  });

  it('红利型：股息率高分位 → 低估', () => {
    const metrics = { dividendYieldPercentile: 85, pbPercentile: 30 };
    const r = calculateValuationScore(metrics, FUND_CATEGORIES.DIVIDEND);
    // 股息率高分位 = 股息率高 = 便宜 = 低估值分
    assert.ok(r.score < 50, `Expected low score for high dividend, got ${r.score}`);
  });

  it('红利型：仅有原始股息率（无分位）→ 回退阈值评分', () => {
    const metrics = { dividendYield: 4.5, pbPercentile: 30 };
    const r = calculateValuationScore(metrics, FUND_CATEGORIES.DIVIDEND);
    const dyDetail = r.details.find((d) => d.key === 'dividendYield');
    assert.equal(dyDetail.contributed, true);
    assert.equal(dyDetail.score, 20);
    assert.ok(r.score < 50, `Expected low score for high raw dividend, got ${r.score}`);
  });

  it('成长型：原始盈利增速参与评分', () => {
    const metrics = { peg: 1.0, pePercentile: 50, epsGrowth: 35 };
    const r = calculateValuationScore(metrics, FUND_CATEGORIES.GROWTH);
    const growthDetail = r.details.find((d) => d.key === 'epsGrowth');
    assert.equal(growthDetail.contributed, true);
    assert.equal(growthDetail.score, 15);
  });

  it('分位数据存在时优先于原始值回退', () => {
    const metrics = { dividendYield: 0.2, dividendYieldPercentile: 90 };
    const r = calculateValuationScore(metrics, FUND_CATEGORIES.DIVIDEND);
    const dyDetail = r.details.find((d) => d.key === 'dividendYield');
    // 高分位（便宜）应覆盖低原始值的回退判断
    assert.equal(dyDetail.score, 10);
  });

  it('金融：ROE 参与评分，盈利越强总分越低', () => {
    const strong = calculateValuationScore({ pbPercentile: 20, roe: 18 }, FUND_CATEGORIES.FINANCE);
    const weak = calculateValuationScore({ pbPercentile: 20, roe: 1 }, FUND_CATEGORIES.FINANCE);
    const roeDetail = strong.details.find((d) => d.key === 'roe');
    assert.equal(roeDetail.contributed, true);
    assert.equal(roeDetail.rawValue, 18);
    assert.equal(roeDetail.score, 35);
    assert.ok(strong.score < weak.score, `strong(${strong.score}) 应低于 weak(${weak.score})`);
  });

  it('金融：ROE 缺失时该指标不计入，仅降低置信度', () => {
    const withRoe = calculateValuationScore({ pbPercentile: 20, roe: 18 }, FUND_CATEGORIES.FINANCE);
    const withoutRoe = calculateValuationScore({ pbPercentile: 20 }, FUND_CATEGORIES.FINANCE);
    const roeDetail = withoutRoe.details.find((d) => d.key === 'roe');
    assert.equal(roeDetail.contributed, false);
    assert.equal(roeDetail.score, null);
    assert.ok(withoutRoe.confidence < withRoe.confidence);
  });

  it('null metrics → 数据不足', () => {
    const r = calculateValuationScore(null, FUND_CATEGORIES.GROWTH);
    assert.equal(r.score, null);
    assert.equal(r.confidence, 0);
  });
});

describe('extractMetricsFromHoldingsValuation', () => {
  it('正常提取', () => {
    const hv = {
      metrics: { pe: 15, pb: 2, ps: 3, peg: 1.2, epsGrowth: 20, dividendYield: 3.5, roe: 16.75 }
    };
    const m = extractMetricsFromHoldingsValuation(hv);
    assert.equal(m.pe, 15);
    assert.equal(m.pb, 2);
    assert.equal(m.ps, 3);
    assert.equal(m.peg, 1.2);
    assert.equal(m.epsGrowth, 20);
    assert.equal(m.dividendYield, 3.5);
    assert.equal(m.roe, 16.75);
  });

  it('缺失的 roe 归一为 null', () => {
    const m = extractMetricsFromHoldingsValuation({ metrics: { pe: 15 } });
    assert.equal(m.roe, null);
  });

  it('null 字段归一为空对象', () => {
    const m = extractMetricsFromHoldingsValuation(null);
    assert.deepEqual(m, {});
  });

  it('metrics 中 null 值保留', () => {
    const hv = { metrics: { pe: 15, pb: null, ps: null } };
    const m = extractMetricsFromHoldingsValuation(hv);
    assert.equal(m.pe, 15);
    assert.equal(m.pb, null);
    assert.equal(m.ps, null);
  });
});
