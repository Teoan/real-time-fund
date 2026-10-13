/**
 * 基金波动信号引擎（V1）
 *
 * 定位：只做「指标计算 + 信号判定 + 状态归并」，不做 I/O、不碰 React、不写缓存。
 * 输入是净值序列，输出是可直接渲染的波动画像，因此可以用 node --test 纯函数验证。
 *
 * 口径说明（V1 的既定假设，集中在本文件顶部常量，便于后续调参）：
 *
 *   1. 年化系数 252 个交易日；波动率 = 日收益率标准差（样本标准差 n-1）× √252，单位 %。
 *   2. 「N 日波动率」取最近 N 个日收益率；「N 日最大回撤」取最近 N+1 个净值点
 *      （两者覆盖同一段时间区间，避免两个指标的口径长度不一致）。
 *   3. 「20 日波动率历史分位」的参照分布 = 近 5 年（5 × 252 ≈ 1260 个交易日）的
 *      滚动 20 日波动率序列；样本不足 30 个时不给分位
 *      （与 app/api/fund.js 的 MIN_PERCENTILE_SAMPLES 口径一致，
 *      避免「用 5 个样本排出 95% 分位」这种失真）。
 *   4. 日收益率优先用上游给的 equityReturn（天天基金「日增长率」，本身就是复权口径）；
 *      缺失时按「(今日累计净值 − 昨日累计净值) ÷ 昨日单位净值」还原；
 *      最后才回落单位净值环比。
 *      ⚠️ 实测结论（2026-10，见 __tests__/fundVolatility.test.js 的回归护栏）：
 *        - 天天基金的 Data_ACWorthTrend（累计净值）是「单位净值 + 累计分红」的**绝对额相加**，
 *          不是复权净值指数。直接取它的百分比变化会把收益率严重低估
 *          （161725 实测被稀释到约 1/4），必须用绝对额之差除以昨日单位净值。
 *        - 裸用单位净值环比会在分红/拆分日砸出假暴跌（000171 实测 -13.25%，真实仅 -0.14%）。
 *   5. 回撤算在**复权收益指数**上（由日收益率逐日复利而成），而不是任何单一净值字段：
 *      单位净值在分红日不连续、累计净值的百分比变化又不是收益率，两者都算不对回撤。
 *   6. 「当前回撤」的参照高点是近 60 个交易日内的最高指数值
 *      （用这个口径，示例里「当前回撤 -6.7% / 20 日最大回撤 -8.3%」才自洽：
 *       最差的那一天在近 20 日内，而当前已经从那里回来了一部分）。
 *
 * 本版本不预测涨跌，也不产生买卖建议。
 */

// lodash 是 CJS 包，Node 的 ESM 加载器解析不了命名导出，
// 用「默认导入 + 解构」才能让本模块被 node --test 直接加载（同 app/lib/valuationHistory.js）。
import lodash from 'lodash';

import { computePercentile } from './valuationEngine.js';

const { isArray, isNumber, isObject, isString } = lodash;

/** 年化系数：A 股一年约 252 个交易日 */
export const TRADING_DAYS_PER_YEAR = 252;

/** 短期波动率窗口（日） */
export const SHORT_VOLATILITY_WINDOW = 5;
/** 主要波动率窗口（日） */
export const MAIN_VOLATILITY_WINDOW = 20;
/** 中期波动率窗口（日） */
export const MID_VOLATILITY_WINDOW = 60;

/** 历史分位的参照窗口（年） */
export const PERCENTILE_WINDOW_YEARS = 5;
/** 历史分位所需的最少样本数（与 app/api/fund.js 保持一致） */
export const MIN_PERCENTILE_SAMPLES = 30;

/** 「当前回撤」的参照高点回看窗口（交易日） */
export const CURRENT_DRAWDOWN_LOOKBACK = 60;

