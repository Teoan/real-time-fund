/**
 * 基金调研初步报告生成器
 *
 * 输入是 app/lib/fundMetrics.js 算出的 13 项指标（computeFundMetrics 的返回值），
 * 输出是一份**结构化 + Markdown 双形态**的调研初稿：评级、逐项判读、优势、关注点、数据局限与免责声明。
 * 纯函数、无 I/O、不碰 React，因此可以用 node --test 完整验证。
 *
 * ── 三条设计原则 ────────────────────────────────────────────────────────────
 *
 * 1. **只做历史指标的判读，不做预测，也不给买卖建议。**
 *    规则表里的文案一律停在「历史统计特征」层面（例如「承担波动未获得补偿」），
 *    不出现「建议买入 / 推荐 / 目标价」这类语义。综合结论叫「指标画像评分」而不是「投资评级」。
 *
 * 2. **缺失就是不判读，绝不拿 0 顶替。**
 *    债券/货币型没有基准时，主动管理维度整段标注「无法判断」；
 *    某指标为 null 时该维度按剩余权重归一化（与 computeRiskScore 的取舍一致），
 *    全部维度都缺失时明确返回「数据不足」，而不是给一个看起来很确定的分数。
 *
 * 3. **口径必须写在报告里。** 统计区间只有近 5 年、无风险利率取固定 2%、
 *    Alpha/Beta 是单因子回归、QDII 汇率会进入 Alpha —— 这些都会影响结论，
 *    因此 `limitations` 是报告的固定组成部分，不是可选项。
 */

// lodash 是 CJS 包：必须「默认导入 + 解构」才能被 node --test 直接加载（同 app/lib/valuationHistory.js）
import lodash from 'lodash';

import { DEFAULT_RISK_FREE_RATE, MIN_METRIC_SAMPLES, VAR_CONFIDENCE_LEVEL } from './fundMetrics.js';

const { isArray, isNumber, isObject, isString } = lodash;

/** 数值有效性：lodash 判类型 + 原生判有限值 */
const isFiniteNumber = (v) => isNumber(v) && Number.isFinite(v);

/** 判读等级 → UI 配色键（与 FundMetricsPanel 的配色语义一致） */
export const REPORT_LEVELS = Object.freeze({
  POSITIVE: 'positive',
  NEUTRAL: 'neutral',
  CAUTION: 'caution',
  WARNING: 'warning',
  UNKNOWN: 'unknown'
});

/** 综合评级档位（从高到低） */
export const RATING_BANDS = Object.freeze([
  { min: 80, key: 'strong', label: '优秀', level: REPORT_LEVELS.POSITIVE },
  { min: 65, key: 'good', label: '良好', level: REPORT_LEVELS.POSITIVE },
  { min: 45, key: 'balanced', label: '均衡', level: REPORT_LEVELS.NEUTRAL },
  { min: 30, key: 'weak', label: '偏弱', level: REPORT_LEVELS.CAUTION },
  { min: -Infinity, key: 'fragile', label: '较弱', level: REPORT_LEVELS.WARNING }
]);

/**
 * 各指标的分档门槛（`min` 为下界，按从高到低匹配第一个满足 `value >= min` 的档）。
 * 「越低越好」的指标（波动率 / 回撤 / VaR）同样按 min 降序书写，语义自然成立。
 */
