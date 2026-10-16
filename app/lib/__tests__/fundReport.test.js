/**
 * 调研初步报告生成器单元测试
 *
 * 覆盖：
 *   - 评分锚点插值（含**降序锚点**这一曾把深回撤评成满分的回归护栏）
 *   - 分档判读的边界、缺失指标不判读
 *   - 综合画像评分：维度权重、缺失维度按剩余权重归一化、全部缺失时不给分
 *   - 跨指标组合判读（尾部深度、胜率×盈亏比、Beta×Alpha、无基准、样本过短）
 *   - 报告结构完整性、Markdown 全文自洽（不含 NaN/undefined/null）
 *   - 三只真实基金的指标快照作为端到端护栏
 *
 * 运行：node --test app/lib/__tests__/fundReport.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// lodash 是 CJS 包：必须「默认导入 + 解构」才能被 node --test 直接加载
import lodash from 'lodash';

const { isArray, isNumber } = lodash;

import {
  RATING_BANDS,
  REPORT_DISCLAIMER,
  REPORT_LEVELS,
  SCORE_DIMENSIONS,
  buildCrossInsights,
  buildFundResearchReport,
  buildLimitations,
  buildReportItems,
  buildReportMarkdown,
  computeProfileScore,
  scoreOfMetric
} from '../fundReport.js';

// ── 测试夹具 ──────────────────────────────────────────────────────────────

/** 一只「样样都好」的基金 */
const STRONG_METRICS = {
  cagr: 18,
  annualizedVolatility: 12,
  maxDrawdown: -11,
  sharpe: 1.4,
  sortino: 2.2,
  calmar: 1.1,
  informationRatio: 0.9,
  alpha: 6,
  beta: 0.9,
  var95: -1.1,
  cvar95: -1.6,
  winRate: 56,
  profitLossRatio: 1.35,
  sampleCount: 1285,
  startDate: '2021-06-29',
  endDate: '2026-10-14',
  pairedSampleCount: 1282,
  benchmarkName: '沪深300',
  benchmarkSecid: '1.000300',
  riskFreeRate: 2,
  insufficient: false
};

/** 一只「样样都差」的基金 */
const WEAK_METRICS = {
  ...STRONG_METRICS,
  cagr: -12,
  annualizedVolatility: 33,
  maxDrawdown: -55,
  sharpe: -0.8,
  sortino: -1.1,
  calmar: -0.3,
  informationRatio: -0.7,
  alpha: -9,
  beta: 1.35,
  var95: -3.8,
  cvar95: -6.2,
  winRate: 42,
  profitLossRatio: 0.7
};

/** 无基准（债券/货币型）的基金 */
const NO_BENCHMARK_METRICS = {
  ...STRONG_METRICS,
  benchmarkName: null,
  benchmarkSecid: null,
  pairedSampleCount: 0,
  informationRatio: null,
  alpha: null,
  beta: null
};

/** 数据不足 */
const INSUFFICIENT_METRICS = {
  cagr: null,
  annualizedVolatility: null,
  maxDrawdown: null,
  sharpe: null,
  sortino: null,
  calmar: null,
  informationRatio: null,
  alpha: null,
  beta: null,
  var95: null,
  cvar95: null,
  winRate: null,
  profitLossRatio: null,
  sampleCount: 20,
  startDate: '2026-09-01',
  endDate: '2026-09-30',
  pairedSampleCount: 0,
  benchmarkName: null,
  riskFreeRate: 2,
  insufficient: true
};

const findSection = (report, key) => report.sections.find((s) => s.key === key);

// ── 评分锚点插值 ──────────────────────────────────────────────────────────