/** 信号阈值（业务可调） */
export const SIGNAL_THRESHOLDS = Object.freeze({
  /** 20 日波动率分位 ≥ 该值 → 高波动 */
  HIGH_VOLATILITY_PERCENTILE: 80,
  /** 20 日波动率分位 ≥ 该值 → 极端波动 */
  EXTREME_VOLATILITY_PERCENTILE: 95,
  /** 5 日/20 日波动率 ≥ 该值 → 波动扩大 */
  VOLATILITY_EXPANDING_RATIO: 1.15,
  /** 5 日/20 日波动率 ≥ 该值 → 波动快速扩大 */
  VOLATILITY_EXPANDING_FAST_RATIO: 1.3,
  /** 20 日最大回撤 ≤ 该值（%） → 较大回撤（规格 §5 既定） */
  LARGE_DRAWDOWN_20D: -8,
  /**
   * 60 日最大回撤 ≤ 该值（%） → 中期回撤加深
   * V1 自定：规格只定义了 20 日口径，但 20 日窗口看不到「跌了两个月」的阴跌，
   * 只靠它会让「阴跌 15% 但近 20 日平稳」的基金显示成「正常」。
   */
  DEEP_DRAWDOWN_60D: -12,
  /**
   * 当前回撤 ≤ 该值（%） → 当前仍深套
   * V1 自定：回撤可能发生在 20~60 日之前并已走平（此时 20 日最大回撤接近 0），
   * 但用户仍然亏着——这一维度必须能单独触发状态，否则又是「正常 + 亏 15%」。
   */
  DEEP_CURRENT_DRAWDOWN: -12
});

/**
 * 风险评分缺分位时的绝对波动率兜底上限（%）：
 * 年化波动率 25% 即视为「满分风险」。仅用于分位样本不足的新基金。
 */
export const ABSOLUTE_VOLATILITY_CEILING = 25;
/** 20 日最大回撤达到 -15% 即视为「回撤维度满分」 */
export const DRAWDOWN_CEILING = 15;
/** 当前回撤达到 -12% 即视为「当前回撤维度满分」 */
export const CURRENT_DRAWDOWN_CEILING = 12;

/** 综合波动状态 */
export const VOLATILITY_STATES = Object.freeze({
  NORMAL: '正常',
  EXPANDING: '波动扩大',
  /** 回撤类状态：波动不高但已出现实质性回撤（V1 新增，规格 §6 未定义） */
  DRAWDOWN_DEEP: '回撤加深',
  HIGH: '高波动',
  EXTREME: '极端波动',
  HIGH_WITH_DRAWDOWN: '高波动 + 较大回撤',
  /** 净值样本不足，无法判断（V1 新增，规格未定义但必需） */
  INSUFFICIENT: '数据不足'
});

/** 状态 → 展示等级，供 UI 映射颜色 */
export const VOLATILITY_STATE_LEVELS = Object.freeze({
  [VOLATILITY_STATES.NORMAL]: 'normal',
  [VOLATILITY_STATES.EXPANDING]: 'warn',
  [VOLATILITY_STATES.DRAWDOWN_DEEP]: 'warn',
  [VOLATILITY_STATES.HIGH]: 'warn',
  [VOLATILITY_STATES.EXTREME]: 'danger',
  [VOLATILITY_STATES.HIGH_WITH_DRAWDOWN]: 'danger',
  [VOLATILITY_STATES.INSUFFICIENT]: 'muted'
});

/**
 * 状态严重度排序（越大越严重）。唯一用途是让 UI/测试可以比较两个状态的轻重，
 * 避免各处再手写一遍顺序。
 *
 * 排序依据：已实现的回撤（回撤加深）比「短期波动刚开始扩大」更实在，
 * 但比「波动率处于历史高位」轻——后者意味着未来继续大幅波动的概率更高。
 *
 *   正常 < 波动扩大 < 回撤加深 < 高波动 < 高波动+较大回撤 < 极端波动
 *
 * 「数据不足」给 -1：它不是「比正常更轻」，而是不可比，比较时应当显式排除。
 */
export const VOLATILITY_STATE_SEVERITY = Object.freeze({
  [VOLATILITY_STATES.INSUFFICIENT]: -1,
  [VOLATILITY_STATES.NORMAL]: 0,
  [VOLATILITY_STATES.EXPANDING]: 1,
  [VOLATILITY_STATES.DRAWDOWN_DEEP]: 2,
  [VOLATILITY_STATES.HIGH]: 3,
  [VOLATILITY_STATES.HIGH_WITH_DRAWDOWN]: 4,
  [VOLATILITY_STATES.EXTREME]: 5
});