const BANDS = Object.freeze({
  cagr: [
    { min: 15, level: REPORT_LEVELS.POSITIVE, text: '区间年化收益处于较高水平' },
    { min: 8, level: REPORT_LEVELS.POSITIVE, text: '区间年化收益良好' },
    { min: 0, level: REPORT_LEVELS.NEUTRAL, text: '区间年化收益为正但幅度有限' },
    { min: -5, level: REPORT_LEVELS.CAUTION, text: '区间年化收益为负，长期持有未获利' },
    { min: -Infinity, level: REPORT_LEVELS.WARNING, text: '区间年化亏损明显' }
  ],
  annualizedVolatility: [
    { min: 35, level: REPORT_LEVELS.WARNING, text: '净值波动极大，单日大幅起落频繁' },
    { min: 25, level: REPORT_LEVELS.CAUTION, text: '净值波动偏高' },
    { min: 15, level: REPORT_LEVELS.NEUTRAL, text: '净值波动处于中等水平' },
    { min: -Infinity, level: REPORT_LEVELS.POSITIVE, text: '净值波动较低，走势相对平稳' }
  ],
  maxDrawdown: [
    { min: -15, level: REPORT_LEVELS.POSITIVE, text: '区间内回撤较浅' },
    { min: -30, level: REPORT_LEVELS.NEUTRAL, text: '区间内回撤中等' },
    { min: -45, level: REPORT_LEVELS.CAUTION, text: '区间内曾出现较大回撤' },
    { min: -Infinity, level: REPORT_LEVELS.WARNING, text: '区间内回撤很深' }
  ],
  var95: [
    { min: -1.5, level: REPORT_LEVELS.POSITIVE, text: '单日尾部风险温和' },
    { min: -2.5, level: REPORT_LEVELS.NEUTRAL, text: '单日尾部风险中等' },
    { min: -3.5, level: REPORT_LEVELS.CAUTION, text: '单日尾部风险偏重' },
    { min: -Infinity, level: REPORT_LEVELS.WARNING, text: '单日尾部风险很重' }
  ],
  cvar95: [
    { min: -2.5, level: REPORT_LEVELS.POSITIVE, text: '极端单日的平均损失可控' },
    { min: -4, level: REPORT_LEVELS.NEUTRAL, text: '极端单日的平均损失中等' },
    { min: -5.5, level: REPORT_LEVELS.CAUTION, text: '极端单日的平均损失偏大' },
    { min: -Infinity, level: REPORT_LEVELS.WARNING, text: '极端单日的平均损失很大' }
  ],
  sharpe: [
    { min: 1, level: REPORT_LEVELS.POSITIVE, text: '单位总风险的补偿充分' },
    { min: 0.5, level: REPORT_LEVELS.POSITIVE, text: '单位总风险的补偿较好' },
    { min: 0, level: REPORT_LEVELS.NEUTRAL, text: '单位总风险的补偿偏薄' },
    { min: -Infinity, level: REPORT_LEVELS.WARNING, text: '承担波动未获得补偿（低于无风险利率）' }
  ],
  sortino: [
    { min: 1.5, level: REPORT_LEVELS.POSITIVE, text: '下行风险的补偿充分' },
    { min: 0.75, level: REPORT_LEVELS.POSITIVE, text: '下行风险的补偿较好' },
    { min: 0, level: REPORT_LEVELS.NEUTRAL, text: '下行风险的补偿偏薄' },
    { min: -Infinity, level: REPORT_LEVELS.WARNING, text: '下跌波动未获得补偿' }
  ],
  calmar: [
    { min: 0.5, level: REPORT_LEVELS.POSITIVE, text: '年化收益相对最大回撤的性价比高' },
    { min: 0.25, level: REPORT_LEVELS.POSITIVE, text: '年化收益相对最大回撤的性价比尚可' },
    { min: 0, level: REPORT_LEVELS.NEUTRAL, text: '年化收益相对最大回撤的性价比偏低' },
    { min: -Infinity, level: REPORT_LEVELS.WARNING, text: '为获取收益承担的回撤代价过高' }
  ],
  informationRatio: [
    { min: 0.5, level: REPORT_LEVELS.POSITIVE, text: '相对基准有较稳定的主动收益' },
    { min: 0, level: REPORT_LEVELS.NEUTRAL, text: '相对基准的主动收益微弱' },
    { min: -Infinity, level: REPORT_LEVELS.CAUTION, text: '相对基准为负向主动收益' }
  ],
  alpha: [
    { min: 2, level: REPORT_LEVELS.POSITIVE, text: '存在正向超额收益' },
    { min: -2, level: REPORT_LEVELS.NEUTRAL, text: '超额收益接近零' },
    { min: -Infinity, level: REPORT_LEVELS.CAUTION, text: '存在负向超额收益' }
  ],
  beta: [
    { min: 1.2, level: REPORT_LEVELS.CAUTION, text: '市场风险敞口高于基准，涨跌都会被放大' },
    { min: 0.8, level: REPORT_LEVELS.NEUTRAL, text: '市场风险敞口与基准接近' },
    { min: -Infinity, level: REPORT_LEVELS.NEUTRAL, text: '市场风险敞口低于基准，走势相对独立' }
  ],
  winRate: [
    { min: 55, level: REPORT_LEVELS.POSITIVE, text: '上涨交易日占比高于一半' },
    { min: 45, level: REPORT_LEVELS.NEUTRAL, text: '上涨与下跌交易日大致均衡' },
    { min: -Infinity, level: REPORT_LEVELS.CAUTION, text: '上涨交易日占比不足一半' }
  ],
  profitLossRatio: [
    { min: 1.2, level: REPORT_LEVELS.POSITIVE, text: '累计盈利明显大于累计亏损' },
    { min: 0.9, level: REPORT_LEVELS.NEUTRAL, text: '累计盈利与累计亏损相当' },
    { min: -Infinity, level: REPORT_LEVELS.CAUTION, text: '累计亏损大于累计盈利' }
  ]
});

/**
 * 综合画像评分的锚点：[指标值, 得分]，线性插值、超出端点夹紧。
 * 用插值而不是台阶，是为了避免「14.9% 与 15.1% 差一档」这种断崖。
 */