describe('scoreOfMetric', () => {
  it('升序锚点：按线性插值（年化收益率 0% → 40 分，8% → 65 分）', () => {
    assert.equal(scoreOfMetric('cagr', 0), 40);
    assert.equal(scoreOfMetric('cagr', 8), 65);
    assert.equal(scoreOfMetric('cagr', 4), 52.5);
  });

  it('超出端点一律夹紧', () => {
    assert.equal(scoreOfMetric('cagr', 100), 100);
    assert.equal(scoreOfMetric('cagr', -100), 0);
  });

  it('回归护栏：降序锚点（最大回撤 / VaR）必须按 x 升序插值，不能把深回撤评成满分', () => {
    // 曾经的实现假设锚点天然升序，-49.6% 落进 `value <= anchors[0][0]` 兜底分支 → 100 分（最优），
    // 导致「回撤 -50%」的基金风险维度得分接近满分，整体画像评分被抬高一个档位。
    assert.ok(scoreOfMetric('maxDrawdown', -12) > 90);
    assert.ok(scoreOfMetric('maxDrawdown', -20) > 70 && scoreOfMetric('maxDrawdown', -20) < 80);
    assert.ok(scoreOfMetric('maxDrawdown', -35) > 45 && scoreOfMetric('maxDrawdown', -35) < 60);
    assert.ok(scoreOfMetric('maxDrawdown', -50) < 30, '回撤 -50% 的得分必须很低');
    assert.ok(scoreOfMetric('maxDrawdown', -70) < 10);

    // 单调性：回撤越深，得分越低（这条不变量能一次性挡住整类排序错误）
    let prev = Infinity;
    for (const mdd of [-5, -12, -20, -30, -40, -50, -60, -70, -80]) {
      const score = scoreOfMetric('maxDrawdown', mdd);
      assert.ok(score <= prev, `回撤 ${mdd}% 的得分 ${score} 不应高于更浅回撤的 ${prev}`);
      prev = score;
    }

    assert.ok(scoreOfMetric('var95', -1) > 90);
    assert.ok(scoreOfMetric('var95', -4.5) < 30);
  });

  it('缺失值 / 未知指标 → null', () => {
    assert.equal(scoreOfMetric('cagr', null), null);
    assert.equal(scoreOfMetric('cagr', NaN), null);
    assert.equal(scoreOfMetric('notAMetric', 1), null);
  });
});

// ── 综合画像评分 ──────────────────────────────────────────────────────────

describe('computeProfileScore', () => {
  it('优质基金评分高于劣质基金，且都落在 0~100', () => {
    const strong = computeProfileScore(STRONG_METRICS);
    const weak = computeProfileScore(WEAK_METRICS);
    assert.ok(strong.score > weak.score, `${strong.score} 应高于 ${weak.score}`);
    for (const s of [strong.score, weak.score]) {
      assert.ok(s >= 0 && s <= 100);
    }
    assert.equal(strong.label, '优秀');
    assert.equal(strong.level, REPORT_LEVELS.POSITIVE);
    assert.equal(weak.level, REPORT_LEVELS.WARNING);
  });

  it('四个维度权重与 SCORE_DIMENSIONS 一致（手工加权核对）', () => {
    const { score, dimensions } = computeProfileScore(STRONG_METRICS);
    const totalWeight = SCORE_DIMENSIONS.reduce((sum, d) => sum + d.weight, 0);
    const expected = Math.round(dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight);
    assert.equal(score, expected);
    assert.equal(dimensions.length, SCORE_DIMENSIONS.length);
  });

  it('缺少业绩基准时主动管理维度记 null，并按剩余权重归一化（不补 0 拉低总分）', () => {
    const withBench = computeProfileScore(STRONG_METRICS);
    const withoutBench = computeProfileScore(NO_BENCHMARK_METRICS);
    const active = withoutBench.dimensions.find((d) => d.key === 'active');
    assert.equal(active.score, null);

    // 主动管理在优质样本里得分高，去掉后应「按剩余权重」重新归一化：
    // 若实现是补 0，总分会被明显拉低
    const naiveWithZero = Math.round(
      withoutBench.dimensions.reduce((sum, d) => sum + (d.score ?? 0) * d.weight, 0) /
        SCORE_DIMENSIONS.reduce((sum, d) => sum + d.weight, 0)
    );
    assert.ok(withoutBench.score > naiveWithZero, '缺失维度不能当 0 分处理');
    assert.ok(Math.abs(withoutBench.score - withBench.score) <= 15);
  });

  it('全部指标缺失 → 不给分（null），等级为 unknown', () => {
    const result = computeProfileScore(INSUFFICIENT_METRICS);
    assert.equal(result.score, null);
    assert.equal(result.label, null);
    assert.equal(result.level, REPORT_LEVELS.UNKNOWN);
  });

  it('非法输入安全返回', () => {
    assert.equal(computeProfileScore(null).score, null);
    assert.equal(computeProfileScore(undefined).score, null);
    assert.equal(computeProfileScore({}).score, null);
  });

  it('评级档位表覆盖 0~100 的任意分值（不会出现无档可落）', () => {
    for (let score = 0; score <= 100; score++) {
      assert.ok(
        RATING_BANDS.find((band) => score >= band.min),
        `score=${score} 无匹配档位`
      );
    }
  });
});