/** 信号族：同一族内只展示最强的一条，避免「扩大」与「快速扩大」同时刷屏 */
export const SIGNAL_FAMILIES = Object.freeze({
  VOL_LEVEL: 'volLevel',
  VOL_TREND: 'volTrend',
  DRAWDOWN: 'drawdown'
});

/**
 * 信号定义表。
 *
 * - `family`：仅用于展示分组与排序。
 * - `group`：**互斥组**。同一组内只保留 severity 最高的一条（UI 用 pickPrimarySignals 去重）。
 *   只有「同一维度的不同档位」才共享 group（如分位 80% 与 95%）。
 *   回撤的三个信号是三个不同维度（近期急跌 / 中期阴跌 / 当前深套），
 *   必须各自成组，否则会互相遮蔽——「近期存在较大回撤」会被藏掉。
 * - `severity`：同组内取最强，level 供 UI 上色。文案与规格 §7 的示例保持一致。
 */
export const SIGNAL_DEFS = Object.freeze({
  extremeVolatility: {
    family: SIGNAL_FAMILIES.VOL_LEVEL,
    group: 'volLevel',
    level: 'danger',
    severity: 2,
    label: '波动率处于极端高位'
  },
  highVolatility: {
    family: SIGNAL_FAMILIES.VOL_LEVEL,
    group: 'volLevel',
    level: 'warn',
    severity: 1,
    label: '波动率处于历史高位'
  },
  volatilityExpandingFast: {
    family: SIGNAL_FAMILIES.VOL_TREND,
    group: 'volTrend',
    level: 'danger',
    severity: 2,
    label: '短期波动快速扩大'
  },
  volatilityExpanding: {
    family: SIGNAL_FAMILIES.VOL_TREND,
    group: 'volTrend',
    level: 'warn',
    severity: 1,
    label: '短期波动扩大'
  },
  largeDrawdown: {
    family: SIGNAL_FAMILIES.DRAWDOWN,
    group: 'drawdownRecent',
    level: 'warn',
    severity: 1,
    label: '近期存在较大回撤'
  },
  deepDrawdown: {
    family: SIGNAL_FAMILIES.DRAWDOWN,
    group: 'drawdownMid',
    level: 'warn',
    severity: 2,
    label: '中期回撤加深'
  },
  deepCurrentDrawdown: {
    family: SIGNAL_FAMILIES.DRAWDOWN,
    group: 'drawdownCurrent',
    level: 'warn',
    severity: 2,
    label: '当前仍处于深度回撤'
  }
});

/**
 * 回撤族的信号键集合。
 *
 * 单一事实来源：状态归并（isDrawdownSignal）与 UI 的族内取最强都依赖它，
 * 避免将来新增一个回撤信号却漏改状态机——那正是「正常 + 较大回撤」这类
 * 自相矛盾展示的成因。
 */
export const DRAWDOWN_SIGNAL_KEYS = Object.freeze(['largeDrawdown', 'deepDrawdown', 'deepCurrentDrawdown']);

/**
 * 命中集合里是否存在任意回撤类信号。
 * @param {Set<string>|Array<string>} keys
 */
const hasAnyDrawdown = (keys) => {
  const set = keys instanceof Set ? keys : new Set(keys || []);
  for (const key of DRAWDOWN_SIGNAL_KEYS) {
    if (set.has(key)) return true;
  }
  return false;
};

/** 同族内取最强时的稳定顺序 */
const SIGNAL_FAMILY_ORDER = [SIGNAL_FAMILIES.VOL_LEVEL, SIGNAL_FAMILIES.VOL_TREND, SIGNAL_FAMILIES.DRAWDOWN];

/** 数值有效性：lodash 判类型 + 原生判有限值（NaN/Infinity 一律视为缺失） */
const isFiniteNumber = (v) => isNumber(v) && Number.isFinite(v);

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** 从一行里取第一个有限数值（用于累计净值 → 单位净值回落） */
const firstFinite = (...values) => {
  for (const v of values) {
    if (isFiniteNumber(v)) return v;
  }
  return null;
};

/**
 * 归一化净值序列。
 *
 * 同时接受两种输入，便于调用方直接把 app/api/fund.js 的返回丢进来：
 *   - 原始行（fetchFundHistory）：{ date, unitNetValue, accumulatedNetValue, equityReturn }
 *   - 已归一化行：{ date, unitNav, accumulatedNav, dailyReturn }
 *
 * 处理：按日期升序、同日去重（保留后出现的）、补齐 dailyReturn。
 *
 * @param {Array<object>} rows
 * @returns {Array<{ date: string, unitNav: number|null, accumulatedNav: number|null, dailyReturn: number|null }>}
 */