const SCORE_ANCHORS = Object.freeze({
  cagr: [
    [-15, 0],
    [-5, 25],
    [0, 40],
    [8, 65],
    [15, 85],
    [25, 100]
  ],
  annualizedVolatility: [
    [8, 100],
    [15, 85],
    [25, 60],
    [35, 35],
    [45, 15],
    [60, 0]
  ],
  maxDrawdown: [
    [-10, 100],
    [-15, 85],
    [-30, 60],
    [-45, 35],
    [-60, 10],
    [-75, 0]
  ],
  var95: [
    [-1.2, 100],
    [-2, 80],
    [-3, 55],
    [-4, 30],
    [-5, 10]
  ],
  sharpe: [
    [-1, 0],
    [-0.3, 25],
    [0, 40],
    [0.5, 65],
    [1, 85],
    [1.5, 100]
  ],
  sortino: [
    [-1.5, 0],
    [-0.4, 25],
    [0, 40],
    [0.75, 65],
    [1.5, 85],
    [2.5, 100]
  ],
  calmar: [
    [-0.5, 0],
    [-0.1, 25],
    [0, 40],
    [0.25, 65],
    [0.5, 85],
    [1, 100]
  ],
  alpha: [
    [-10, 0],
    [-2, 35],
    [0, 50],
    [2, 65],
    [6, 85],
    [12, 100]
  ],
  informationRatio: [
    [-1, 0],
    [-0.3, 25],
    [0, 40],
    [0.5, 65],
    [1, 85],
    [1.5, 100]
  ]
});

/**
 * 综合评分的四个维度（与「指标」页签的分组一一对应）。
 * 主动管理维度只在有基准（Alpha / 信息比率可用）时参与，缺失时按剩余权重重新归一化。
 */
export const SCORE_DIMENSIONS = Object.freeze([
  {
    key: 'return',
    title: '收益能力',
    weight: 25,
    parts: [{ metric: 'cagr', weight: 1 }]
  },
  {
    key: 'risk',
    title: '风险水平',
    weight: 25,
    parts: [
      { metric: 'annualizedVolatility', weight: 0.4 },
      { metric: 'maxDrawdown', weight: 0.4 },
      { metric: 'var95', weight: 0.2 }
    ]
  },
  {
    key: 'riskAdjusted',
    title: '风险调整后收益',
    weight: 30,
    parts: [
      { metric: 'sharpe', weight: 0.5 },
      { metric: 'sortino', weight: 0.3 },
      { metric: 'calmar', weight: 0.2 }
    ]
  },
  {
    key: 'active',
    title: '主动管理',
    weight: 20,
    parts: [
      { metric: 'alpha', weight: 0.6 },
      { metric: 'informationRatio', weight: 0.4 }
    ]
  }
]);

// ── 小工具 ────────────────────────────────────────────────────────────────

const pct = (value, { digits = 2, signed = false } = {}) => {
  if (!isFiniteNumber(value)) return null;
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
};

const ratio = (value, digits = 2) => (isFiniteNumber(value) ? value.toFixed(digits) : null);

/** 按 min 降序匹配第一个档位；值缺失时返回 UNKNOWN 档 */
const gradeOf = (key, value) => {
  if (!isFiniteNumber(value)) {
    return { level: REPORT_LEVELS.UNKNOWN, text: '数据不足，无法判读' };
  }
  const bands = BANDS[key];
  if (!isArray(bands)) return { level: REPORT_LEVELS.UNKNOWN, text: '' };
  for (const band of bands) {
    if (value >= band.min) return { level: band.level, text: band.text };
  }
  return { level: REPORT_LEVELS.UNKNOWN, text: '' };
};