// ── 指标条目 ──────────────────────────────────────────────────────────────

describe('buildReportItems', () => {
  it('覆盖 13 项指标，且数值格式正确', () => {
    const items = buildReportItems(STRONG_METRICS);
    assert.equal(items.length, 13);
    const byKey = new Map(items.map((i) => [i.key, i]));
    assert.equal(byKey.get('cagr').valueText, '+18.00%');
    assert.equal(byKey.get('annualizedVolatility').valueText, '12.00%');
    assert.equal(byKey.get('maxDrawdown').valueText, '-11.00%');
    assert.equal(byKey.get('sharpe').valueText, '1.40');
    assert.equal(byKey.get('alpha').valueText, '+6.00%');
    assert.equal(byKey.get('winRate').valueText, '56.0%');
    assert.equal(byKey.get('profitLossRatio').valueText, '1.35');
  });

  it('缺失指标标注「数据不足」而不是显示 0 或 --', () => {
    const items = buildReportItems(NO_BENCHMARK_METRICS);
    const alpha = items.find((i) => i.key === 'alpha');
    assert.equal(alpha.valueText, null);
    assert.equal(alpha.grade.level, REPORT_LEVELS.UNKNOWN);
    assert.match(alpha.grade.text, /数据不足/);
  });

  it('分档边界：恰好落在门槛上按该档计', () => {
    const items = buildReportItems({ ...STRONG_METRICS, cagr: 15, sharpe: 1, winRate: 55, profitLossRatio: 1.2 });
    const byKey = new Map(items.map((i) => [i.key, i]));
    assert.match(byKey.get('cagr').grade.text, /较高水平/);
    assert.match(byKey.get('sharpe').grade.text, /充分/);
    assert.match(byKey.get('winRate').grade.text, /高于一半/);
    assert.match(byKey.get('profitLossRatio').grade.text, /明显大于/);
    assert.equal(byKey.get('cagr').grade.level, REPORT_LEVELS.POSITIVE);
  });

  it('CVaR 也有判读（否则总览表会出现空判读）', () => {
    const items = buildReportItems(STRONG_METRICS);
    const cvar = items.find((i) => i.key === 'cvar95');
    assert.ok(cvar.grade.text && cvar.grade.text.length > 0);
  });
});

// ── 跨指标组合判读 ────────────────────────────────────────────────────────

describe('buildCrossInsights', () => {
  const texts = (list) => list.map((i) => i.text).join(' | ');

  it('尾部深度：CVaR 比 VaR 深 30% 以上时提示尾部风险', () => {
    const { concerns } = buildCrossInsights({ ...STRONG_METRICS, var95: -2, cvar95: -3.2 }, {});
    assert.match(texts(concerns), /尾部损失/);
    // 深度不足则不提示
    const mild = buildCrossInsights({ ...STRONG_METRICS, var95: -2, cvar95: -2.4 }, {});
    assert.doesNotMatch(texts(mild.concerns), /尾部损失/);
  });

  it('夏普为负 → 明确写出「承担波动未获得补偿」', () => {
    const { concerns } = buildCrossInsights({ ...STRONG_METRICS, sharpe: -0.2 }, {});
    assert.match(texts(concerns), /未获得相应补偿/);
  });

  it('低胜率 + 高盈亏比 → 判为趋势型收益结构（不能只看胜率就下结论）', () => {
    const { highlights, concerns } = buildCrossInsights({ ...STRONG_METRICS, winRate: 44, profitLossRatio: 1.6 }, {});
    assert.match(texts(highlights), /趋势型/);
    assert.doesNotMatch(texts(concerns), /胜率/);
  });

  it('高胜率 + 低盈亏比 → 提示收益容易被少数大跌日抹平', () => {
    const { concerns } = buildCrossInsights({ ...STRONG_METRICS, winRate: 58, profitLossRatio: 0.7 }, {});
    assert.match(texts(concerns), /抹平/);
  });

  it('双正贡献（胜率 ≥50 且盈亏比 ≥1）→ 计入优势', () => {
    const { highlights } = buildCrossInsights({ ...STRONG_METRICS, winRate: 52, profitLossRatio: 1.1 }, {});
    assert.match(texts(highlights), /同时为正贡献/);
  });

  it('有基准时的正超额 / 高 Beta / 低 Beta + 负 Alpha', () => {
    const good = buildCrossInsights(STRONG_METRICS, { benchmark: '沪深300' });
    assert.match(texts(good.highlights), /较稳定的正向超额/);

    const highBeta = buildCrossInsights({ ...STRONG_METRICS, beta: 1.4 }, { benchmark: '沪深300' });
    assert.match(texts(highBeta.concerns), /市场风险敞口大于基准/);

    const lowBetaNegAlpha = buildCrossInsights(
      { ...STRONG_METRICS, beta: 0.6, alpha: -3, informationRatio: -0.4 },
      { benchmark: '沪深300' }
    );
    assert.match(texts(lowBetaNegAlpha.concerns), /既未跟上基准上涨/);
  });

  it('无基准 → 提示主动管理能力无法判断，而不是留空', () => {
    const { concerns } = buildCrossInsights(NO_BENCHMARK_METRICS, { benchmark: null });
    assert.match(texts(concerns), /无法判断主动管理能力/);
  });

  it('深回撤与过短样本都会单独提示', () => {
    assert.match(texts(buildCrossInsights(WEAK_METRICS, { benchmark: '沪深300' }).concerns), /最大回撤/);
    assert.match(
      texts(buildCrossInsights({ ...STRONG_METRICS, sampleCount: 100 }, { benchmark: null }).concerns),
      /不足 1 年/
    );
  });
});