export const normalizeNavSeries = (rows) => {
  if (!isArray(rows)) return [];

  const byDate = new Map();
  for (const row of rows) {
    if (!isObject(row)) continue;
    const date = isString(row.date) ? row.date.trim() : '';
    if (!date) continue;
    const unitNav = firstFinite(row.unitNav, row.unitNetValue, row.value);
    const accumulatedNav = firstFinite(row.accumulatedNav, row.accumulatedNetValue);
    const declaredReturn = firstFinite(row.dailyReturn, row.equityReturn);
    if (unitNav == null && accumulatedNav == null) continue;
    byDate.set(date, { date, unitNav, accumulatedNav, dailyReturn: declaredReturn });
  }

  const sorted = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 补 dailyReturn。优先级见文件头说明：
  //   1. 上游 equityReturn（复权口径，实测与口径 2 平均偏差仅 0.002%）
  //   2. (今日累计净值 − 昨日累计净值) ÷ 昨日单位净值
  //   3. 单位净值环比（分红/拆分日会造出假暴跌，仅作最后手段）
  return sorted.map((row, i) => {
    if (isFiniteNumber(row.dailyReturn) || i === 0) return row;
    const prev = sorted[i - 1];
    const prevUnit = isFiniteNumber(prev.unitNav) ? prev.unitNav : null;
    if (prevUnit == null || prevUnit <= 0) return row;

    if (isFiniteNumber(row.accumulatedNav) && isFiniteNumber(prev.accumulatedNav)) {
      return { ...row, dailyReturn: ((row.accumulatedNav - prev.accumulatedNav) / prevUnit) * 100 };
    }
    if (isFiniteNumber(row.unitNav)) {
      return { ...row, dailyReturn: (row.unitNav / prevUnit - 1) * 100 };
    }
    return row;
  });
};

/**
 * 合并新旧净值序列：按日期求并集，新数据覆盖旧数据，输出升序。
 *
 * 这是规格 §3「必要时从 AKTools 补充最新数据」的落地方式：
 * 净值源（天天基金 pingzhongdata / AKTools fund_open_fund_info_em）给出的都是整段历史，
 * 所以「补充最新」= 重取一次再与本地缓存求并集，而不是按日期逐个补点。
 *
 * @param {Array<object>} existing 本地缓存
 * @param {Array<object>} incoming 最新拉取
 * @returns {Array<object>} 归一化后的升序序列
 */