/** 锚点线性插值 → 0~100 分；值缺失返回 null */
export const scoreOfMetric = (key, value) => {
  if (!isFiniteNumber(value)) return null;
  const anchors = SCORE_ANCHORS[key];
  if (!isArray(anchors) || anchors.length === 0) return null;

  // ⚠️ 锚点允许按「越大越差」书写（最大回撤 / VaR 都是负数且越低越差），
  //    因此**必须先按 x 升序排序再插值**。此处曾漏掉排序：
  //    -49.6% 的最大回撤落进 `value <= anchors[0][0]` 的兜底分支，被评成 100 分（最优），
  //    把整体画像评分整体抬高一个档位。这类「静默给反分」的 bug 由单测钉住
  //    （见 __tests__/fundReport.test.js 的「降序锚点」用例）。
  const sorted = anchors.slice().sort((a, b) => a[0] - b[0]);
  if (value <= sorted[0][0]) return sorted[0][1];
  const last = sorted[sorted.length - 1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < sorted.length; i++) {
    const [x1, y1] = sorted[i];
    const [x0, y0] = sorted[i - 1];
    if (value <= x1) {
      if (x1 === x0) return y1;
      return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** 综合画像评分 + 各维度得分（缺失维度不参与，按剩余权重归一化） */
export const computeProfileScore = (metrics) => {
  if (!isObject(metrics)) return { score: null, label: null, level: REPORT_LEVELS.UNKNOWN, dimensions: [] };

  const dimensions = [];
  for (const dimension of SCORE_DIMENSIONS) {
    const parts = dimension.parts
      .map((part) => ({ ...part, score: scoreOfMetric(part.metric, metrics[part.metric]) }))
      .filter((part) => isFiniteNumber(part.score));
    // 缺分项就不参与该维度，也不补 0 —— 补 0 等于把「没数据」当成「表现差」
    if (parts.length === 0) {
      dimensions.push({ key: dimension.key, title: dimension.title, weight: dimension.weight, score: null });
      continue;
    }
    const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
    const weighted = parts.reduce((sum, part) => sum + part.score * part.weight, 0) / totalWeight;
    dimensions.push({
      key: dimension.key,
      title: dimension.title,
      weight: dimension.weight,
      score: Math.round(clamp(weighted, 0, 100))
    });
  }

  const usable = dimensions.filter((d) => isFiniteNumber(d.score));
  if (usable.length === 0) {
    return { score: null, label: null, level: REPORT_LEVELS.UNKNOWN, dimensions };
  }

  const totalWeight = usable.reduce((sum, d) => sum + d.weight, 0);
  const score = Math.round(clamp(usable.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight, 0, 100));
  const band = RATING_BANDS.find((b) => score >= b.min) || RATING_BANDS[RATING_BANDS.length - 1];

  return { score, label: band.label, level: band.level, key: band.key, dimensions };
};

// ── 指标条目（供报告正文与 Markdown 表格共用） ──────────────────────────────

/**
 * 每个指标在报告中的展示条目。
 * @param {object} metrics
 * @returns {Array<{ key, label, valueText, grade }>}
 */
export const buildReportItems = (metrics) => {
  const m = isObject(metrics) ? metrics : {};
  const defs = [
    { key: 'cagr', label: '年化收益率 (CAGR)', valueText: pct(m.cagr, { signed: true }) },
    { key: 'annualizedVolatility', label: '年化波动率', valueText: pct(m.annualizedVolatility) },
    { key: 'maxDrawdown', label: '最大回撤', valueText: pct(m.maxDrawdown) },
    { key: 'var95', label: 'VaR（单日 95%）', valueText: pct(m.var95) },
    { key: 'cvar95', label: 'CVaR（单日 95%）', valueText: pct(m.cvar95) },
    { key: 'sharpe', label: '夏普比率', valueText: ratio(m.sharpe) },
    { key: 'sortino', label: '索提诺比率', valueText: ratio(m.sortino) },
    { key: 'calmar', label: '卡尔玛比率', valueText: ratio(m.calmar) },
    { key: 'informationRatio', label: '信息比率', valueText: ratio(m.informationRatio) },
    { key: 'alpha', label: 'Alpha', valueText: pct(m.alpha, { signed: true }) },
    { key: 'beta', label: 'Beta', valueText: ratio(m.beta) },
    { key: 'winRate', label: '胜率', valueText: isFiniteNumber(m.winRate) ? `${m.winRate.toFixed(1)}%` : null },
    { key: 'profitLossRatio', label: '盈亏比', valueText: ratio(m.profitLossRatio) }
  ];
  return defs.map((def) => ({
    ...def,
    grade: gradeOf(def.key, m[def.key])
  }));
};

// ── 组合判读（跨指标，不只看单项分档） ────────────────────────────────────

/**
 * 跨指标的组合判读。这些规则才是「调研」相对「指标罗列」的增量：
 * 例如「胜率不足一半 + 盈亏比高」说明收益依赖少数大涨日，单看胜率会误判为差。
 *
 * @returns {{ highlights: Array<{level,text}>, concerns: Array<{level,text}> }}
 */
export const buildCrossInsights = (metrics, { benchmark } = {}) => {
  const m = isObject(metrics) ? metrics : {};
  const highlights = [];
  const concerns = [];

  // 尾部：CVaR 相对 VaR 的深度
  if (isFiniteNumber(m.cvar95) && isFiniteNumber(m.var95) && m.var95 < 0) {
    const depth = m.cvar95 / m.var95;
    if (depth >= 1.5) {
      concerns.push({
        level: REPORT_LEVELS.CAUTION,
        text: `尾部损失的期望值（CVaR ${pct(m.cvar95)}）比 VaR 阈值（${pct(m.var95)}）深 ${((depth - 1) * 100).toFixed(0)}%，说明极端行情下的损失可能明显超出「最常见的糟糕单日」水平`
      });
    }
  }

  // 承担了波动却没跑过无风险利率
  if (isFiniteNumber(m.sharpe) && m.sharpe < 0) {
    const rf = isFiniteNumber(m.riskFreeRate) ? m.riskFreeRate : DEFAULT_RISK_FREE_RATE;
    concerns.push({
      level: REPORT_LEVELS.CAUTION,
      text: `夏普比率为负：区间年化收益低于无风险利率假设（${rf}%），承担净值波动未获得相应补偿`
    });
  }

  // 收益来源特征：胜率 × 盈亏比
  if (isFiniteNumber(m.winRate) && isFiniteNumber(m.profitLossRatio)) {
    if (m.winRate < 50 && m.profitLossRatio >= 1.2) {
      highlights.push({
        level: REPORT_LEVELS.NEUTRAL,
        text: `胜率 ${m.winRate.toFixed(1)}% 不足一半、但盈亏比 ${ratio(m.profitLossRatio)} 较高：收益依赖少数上涨日，特征上更接近趋势型，对错过关键交易日较敏感`
      });
    } else if (m.winRate >= 55 && m.profitLossRatio < 0.9) {
      concerns.push({
        level: REPORT_LEVELS.CAUTION,
        text: `胜率 ${m.winRate.toFixed(1)}% 较高、但盈亏比 ${ratio(m.profitLossRatio)} 偏低：上涨交易日多而单次下跌幅度更大，累计收益容易被少数大跌日抹平`
      });
    } else if (m.winRate >= 50 && m.profitLossRatio >= 1) {
      highlights.push({
        level: REPORT_LEVELS.POSITIVE,
        text: `胜率 ${m.winRate.toFixed(1)}% 与盈亏比 ${ratio(m.profitLossRatio)} 同时为正贡献：上涨交易日更多、单次盈利也更大`
      });
    }
  }

  // 主动管理能力
  if (benchmark) {
    if (isFiniteNumber(m.alpha) && isFiniteNumber(m.informationRatio) && m.alpha >= 2 && m.informationRatio >= 0.5) {
      highlights.push({
        level: REPORT_LEVELS.POSITIVE,
        text: `相对${benchmark}存在较稳定的正向超额：Alpha ${pct(m.alpha, { signed: true })}、信息比率 ${ratio(m.informationRatio)}`
      });
    }
    if (isFiniteNumber(m.alpha) && m.alpha <= -2) {
      concerns.push({
        level: REPORT_LEVELS.CAUTION,
        text: `相对${benchmark}的 Alpha 为 ${pct(m.alpha)}，区间内未创造超额收益`
      });
    }
    if (isFiniteNumber(m.beta) && m.beta > 1.2) {
      concerns.push({
        level: REPORT_LEVELS.CAUTION,
        text: `Beta ${ratio(m.beta)} 高于 1：市场风险敞口大于基准，基准下跌时净值跌幅历史上更大`
      });
    }
    if (isFiniteNumber(m.beta) && isFiniteNumber(m.alpha) && m.beta < 0.8 && m.alpha < 0) {
      concerns.push({
        level: REPORT_LEVELS.WARNING,
        text: `Beta ${ratio(m.beta)} 偏低却同时出现负 Alpha：既未跟上基准上涨，也未创造超额收益`
      });
    }
  } else {
    concerns.push({
      level: REPORT_LEVELS.NEUTRAL,
      text: '未配置业绩基准，信息比率 / Alpha / Beta 不可用，**无法判断主动管理能力**（债券与货币型基金无合适基准，属正常情况）'
    });
  }

  // 回撤的持有体验
  if (isFiniteNumber(m.maxDrawdown) && m.maxDrawdown <= -45) {
    concerns.push({
      level: REPORT_LEVELS.WARNING,
      text: `区间内最大回撤 ${pct(m.maxDrawdown)}：从峰值到谷底的跌幅较深，对持有体验与资金安排的要求较高`
    });
  }

  // 样本长度
  if (isFiniteNumber(m.sampleCount) && m.sampleCount < 252) {
    concerns.push({
      level: REPORT_LEVELS.CAUTION,
      text: `统计样本仅 ${m.sampleCount} 个交易日（不足 1 年），年化类指标的统计意义有限，结论仅供参考`
    });
  }

  return { highlights, concerns };
};

// ── 报告正文 ──────────────────────────────────────────────────────────────

/** 各章节的构成：标题 + 参与的指标 key + 章节结论（取该章内最「值得说」的一条判读） */
const SECTION_DEFS = Object.freeze([
  {
    key: 'return',
    title: '收益能力',
    metricKeys: ['cagr'],
    lead: 'cagr'
  },
  {
    key: 'risk',
    title: '风险水平',
    metricKeys: ['annualizedVolatility', 'maxDrawdown', 'var95', 'cvar95'],
    lead: 'maxDrawdown'
  },
  {
    key: 'riskAdjusted',
    title: '风险调整后收益',
    metricKeys: ['sharpe', 'sortino', 'calmar'],
    lead: 'sharpe'
  },
  {
    key: 'active',
    title: '市场关联与主动管理',
    metricKeys: ['alpha', 'beta', 'informationRatio'],
    lead: 'informationRatio'
  },
  {
    key: 'trading',
    title: '交易特征',
    metricKeys: ['winRate', 'profitLossRatio'],
    lead: 'profitLossRatio'
  }
]);

/** 等级严重度（用于挑章节里最值得说的判读） */
const LEVEL_WEIGHT = {
  [REPORT_LEVELS.WARNING]: 4,
  [REPORT_LEVELS.CAUTION]: 3,
  [REPORT_LEVELS.NEUTRAL]: 2,
  [REPORT_LEVELS.POSITIVE]: 1,
  [REPORT_LEVELS.UNKNOWN]: 0
};

/**
 * 章节结论：优先展示「最需要注意」的一条，全部达标时才展示最好的一条。
 * 这样报告读起来是「先看风险」的研究习惯，而不是先自夸。
 */
const pickVerdict = (items) => {
  const graded = items.filter((item) => isString(item.grade?.text) && item.grade.text);
  if (graded.length === 0) return { level: REPORT_LEVELS.UNKNOWN, text: '数据不足，无法判读' };
  const sorted = graded.slice().sort((a, b) => (LEVEL_WEIGHT[b.grade.level] || 0) - (LEVEL_WEIGHT[a.grade.level] || 0));
  const worst = sorted[0];
  const worstWeight = LEVEL_WEIGHT[worst.grade.level] || 0;
  const best = sorted[sorted.length - 1];
  const chosen = worstWeight >= LEVEL_WEIGHT[REPORT_LEVELS.CAUTION] ? worst : best;
  return { level: chosen.grade.level, text: chosen.grade.text, from: chosen.label };
};

/** 各章节的口径说明（固定出现，避免用户拿错口径去比较） */
const SECTION_NOTES = Object.freeze({
  return: [
    '年化收益率 (CAGR) 为几何平均，已把区间总收益折算成「每年复利多少」，与页面显示的区间累计收益不是同一个数。'
  ],
  risk: [
    '年化波动率 = 日收益率标准差 × √252，衡量净值起伏幅度，不含方向。',
    '最大回撤是统计区间内「峰值到谷底」的最大跌幅，历史上出现过一次即计入。',
    `VaR / CVaR 为历史模拟法的单日 ${Math.round(VAR_CONFIDENCE_LEVEL * 100)}% 置信口径：VaR 是「最差的 5% 单日」的门槛值，CVaR 是这些糟糕单日的平均损失。`
  ],
  riskAdjusted: [
    '夏普看「单位总波动换来多少收益」，索提诺只看下行波动（对上涨不惩罚），卡尔玛对齐最大回撤。',
    '三者都扣除了无风险利率，因此无风险利率假设（见文末局限）会同时影响这三个比率。'
  ],
  active: [
    'Alpha / Beta / 信息比率均相对报告末尾标注的业绩基准计算，采用单因子 CAPM 回归，未做多因子与风格归因。',
    'Beta 反映的是历史联动性：Beta 0.8 大致意味着基准下跌 10% 时，该基金历史上平均下跌约 8%（统计平均，非承诺）。'
  ],
  trading: [
    '胜率 = 上涨交易日占全部有效交易日的比例；盈亏比 = 区间内正收益之和 ÷ 负收益绝对值之和。',
    '两个指标要一起看：高胜率 + 低盈亏比与低胜率 + 高盈亏比是两类完全不同的收益结构。'
  ]
});

/** 固定列入报告的局限与免责（口径透明度是这份报告的一部分） */
export const buildLimitations = (metrics) => {
  const m = isObject(metrics) ? metrics : {};
  const rf = isFiniteNumber(m.riskFreeRate) ? m.riskFreeRate : DEFAULT_RISK_FREE_RATE;
  const window = m.startDate && m.endDate ? `${m.startDate} ~ ${m.endDate}` : '未知区间';
  const list = [
    `统计区间为 ${window}（近 5 年，受本地净值缓存保留窗口限制），**不是成立以来**；区间不同结论可能不同。`,
    `无风险利率取固定 ${rf}%（年化），夏普 / 索提诺 / Alpha 对其敏感；不同利率假设会得到不同的比率。`,
    '指标基于日频复权收益计算，未计入申购赎回费、管理费外的税费与个人持仓成本（如持有期不同的实际收益差异）。',
    'Alpha / Beta 是相对单一基准的线性回归结果，未做多因子、行业与风格归因，也不代表基金经理的真实能力来源。',
    'VaR / CVaR 为历史模拟法，隐含「未来与样本区间分布相似」的假设；实际极端损失可能超过该值。',
    '数据来自天天基金 / 东方财富公开接口，可能存在口径差异或偶发缺失。'
  ];
  if (!m.benchmarkName) {
    list.push('该基金未配置业绩基准（债券 / 货币型基金无合适基准），主动管理能力无法评估。');
  }
  list.push(
    '货币型与短债型基金的收益可能本就低于无风险利率假设，其夏普 / 索提诺会天然为负——这是口径问题，不代表产品异常。'
  );
  list.push(
    '画像评分用的是全类型统一锚点，未按基金类型分组校准：债券型 / 货币型在风险维度天然接近满分，因此**不要跨类型横向比较分数**（股票型与债券型的「80 分」不是一回事）。'
  );
  if (isString(m.benchmarkName) && /标普|纳斯达克|恒生/.test(m.benchmarkName)) {
    list.push('QDII 基金以人民币计价、基准为境外指数，汇率变动会被计入 Alpha 与信息比率，本报告未做汇率中性化。');
  }
  return list;
};

export const REPORT_DISCLAIMER =
  '本报告由固定规则基于公开历史数据自动生成，仅用于投研初筛，**不构成任何投资建议**，也不预测未来涨跌。指标反映的是历史统计特征，历史表现不代表未来收益。';

/**
 * 生成调研初步报告。
 *
 * @param {object} input
 * @param {string} [input.code] 基金代码
 * @param {string} [input.name] 基金名称
 * @param {object} input.metrics computeFundMetrics 的返回值
 * @param {string} [input.generatedAt] 生成时间（调用方注入，便于测试确定性；缺省不显示具体时间）
 * @returns {object} 报告对象（含 markdown 全文）
 */
export const buildFundResearchReport = ({ code = '', name = '', metrics, generatedAt = null } = {}) => {
  const m = isObject(metrics) ? metrics : {};
  const items = buildReportItems(m);
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  const benchmarkName = isString(m.benchmarkName) && m.benchmarkName ? m.benchmarkName : null;

  const limitations = buildLimitations(m);
  const insufficient =
    m.insufficient === true ||
    !isFiniteNumber(m.sampleCount) ||
    m.sampleCount < MIN_METRIC_SAMPLES ||
    items.every((item) => item.valueText == null);

  const rating = computeProfileScore(m);
  const { highlights, concerns } = buildCrossInsights(m, { benchmark: benchmarkName });

  // 区间累计收益由 CAGR 反推（与 CAGR 定义互为逆运算，不引入额外口径）
  const totalReturn =
    isFiniteNumber(m.cagr) && isFiniteNumber(m.sampleCount) && m.sampleCount > 0
      ? (Math.pow(1 + m.cagr / 100, m.sampleCount / 252) - 1) * 100
      : null;

  const window = {
    startDate: isString(m.startDate) ? m.startDate : null,
    endDate: isString(m.endDate) ? m.endDate : null,
    sampleCount: isFiniteNumber(m.sampleCount) ? m.sampleCount : null,
    totalReturn,
    years: isFiniteNumber(m.sampleCount) ? m.sampleCount / 252 : null
  };

  const sections = SECTION_DEFS.map((def) => {
    const sectionItems = def.metricKeys.map((key) => itemByKey.get(key)).filter(Boolean);
    const verdict = pickVerdict(sectionItems);
    const available = sectionItems.filter((item) => item.valueText != null);
    return {
      key: def.key,
      title: def.title,
      level: verdict.level,
      verdict: verdict.text,
      verdictFrom: verdict.from || null,
      items: sectionItems,
      notes: SECTION_NOTES[def.key] || [],
      /** 该章节是否完全无数据（如无基准时的主动管理） */
      unavailable: available.length === 0,
      /** 该章节是「部分可判读」还是「全部可判读」 */
      partial: available.length > 0 && available.length < sectionItems.length
    };
  });

  const headline = insufficient
    ? '净值样本不足，暂无法生成判读结论'
    : [
        `区间 ${pct(totalReturn, { signed: true })}（年化 ${pct(m.cagr, { signed: true })}）`,
        isFiniteNumber(m.maxDrawdown) ? `最大回撤 ${pct(m.maxDrawdown)}` : null,
        isFiniteNumber(rating.score) ? `指标画像评分 ${rating.score}/100（${rating.label}）` : null
      ]
        .filter(Boolean)
        .join('，');

  const report = {
    code: isString(code) ? code.trim() : '',
    name: isString(name) ? name.trim() : '',
    generatedAt: isString(generatedAt) && generatedAt ? generatedAt : null,
    insufficient,
    window,
    benchmark: benchmarkName
      ? { name: benchmarkName, pairedSampleCount: isFiniteNumber(m.pairedSampleCount) ? m.pairedSampleCount : null }
      : null,
    riskFreeRate: isFiniteNumber(m.riskFreeRate) ? m.riskFreeRate : DEFAULT_RISK_FREE_RATE,
    rating,
    headline,
    items,
    sections,
    highlights,
    concerns,
    limitations,
    disclaimer: REPORT_DISCLAIMER
  };

  return { ...report, markdown: buildReportMarkdown(report) };
};

// ── Markdown 导出 ────────────────────────────────────────────────────────

const LEVEL_TAG = {
  [REPORT_LEVELS.POSITIVE]: '✅',
  [REPORT_LEVELS.NEUTRAL]: '➖',
  [REPORT_LEVELS.CAUTION]: '⚠️',
  [REPORT_LEVELS.WARNING]: '⛔',
  [REPORT_LEVELS.UNKNOWN]: '❔'
};

/**
 * 报告对象 → Markdown 全文（供「复制」按钮粘贴进自己的研究文档）。
 * @param {object} report buildFundResearchReport 的返回值（不含 markdown 字段也可）
 */
export const buildReportMarkdown = (report) => {
  if (!isObject(report)) return '';
  const lines = [];
  const title = report.name ? `${report.name}（${report.code || '—'}）` : report.code || '基金';
  lines.push(`# ${title} 调研初步报告`);
  lines.push('');
  if (report.generatedAt) lines.push(`> 生成时间：${report.generatedAt}`);
  const w = report.window || {};
  lines.push(
    `> 统计区间：${w.startDate || '—'} ~ ${w.endDate || '—'}` +
      `${isFiniteNumber(w.sampleCount) ? `（${w.sampleCount} 个交易日）` : ''}` +
      `${isFiniteNumber(report.riskFreeRate) ? ` · 无风险利率假设 ${report.riskFreeRate}%` : ''}` +
      `${report.benchmark?.name ? ` · 业绩基准 ${report.benchmark.name}` : ' · 业绩基准 无'}`
  );
  lines.push('');
  lines.push(`**一句话结论**：${report.headline || '—'}`);
  lines.push('');
  if (isFiniteNumber(report.rating?.score)) {
    lines.push(
      `**指标画像评分**：${report.rating.score}/100（${report.rating.label}）` +
        `　维度：${(report.rating.dimensions || [])
          .filter((d) => isFiniteNumber(d.score))
          .map((d) => `${d.title} ${d.score}`)
          .join(' / ')}`
    );
    lines.push('');
  }

  lines.push('## 指标总览');
  lines.push('');
  lines.push('| 指标 | 数值 | 判读 |');
  lines.push('| --- | --- | --- |');
  for (const item of report.items || []) {
    lines.push(`| ${item.label} | ${item.valueText ?? '—'} | ${item.grade?.text || '—'} |`);
  }
  lines.push('');

  for (const [index, section] of (report.sections || []).entries()) {
    lines.push(`## ${index + 1}. ${section.title}`);
    lines.push('');
    lines.push(`${LEVEL_TAG[section.level] || ''} **结论**：${section.verdict || '—'}`);
    lines.push('');
    const availableItems = (section.items || []).filter((item) => item.valueText != null);
    if (availableItems.length > 0) {
      lines.push(availableItems.map((item) => `\`${item.label} ${item.valueText}\``).join('　'));
      lines.push('');
    }
    if (section.unavailable) {
      lines.push('- 该章节无可用指标（多为缺少业绩基准），未做判读。');
      lines.push('');
    }
    for (const note of section.notes || []) {
      lines.push(`- ${note}`);
    }
    if ((section.notes || []).length > 0) lines.push('');
  }

  if ((report.highlights || []).length > 0) {
    lines.push('## 值得关注的优势');
    lines.push('');
    for (const item of report.highlights) lines.push(`- ${LEVEL_TAG[item.level] || ''} ${item.text}`);
    lines.push('');
  }
  if ((report.concerns || []).length > 0) {
    lines.push('## 需要留意的风险与限制');
    lines.push('');
    for (const item of report.concerns) lines.push(`- ${LEVEL_TAG[item.level] || ''} ${item.text}`);
    lines.push('');
  }

  lines.push('## 数据局限');
  lines.push('');
  for (const text of report.limitations || []) lines.push(`- ${text}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(report.disclaimer || REPORT_DISCLAIMER);
  lines.push('');
  return lines.join('\n');
};