// ── 报告整体 ──────────────────────────────────────────────────────────────

describe('buildFundResearchReport', () => {
  const base = { code: '110022', name: '易方达消费行业股票', generatedAt: '2026-10-15 18:40' };

  it('结构完整：评级 / 结论 / 5 个章节 / 局限 / 免责 / markdown', () => {
    const report = buildFundResearchReport({ ...base, metrics: STRONG_METRICS });
    assert.equal(report.code, '110022');
    assert.equal(report.name, '易方达消费行业股票');
    assert.equal(report.generatedAt, '2026-10-15 18:40');
    assert.equal(report.insufficient, false);
    assert.ok(report.rating.score > 0);
    assert.equal(report.sections.length, 5);
    assert.deepEqual(
      report.sections.map((s) => s.key),
      ['return', 'risk', 'riskAdjusted', 'active', 'trading']
    );
    assert.ok(report.limitations.length >= 5);
    assert.equal(report.disclaimer, REPORT_DISCLAIMER);
    assert.match(report.markdown, /^# 易方达消费行业股票（110022） 调研初步报告/);
    assert.ok(report.benchmark?.name === '沪深300');
  });

  it('区间累计收益由 CAGR 反推，与年化口径自洽', () => {
    const report = buildFundResearchReport({ ...base, metrics: { ...STRONG_METRICS, cagr: 20, sampleCount: 252 } });
    // 一年期：累计收益 == 年化收益
    assert.ok(Math.abs(report.window.totalReturn - 20) < 1e-9);
    const fiveYear = buildFundResearchReport({
      ...base,
      metrics: { ...STRONG_METRICS, cagr: 10, sampleCount: 1260 }
    });
    // 5 年 10% 复利 ≈ 61.05%
    assert.ok(Math.abs(fiveYear.window.totalReturn - 61.051) < 0.01);
  });

  it('章节结论优先暴露风险（劣质基金每一节都指向问题）', () => {
    const report = buildFundResearchReport({ ...base, metrics: WEAK_METRICS });
    for (const section of report.sections) {
      assert.ok(
        [REPORT_LEVELS.WARNING, REPORT_LEVELS.CAUTION].includes(section.level),
        `${section.title} 应给出警示级结论，实际 ${section.level}`
      );
      assert.ok(section.verdict.length > 0);
    }
    assert.ok(report.concerns.length > 0);
  });

  it('无基准：主动管理章节标记为不可用，且局限里说明原因', () => {
    const report = buildFundResearchReport({ ...base, metrics: NO_BENCHMARK_METRICS });
    const active = findSection(report, 'active');
    assert.equal(active.unavailable, true);
    assert.match(active.verdict, /数据不足|无法判读/);
    assert.equal(report.benchmark, null);
    assert.ok(report.limitations.some((t) => /未配置业绩基准/.test(t)));
  });

  it('QDII 基准会追加汇率局限', () => {
    const report = buildFundResearchReport({
      ...base,
      metrics: { ...STRONG_METRICS, benchmarkName: '纳斯达克100' }
    });
    assert.ok(report.limitations.some((t) => /汇率/.test(t)));
  });

  it('数据不足：不给评分、不编造结论，但仍给出解释与免责', () => {
    const report = buildFundResearchReport({ ...base, metrics: INSUFFICIENT_METRICS });
    assert.equal(report.insufficient, true);
    assert.equal(report.rating.score, null);
    assert.match(report.headline, /样本不足/);
    assert.equal(report.highlights.length, 0);
    for (const section of report.sections) {
      assert.equal(section.unavailable, true);
      assert.match(section.verdict, /数据不足/);
    }
    assert.ok(report.markdown.includes(REPORT_DISCLAIMER));
  });

  it('空 / 非法入参不抛异常', () => {
    for (const input of [undefined, {}, { metrics: null }, { metrics: {} }, { metrics: [] }]) {
      const report = buildFundResearchReport(input);
      assert.equal(typeof report.markdown, 'string');
      assert.equal(report.insufficient, true);
    }
  });

  it('确定性：同输入两次生成结果完全一致', () => {
    const first = buildFundResearchReport({ ...base, metrics: STRONG_METRICS });
    const second = buildFundResearchReport({ ...base, metrics: STRONG_METRICS });
    assert.deepEqual(second, first);
  });

  it('无 generatedAt 时不在正文渲染时间行', () => {
    const report = buildFundResearchReport({ ...base, generatedAt: null, metrics: STRONG_METRICS });
    assert.equal(report.generatedAt, null);
    assert.doesNotMatch(report.markdown, /生成时间/);
  });
});

// ── Markdown 导出 ────────────────────────────────────────────────────────

describe('buildReportMarkdown', () => {
  const samples = [
    ['优质 + 有基准', STRONG_METRICS],
    ['劣质 + 有基准', WEAK_METRICS],
    ['无基准', NO_BENCHMARK_METRICS],
    ['数据不足', INSUFFICIENT_METRICS]
  ];

  it('四类样本的 Markdown 都不含 NaN / undefined / null / Infinity', () => {
    for (const [label, metrics] of samples) {
      const report = buildFundResearchReport({ code: '110022', name: '测试基金', metrics });
      assert.doesNotMatch(report.markdown, /NaN|undefined|Infinity|\[object/, `${label} 的 Markdown 含非法占位`);
      assert.doesNotMatch(report.markdown, /\bnull\b/, `${label} 的 Markdown 含 null`);
    }
  });

  it('包含固定章节与免责声明', () => {
    const report = buildFundResearchReport({ code: '110022', name: '测试基金', metrics: STRONG_METRICS });
    for (const heading of ['# ', '## 指标总览', '## 1. 收益能力', '## 5. 交易特征', '## 数据局限']) {
      assert.ok(report.markdown.includes(heading), `缺少 ${heading}`);
    }
    assert.ok(report.markdown.includes(REPORT_DISCLAIMER));
    assert.ok(report.markdown.includes('不构成任何投资建议'));
  });

  it('指标总览是 13 行表格（表头 2 行 + 13 行数据）', () => {
    const report = buildFundResearchReport({ code: '110022', name: '测试基金', metrics: STRONG_METRICS });
    const tableRows = report.markdown.split('\n').filter((line) => line.startsWith('| ') && !line.includes('---'));
    assert.equal(tableRows.length, 14);
  });

  it('空输入返回空串而不是抛异常', () => {
    assert.equal(buildReportMarkdown(null), '');
    assert.equal(buildReportMarkdown(undefined), '');
  });
});

// ── 局限说明 ──────────────────────────────────────────────────────────────

describe('buildLimitations', () => {
  it('固定包含区间 / 无风险利率 / 费用 / 归因 / VaR 假设 / 数据来源', () => {
    const list = buildLimitations(STRONG_METRICS);
    const joined = list.join(' | ');
    assert.match(joined, /统计区间/);
    assert.match(joined, /无风险利率/);
    assert.match(joined, /申购赎回费/);
    assert.match(joined, /单因子|线性回归/);
    assert.match(joined, /历史模拟法/);
    assert.match(joined, /天天基金/);
    assert.match(joined, /货币型与短债型/);
  });

  it('包含「不要跨类型横向比较分数」的口径提醒（债券型风险维度天然满分）', () => {
    const joined = buildLimitations(STRONG_METRICS).join(' | ');
    assert.match(joined, /不要跨类型横向比较/);
  });

  it('无基准时补一条「未配置基准」', () => {
    assert.ok(buildLimitations(NO_BENCHMARK_METRICS).some((t) => /未配置业绩基准/.test(t)));
  });

  it('区间缺失时不产生 undefined 文案', () => {
    const list = buildLimitations({ riskFreeRate: null, startDate: null, endDate: null });
    assert.doesNotMatch(list.join(' '), /undefined|null/);
    assert.match(list.join(' '), /未知区间/);
  });
});

// ── 与弹框的字段契约 ──────────────────────────────────────────────────────

/**
 * FundResearchReportModal 只读这些字段。把它们显式列出来做断言，
 * 是为了让「报告字段改名」在单测里立刻失败，而不是等到用户打开弹框看到空白。
 */
const UI_CONTRACT = [
  ['code', 'string'],
  ['name', 'string'],
  ['generatedAt', 'string'],
  ['insufficient', 'boolean'],
  ['headline', 'string'],
  ['markdown', 'string'],
  ['disclaimer', 'string'],
  ['limitations', 'array'],
  ['highlights', 'array'],
  ['concerns', 'array'],
  ['sections', 'array'],
  ['window.startDate', 'string'],
  ['window.endDate', 'string'],
  ['window.sampleCount', 'number'],
  ['rating.score', 'number'],
  ['rating.label', 'string'],
  ['rating.level', 'string'],
  ['rating.dimensions', 'array'],
  ['benchmark.name', 'string']
];

const readPath = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

/** typeof [] 是 'object'，数组与有限数字要单独判（仓库规范：类型判断走 lodash） */
const typeMatches = (value, type) => {
  if (type === 'array') return isArray(value);
  if (type === 'number') return isNumber(value) && Number.isFinite(value);
  return typeof value === type;
};

describe('报告 → 弹框 字段契约', () => {
  it('弹框读取的每个字段都存在且类型正确', () => {
    const report = buildFundResearchReport({
      code: '110022',
      name: '易方达消费行业股票',
      metrics: STRONG_METRICS,
      generatedAt: '2026-10-15 18:40'
    });
    for (const [path, type] of UI_CONTRACT) {
      const value = readPath(report, path);
      assert.ok(value != null, `弹框需要 ${path}，但报告里是 ${value}`);
      assert.ok(typeMatches(value, type), `${path} 期望 ${type}，实际 ${JSON.stringify(value)}`);
    }
    for (const dimension of report.rating.dimensions) {
      for (const key of ['key', 'title', 'weight']) {
        assert.ok(dimension[key] != null, `rating.dimensions[].${key} 缺失`);
      }
      assert.ok(dimension.score === null || typeof dimension.score === 'number');
    }
    for (const section of report.sections) {
      for (const key of ['key', 'title', 'level', 'verdict']) {
        assert.ok(section[key] != null, `sections[].${key} 缺失`);
      }
      assert.equal(typeof section.unavailable, 'boolean');
      assert.ok(Array.isArray(section.items) && Array.isArray(section.notes));
      for (const item of section.items) {
        for (const key of ['key', 'label', 'valueText', 'grade']) {
          assert.ok(key in item, `sections[].items[].${key} 缺失`);
        }
        assert.ok(item.grade.level && item.grade.text, 'items[].grade 需带 level 与 text');
      }
    }
    for (const list of [report.highlights, report.concerns]) {
      for (const entry of list) {
        assert.ok(entry.level && entry.text, 'highlights/concerns 每项需带 level 与 text');
      }
    }
  });

  it('数据不足时 rating 字段仍存在（只是为 null），弹框无需分支判空', () => {
    const report = buildFundResearchReport({ code: '000001', name: '新基金', metrics: INSUFFICIENT_METRICS });
    assert.ok('score' in report.rating);
    assert.equal(report.rating.score, null);
    assert.equal(report.rating.level, REPORT_LEVELS.UNKNOWN);
    assert.ok(Array.isArray(report.rating.dimensions));
    assert.equal(report.benchmark, null);
  });
});

// ── 真实数据回归护栏 ──────────────────────────────────────────────────────
//
// 下面三份指标是 2026-10 用真实数据（天天基金 pingzhongdata + 东财 push2his 沪深300/纳斯达克100）
// 跑 loadFundMetrics 得到的实际输出快照，用来防止评分/判读逻辑在未来悄悄改变结论方向。
describe('真实基金指标快照（回归护栏）', () => {
  const snapshots = [
    {
      code: '110022',
      name: '易方达消费行业股票',
      expectRating: ['较弱', '偏弱'],
      expectConcerns: [/Alpha/, /未获得相应补偿/],
      metrics: {
        cagr: -11.6401,
        annualizedVolatility: 20.2101,
        maxDrawdown: -49.5975,
        sharpe: -0.6103,
        sortino: -0.874,
        calmar: -0.2347,
        informationRatio: -0.541,
        alpha: -8.452,
        beta: 0.828,
        var95: -1.826,
        cvar95: -2.8031,
        winRate: 44.28,
        profitLossRatio: 0.9143,
        sampleCount: 1285,
        startDate: '2021-06-29',
        endDate: '2026-10-14',
        pairedSampleCount: 1282,
        benchmarkName: '沪深300',
        riskFreeRate: 2,
        insufficient: false
      }
    },
    {
      code: '270042',
      name: '广发纳斯达克100ETF联接人民币(QDII)A',
      expectRating: ['良好', '优秀'],
      expectConcerns: [],
      metrics: {
        cagr: 15.0963,
        annualizedVolatility: 22.431,
        maxDrawdown: -31.203,
        sharpe: 0.6503,
        sortino: 0.9551,
        calmar: 0.4838,
        informationRatio: 0.8406,
        alpha: 5.682,
        beta: 0.984,
        var95: -2.268,
        cvar95: -3.118,
        winRate: 53.15,
        profitLossRatio: 1.14,
        sampleCount: 1285,
        startDate: '2021-06-28',
        endDate: '2026-10-13',
        pairedSampleCount: 1236,
        benchmarkName: '纳斯达克100',
        riskFreeRate: 2,
        insufficient: false
      }
    },
    {
      code: '000001',
      name: '华夏成长混合',
      expectRating: ['偏弱', '均衡'],
      expectConcerns: [/最大回撤/],
      metrics: {
        cagr: -4.008,
        annualizedVolatility: 23.514,
        maxDrawdown: -52.858,
        sharpe: -0.142,
        sortino: -0.201,
        calmar: -0.0758,
        informationRatio: 0.083,
        alpha: 1.081,
        beta: 0.937,
        var95: -2.21,
        cvar95: -3.398,
        winRate: 46.54,
        profitLossRatio: 0.99,
        sampleCount: 1285,
        startDate: '2021-06-29',
        endDate: '2026-10-14',
        pairedSampleCount: 1282,
        benchmarkName: '沪深300',
        riskFreeRate: 2,
        insufficient: false
      }
    }
  ];

  for (const snapshot of snapshots) {
    it(`${snapshot.code} ${snapshot.name}：评级落在预期档位且报告自洽`, () => {
      const report = buildFundResearchReport({
        code: snapshot.code,
        name: snapshot.name,
        metrics: snapshot.metrics,
        generatedAt: '2026-10-15 18:40'
      });
      assert.ok(
        snapshot.expectRating.includes(report.rating.label),
        `${snapshot.code} 评级 ${report.rating.label} 不在预期 ${snapshot.expectRating.join('/')}`
      );
      assert.ok(report.rating.score > 0 && report.rating.score < 100);
      const concernText = report.concerns.map((c) => c.text).join(' | ');
      for (const pattern of snapshot.expectConcerns) {
        assert.match(concernText, pattern, `${snapshot.code} 应包含关注点 ${pattern}`);
      }
      assert.doesNotMatch(report.markdown, /NaN|undefined|\bnull\b/);
    });
  }

  it('110022 的深回撤不会被评成低风险：风险维度得分必须低于 70', () => {
    const report = buildFundResearchReport({
      code: '110022',
      metrics: snapshots[0].metrics
    });
    const risk = report.rating.dimensions.find((d) => d.key === 'risk');
    assert.ok(risk.score < 70, `回撤 -49.6% 时风险维度得分 ${risk.score} 偏高（疑似锚点排序回退）`);
  });
});