export const mergeNavSeries = (existing, incoming) => {
  const merged = new Map();
  for (const rows of [existing, incoming]) {
    if (!isArray(rows)) continue;
    for (const row of normalizeNavSeries(rows)) {
      merged.set(row.date, row);
    }
  }
  return Array.from(merged.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};

/**
 * 裁剪净值序列，只保留最近 N 条。
 *
 * IndexedDB 容量虽然远大于 localStorage，但也没必要为了「近 5 年分位 + 60 日回撤」
 * 把一只基金 15 年的日频净值全存下来（每天都有写入，白白放大存储与序列化开销）。
 *
 * @param {Array<object>} rows 升序序列
 * @param {number} limit
 * @returns {Array<object>}
 */
export const trimNavSeries = (rows, limit) => {
  if (!isArray(rows)) return [];
  if (!isFiniteNumber(limit) || limit <= 0 || rows.length <= limit) return rows.slice();
  return rows.slice(-limit);
};

/**
 * 构造「复权收益指数」序列，供回撤计算使用。
 *
 * 为什么不直接拿某个净值字段当价格序列：
 *   - 单位净值：分红除权日会凭空下跌（实测 000171 某日 -13.25%，当日真实仅 -0.14%），
 *     用它算回撤会砸出根本不存在的深坑。
 *   - 累计净值（Data_ACWorthTrend）：是「单位净值 + 累计分红」的**绝对额相加**，
 *     不是复权净值指数，其百分比变化被严重稀释（实测 161725 的当前回撤只剩 1/4）。
 *
 * 因此改为把日收益率逐日复利成指数：index(t) = index(t-1) × (1 + 日收益率(t))。
 * 该指数在分红/拆分日保持连续，正是回撤应有的口径。
 *
 * 首元素固定为 1，代表「起点日」——这样返回数组的长度等于净值点数（收益率数 + 1），
 * 调用方仍可按「N 日回撤 = 最近 N+1 个点」来取值，与改动前的窗口语义一致。
 *
 * @param {Array<{ dailyReturn: number|null }>} series 升序序列
 * @returns {number[]} 复权指数（升序，首元素为 1）
 */
const buildAdjustedIndex = (series) => {
  const out = [1];
  let index = 1;
  for (const row of series) {
    if (!isFiniteNumber(row.dailyReturn)) continue;
    index *= 1 + row.dailyReturn / 100;
    // 数据异常（-100% 以下或非有限）时停在已算出的部分，不产出负指数污染回撤
    if (!Number.isFinite(index) || index <= 0) return out;
    out.push(index);
  }
  return out;
};

/** 取日收益率数值序列（升序）。缺口产生的 null 会被剔除。 */
const returnSeriesOf = (series) => series.map((r) => r.dailyReturn).filter(isFiniteNumber);

/**
 * 样本标准差年化。
 * @param {number[]} values 日收益率（%）
 * @returns {number|null} 年化波动率（%）
 */
export const annualizeVolatility = (values) => {
  if (!isArray(values) || values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
};

/**
 * 滚动波动率序列（升序），第 j 项对应「以 returns[j] 结尾的 window 日窗口」。
 * @param {number[]} returns 日收益率（%，升序）
 * @param {number} window
 * @returns {number[]}
 */
export const computeRollingVolatilitySeries = (returns, window) => {
  if (!isArray(returns) || !isFiniteNumber(window) || window < 2) return [];
  const out = [];
  for (let i = window - 1; i < returns.length; i++) {
    out.push(annualizeVolatility(returns.slice(i - window + 1, i + 1)));
  }
  return out.filter(isFiniteNumber);
};

/**
 * 最近 window 个日收益率的年化波动率。
 * @param {number[]} returns
 * @param {number} window
 * @returns {number|null}
 */
export const computeRollingVolatility = (returns, window) => {
  if (!isArray(returns) || !isFiniteNumber(window) || returns.length < window || window < 2) return null;
  return annualizeVolatility(returns.slice(-window));
};

/**
 * 最大回撤（负数百分比）。窗口按「净值点个数」计。
 * @param {number[]} navSeries 净值（升序）
 * @param {number} [points] 回看净值点数，缺省用全序列
 * @returns {number|null} 例如 -8.3 表示 -8.3%
 */
/**
 * 最大回撤（负数百分比）。窗口按「序列点个数」计。
 *
 * ⚠️ 入参应当是 buildAdjustedIndex 产出的**复权收益指数**，
 *    不要直接传单位净值或累计净值（原因见 buildAdjustedIndex 的注释）。
 *
 * @param {number[]} series 价格/指数序列（升序）
 * @param {number} [points] 回看点数，缺省用全序列
 * @returns {number|null} 例如 -8.3 表示 -8.3%
 */
export const computeMaxDrawdown = (navSeries, points) => {
  if (!isArray(navSeries) || navSeries.length < 2) return null;
  const slice =
    isFiniteNumber(points) && points > 0 && navSeries.length > points ? navSeries.slice(-points) : navSeries;
  if (slice.length < 2) return null;
  let peak = slice[0];
  let worst = 0;
  for (const nav of slice) {
    if (nav > peak) peak = nav;
    if (peak > 0) {
      const dd = nav / peak - 1;
      if (dd < worst) worst = dd;
    }
  }
  return worst * 100;
};

/**
 * 当前回撤（负数百分比）：当前净值相对回看窗口内最高净值的跌幅。
 * @param {number[]} navSeries 净值（升序）
 * @param {number} [points] 回看净值点数
 * @returns {number|null}
 */
/**
 * 当前回撤（负数百分比）：当前值相对回看窗口内最高值的跌幅。
 *
 * ⚠️ 同 computeMaxDrawdown，入参应为复权收益指数。
 *
 * @param {number[]} series 价格/指数序列（升序）
 * @param {number} [points] 回看点数
 * @returns {number|null}
 */
export const computeCurrentDrawdown = (navSeries, points = CURRENT_DRAWDOWN_LOOKBACK) => {
  if (!isArray(navSeries) || navSeries.length < 2) return null;
  const slice =
    isFiniteNumber(points) && points > 0 && navSeries.length > points ? navSeries.slice(-points) : navSeries;
  if (slice.length < 2) return null;
  let peak = -Infinity;
  for (const nav of slice) {
    if (nav > peak) peak = nav;
  }
  const last = slice[slice.length - 1];
  if (!(peak > 0)) return null;
  return (last / peak - 1) * 100;
};

/** 分位参照窗口对应的交易日数 */
const percentileLookbackDays = () => PERCENTILE_WINDOW_YEARS * TRADING_DAYS_PER_YEAR;

/**
 * 计算全部风险指标。
 *
 * @param {Array<object>} rows 原始或已归一化的净值序列
 * @returns {{
 *   asOfDate: string|null, navCount: number,
 *   vol5: number|null, vol20: number|null, vol60: number|null,
 *   vol20Percentile: number|null, volRatio: number|null,
 *   maxDrawdown20: number|null, maxDrawdown60: number|null, currentDrawdown: number|null,
 *   percentileSamples: number
 * }}
 */
export const computeVolatilityMetrics = (rows) => {
  const series = normalizeNavSeries(rows);
  const returns = returnSeriesOf(series);
  const adjustedIndex = buildAdjustedIndex(series);

  const vol5 = computeRollingVolatility(returns, SHORT_VOLATILITY_WINDOW);
  const vol20 = computeRollingVolatility(returns, MAIN_VOLATILITY_WINDOW);
  const vol60 = computeRollingVolatility(returns, MID_VOLATILITY_WINDOW);

  // 20 日波动率历史分位：参照分布 = 近 5 年的滚动 20 日波动率序列
  const rollingVol20 = computeRollingVolatilitySeries(returns, MAIN_VOLATILITY_WINDOW);
  const reference = rollingVol20.slice(-percentileLookbackDays());
  const vol20Percentile =
    reference.length >= MIN_PERCENTILE_SAMPLES ? computePercentile(reference, reference[reference.length - 1]) : null;

  const volRatio = isFiniteNumber(vol5) && isFiniteNumber(vol20) && vol20 > 0 ? vol5 / vol20 : null;

  return {
    asOfDate: series.length > 0 ? series[series.length - 1].date : null,
    navCount: series.length,
    vol5,
    vol20,
    vol60,
    vol20Percentile,
    volRatio,
    maxDrawdown20: computeMaxDrawdown(adjustedIndex, MAIN_VOLATILITY_WINDOW + 1),
    maxDrawdown60: computeMaxDrawdown(adjustedIndex, MID_VOLATILITY_WINDOW + 1),
    currentDrawdown: computeCurrentDrawdown(adjustedIndex, CURRENT_DRAWDOWN_LOOKBACK),
    percentileSamples: reference.length
  };
};

/**
 * 按规则表判定命中的波动信号。
 *
 * 规则之间互相独立（分位 96% 会同时命中「高波动」与「极端波动」），
 * 全量返回；UI 若嫌吵可用 pickPrimarySignals 同族取最强。
 *
 * @param {object} metrics computeVolatilityMetrics 的返回值
 * @returns {Array<{ key: string, family: string, level: string, severity: number, label: string, detail: string }>}
 */
export const computeVolatilitySignals = (metrics) => {
  if (!isObject(metrics)) return [];
  const fired = [];
  const push = (key, detail) => {
    const def = SIGNAL_DEFS[key];
    if (!def) return;
    fired.push({ key, ...def, detail });
  };

  const pct = metrics.vol20Percentile;
  if (isFiniteNumber(pct)) {
    if (pct >= SIGNAL_THRESHOLDS.EXTREME_VOLATILITY_PERCENTILE) {
      push('extremeVolatility', `20日波动率处于近 ${PERCENTILE_WINDOW_YEARS} 年第 ${pct.toFixed(0)} 分位`);
    } else if (pct >= SIGNAL_THRESHOLDS.HIGH_VOLATILITY_PERCENTILE) {
      push('highVolatility', `20日波动率处于近 ${PERCENTILE_WINDOW_YEARS} 年第 ${pct.toFixed(0)} 分位`);
    }
  }

  const ratio = metrics.volRatio;
  if (isFiniteNumber(ratio)) {
    if (ratio >= SIGNAL_THRESHOLDS.VOLATILITY_EXPANDING_FAST_RATIO) {
      push('volatilityExpandingFast', `5日/20日波动率 ${ratio.toFixed(2)}`);
    } else if (ratio >= SIGNAL_THRESHOLDS.VOLATILITY_EXPANDING_RATIO) {
      push('volatilityExpanding', `5日/20日波动率 ${ratio.toFixed(2)}`);
    }
  }

  // 回撤有三个独立维度，缺一不可：
  //   20 日最大回撤 → 规格 §5 的口径，看「最近是否急跌」
  //   60 日最大回撤 → 看「两个月的阴跌」（20 日窗口看不到）
  //   当前回撤      → 看「回撤发生在更早、现已走平，但用户仍深套」
  const mdd20 = metrics.maxDrawdown20;
  if (isFiniteNumber(mdd20) && mdd20 <= SIGNAL_THRESHOLDS.LARGE_DRAWDOWN_20D) {
    push('largeDrawdown', `20日最大回撤 ${mdd20.toFixed(2)}%`);
  }

  const mdd60 = metrics.maxDrawdown60;
  if (isFiniteNumber(mdd60) && mdd60 <= SIGNAL_THRESHOLDS.DEEP_DRAWDOWN_60D) {
    push('deepDrawdown', `60日最大回撤 ${mdd60.toFixed(2)}%`);
  }

  const currentDd = metrics.currentDrawdown;
  if (isFiniteNumber(currentDd) && currentDd <= SIGNAL_THRESHOLDS.DEEP_CURRENT_DRAWDOWN) {
    push('deepCurrentDrawdown', `当前回撤 ${currentDd.toFixed(2)}%`);
  }

  return fired.sort((a, b) => b.severity - a.severity);
};

/**
 * 同**互斥组**取最强（severity 高者胜），输出顺序为「族顺序 → 族内 severity 降序」。
 *
 * 规格 §7 的示例在 5D/20D=1.39 时只展示「短期波动扩大」而不同时展示「快速扩大」，
 * 就是这个行为；但回撤的三个信号分属三个互斥组，会全部保留——它们是不同维度，
 * 不是同一维度的档位。
 *
 * @param {Array<object>} signals computeVolatilitySignals 的返回值
 */
export const pickPrimarySignals = (signals) => {
  if (!isArray(signals) || signals.length === 0) return [];
  const best = new Map();
  for (const s of signals) {
    // 兜底用 family：externally 构造的信号可能没带 group
    const group = s.group || s.family || s.key;
    const cur = best.get(group);
    if (!cur || s.severity > cur.severity) best.set(group, s);
  }
  const kept = Array.from(best.values());
  return SIGNAL_FAMILY_ORDER.flatMap((family) =>
    kept.filter((s) => s.family === family).sort((a, b) => b.severity - a.severity)
  );
};

/**
 * 归并综合波动状态。
 *
 * 优先级（在规格 §6 的基础上补了「回撤加深」，见下）：
 *
 *   极端波动 > 高波动+较大回撤 > 高波动 > 回撤加深 > 波动扩大 > 正常
 *
 * 与规格 §6 的差异：规格只定义了「高波动 + 较大回撤」这个合取状态，
 * 于是「波动不高、但已经跌了 8%~20%」会落到「正常」——展示成
 * 「正常 + 风险评分 72 + ⚠近期存在较大回撤」，自相矛盾。
 * 因此新增「回撤加深」承接所有回撤类信号。
 *
 * ⚠️ 不变量（有对应单测）：**状态为「正常」当且仅当没有任何信号命中。**
 *    状态必须能由 UI 里同时展示的信号列表解释；让评分反过来驱动状态会破坏这一点
 *    （会出现「状态说高波动、信号列表里却一条高波动都没有」的新矛盾）。
 *
 * @param {object} metrics
 * @param {Array<object>} [signals] 不传则内部重算
 * @returns {string} VOLATILITY_STATES 之一
 */
export const resolveVolatilityState = (metrics, signals) => {
  if (!isObject(metrics)) return VOLATILITY_STATES.INSUFFICIENT;
  if (!isFiniteNumber(metrics.vol20) && !isFiniteNumber(metrics.vol20Percentile)) {
    return VOLATILITY_STATES.INSUFFICIENT;
  }
  const list = isArray(signals) ? signals : computeVolatilitySignals(metrics);
  const keys = new Set(list.map((s) => s.key));
  const drawdown = hasAnyDrawdown(keys);

  if (keys.has('extremeVolatility')) return VOLATILITY_STATES.EXTREME;
  if (keys.has('highVolatility') && drawdown) return VOLATILITY_STATES.HIGH_WITH_DRAWDOWN;
  if (keys.has('highVolatility')) return VOLATILITY_STATES.HIGH;
  if (drawdown) return VOLATILITY_STATES.DRAWDOWN_DEEP;
  if (keys.has('volatilityExpanding') || keys.has('volatilityExpandingFast')) return VOLATILITY_STATES.EXPANDING;
  return VOLATILITY_STATES.NORMAL;
};

/**
 * 风险评分（0-100，越高风险越大）。
 *
 * ⚠️ 规格 §7 要求展示「风险评分」，但 §4/§5/§6 都没有定义它的算法，
 *    因此这里是 V1 自定义的透明启发式，权重与上限都是常量、可调：
 *      波动率维度 50%：优先用 20 日波动率历史分位；分位样本不足时用绝对年化波动率折算
 *      回撤维度     30%：取 20 日 / 60 日最大回撤里更深的那个，回撤到 -15% 记满分
 *      当前回撤维度 20%：回撤到 -12% 记满分
 *    缺失的维度按剩余权重归一化（不让缺失值变成 0 分，把风险算低）。
 *
 * 为什么回撤维度要取 20 日与 60 日的更深者：
 *    状态机（resolveVolatilityState）可以因为「60 日阴跌」或「当前仍深套」升级，
 *    评分若只看 20 日回撤，就会出现「状态=回撤加深，评分却只有 30 分」的反向不一致。
 *    两个维度喂同一批输入，才不会互相打架。
 *
 * @param {object} metrics
 * @returns {number|null} 0-100 取整；全部维度都缺失时 null
 */
export const computeRiskScore = (metrics) => {
  if (!isObject(metrics)) return null;

  const volComponent = isFiniteNumber(metrics.vol20Percentile)
    ? clamp(metrics.vol20Percentile, 0, 100)
    : isFiniteNumber(metrics.vol20)
      ? clamp((metrics.vol20 / ABSOLUTE_VOLATILITY_CEILING) * 100, 0, 100)
      : null;

  const drawdowns = [metrics.maxDrawdown20, metrics.maxDrawdown60].filter(isFiniteNumber);
  const worstDrawdown = drawdowns.length > 0 ? Math.min(...drawdowns) : null;
  const drawdownComponent = isFiniteNumber(worstDrawdown)
    ? clamp((-worstDrawdown / DRAWDOWN_CEILING) * 100, 0, 100)
    : null;

  const currentComponent = isFiniteNumber(metrics.currentDrawdown)
    ? clamp((-metrics.currentDrawdown / CURRENT_DRAWDOWN_CEILING) * 100, 0, 100)
    : null;

  const parts = [
    [volComponent, 0.5],
    [drawdownComponent, 0.3],
    [currentComponent, 0.2]
  ].filter(([value]) => isFiniteNumber(value));

  if (parts.length === 0) return null;

  const totalWeight = parts.reduce((sum, [, w]) => sum + w, 0);
  const weighted = parts.reduce((sum, [value, w]) => sum + value * w, 0) / totalWeight;
  return Math.round(clamp(weighted, 0, 100));
};

/**
 * 一步产出可直接渲染的波动画像。
 *
 * @param {Array<object>} rows 原始或已归一化的净值序列
 * @returns {{
 *   metrics: object, signals: Array<object>, primarySignals: Array<object>,
 *   state: string, stateLevel: string, riskScore: number|null
 * }}
 */
export const analyzeFundVolatility = (rows) => {
  const metrics = computeVolatilityMetrics(rows);
  const signals = computeVolatilitySignals(metrics);
  const state = resolveVolatilityState(metrics, signals);
  return {
    metrics,
    signals,
    primarySignals: pickPrimarySignals(signals),
    state,
    stateLevel: VOLATILITY_STATE_LEVELS[state] || 'muted',
    riskScore: computeRiskScore(metrics)
  };
};
