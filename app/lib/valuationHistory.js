/**
 * 估值区间走势分析（近 1 月 / 近 3 月）
 *
 * 目标：像「业绩走势」那样，按时间区间展示基金估值评分的变化，
 * 而不是只给一个当前时点的快照。
 *
 * 做法：把当前时点的估值评分流程，在区间内的每个日期上重放一遍 ——
 *   1. 取每个持仓在当日（as-of，向前填充）的 PE/PB/PS
 *   2. 用该股的历史估值分布算当日分位
 *   3. 按持仓权重加权，得到基金级 metrics
 *   4. 复用 calculateValuationScore 得到当日评分
 *
 * 覆盖范围：A 股（stock_value_em 日频历史）、港股（stock_hk_valuation_baidu，数据到当日）。
 * 美股无任何可用估值历史源，不参与区间分析（该基金区间内无点）。
 *
 * 已知近似（刻意为之，避免 localStorage 缓存膨胀）：
 *   分位参照分布统一取「当前时点的近 5 年分布」，而非每个历史日各自回看的 5 年窗口。
 *   在 1~3 个月的区间内该窗口仅平移约 1~5%，影响很小；
 *   但区间越长（近 1 年 / 近 3 年 / 成立来）该近似的含义越偏向
 *   「该历史估值在**当前 5 年分布**中的位置」——好处是全区间用同一把尺子，各点可比；
 *   代价是早期点位带入了后验信息。若要严格回看，需为每只股票落盘带日期的 5 年序列，
 *   且窗口起点的点位会因参照样本不足而无法出分。
 *
 * ROE / 盈利增速 / 营收增速为季度指标，区间内视为常量（用当前值）。
 */

// 注意：这里刻意用「默认导入 + 解构」而不是 `import { isArray } from 'lodash'`。
// lodash 是 CJS 包，Node 的 ESM 加载器无法解析其命名导出，直接命名导入会让本模块
// 无法被 `node --test` 直接加载（项目对 app/lib 下的模块跑单测）。打包器两种写法都支持。
import lodash from 'lodash';

import { calculateValuationScore, computePercentile, shrinkPercentile } from './valuationEngine.js';
import {
  buildDailyMetrics,
  MIN_REFERENCE_SAMPLES as METRICS_MIN_REFERENCE_SAMPLES,
  EXTRA_PERCENTILE_KEYS,
  PERCENTILE_METRIC_KEYS as METRICS_PERCENTILE_KEYS
} from './valuationMetrics.js';

const { isArray, isNumber, isString } = lodash;

/**
 * 分位参照分布的最少样本数。
 * 60 ≈ 3 个月交易日：少于这个量级无法称「区间分位」，宁可不参与评分。
 * 真正的定义在 app/lib/valuationMetrics.js —— 首屏与走势图共用同一个门槛。
 */
const MIN_REFERENCE_SAMPLES = METRICS_MIN_REFERENCE_SAMPLES;

/** 分位指标键（与首屏口径共用） */
const PERCENTILE_METRIC_KEYS = METRICS_PERCENTILE_KEYS;

export { MIN_REFERENCE_SAMPLES, PERCENTILE_METRIC_KEYS };

/**
 * 区间定义：与「业绩走势」的区间口径保持一致（自然月近似为 30/182 天，年近似为 365 天）。
 *
 * 'all'（成立来）说明：本模块用的是**持仓股票的估值历史**，不是基金自身净值，
 * 因此无法真正回溯到基金成立日。上限取分位参照窗口（近 5 年），
 * 与两个市场的数据深度对齐：A 股虽然可取到 8.5 年，但港股百度只到 5 年，
 * 且超过 5 年的点位无法与「当前 5 年分布」做同尺度比较。
 * UI 会显示实际覆盖区间，并在该档位给出上限提示。
 */
export const VALUATION_PERIODS = {
  '1m': { label: '近1月', days: 30 },
  '3m': { label: '近3月', days: 90 },
  '6m': { label: '近6月', days: 182 },
  '1y': { label: '近1年', days: 365 },
  '3y': { label: '近3年', days: 1095 },
  all: { label: '成立来', days: null }
};

/** 区间展示顺序（与「业绩走势」一致） */
export const PERIOD_ORDER = ['1m', '3m', '6m', '1y', '3y', 'all'];

/** 默认区间 */
export const DEFAULT_VALUATION_PERIOD = '3m';

/** 'all' 的起点：早于任何可用数据，使日期轴收纳全部点位 */
const EPOCH_FROM = '1900-01-01';

/**
 * 归一化单指标序列：过滤非法行、按日期升序、同日去重（保留后者）。
 *
 * @param {Array<{date?: string, value?: number}>} points
 * @returns {Array<{date: string, value: number}>}
 */
export function normalizePoints(points) {
  if (!isArray(points)) return [];
  const byDate = new Map();
  for (const p of points) {
    if (!p || !isString(p.date)) continue;
    const date = p.date.slice(0, 10);
    if (!Number.isFinite(p.value)) continue;
    byDate.set(date, p.value);
  }
  return Array.from(byDate, ([date, value]) => ({ date, value })).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
}

/**
 * 在升序序列上取「as-of 值」：最后一个 date <= target 的值。
 * 用于把不同市场/不同披露节奏的序列对齐到同一条日期轴。
 *
 * @param {Array<{date: string, value: number}>} sorted
 * @param {string} target
 * @returns {number|null}
 */
export function asOfValue(sorted, target) {
  if (!isArray(sorted) || sorted.length === 0) return null;
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].date <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 ? sorted[found].value : null;
}

/**
 * 构建日期轴：所有序列在 [from, to] 内出现过的日期并集，升序。
 *
 * @param {Array<Array<{date: string}>>} seriesList
 * @param {string} from - YYYY-MM-DD（含）
 * @param {string} to - YYYY-MM-DD（含）
 * @returns {string[]}
 */
export function buildDateAxis(seriesList, from, to) {
  const set = new Set();
  for (const series of isArray(seriesList) ? seriesList : []) {
    for (const p of isArray(series) ? series : []) {
      if (p?.date && p.date >= from && p.date <= to) set.add(p.date);
    }
  }
  return Array.from(set).sort();
}

/**
 * 区间起止日期。
 *
 * 用本地日期（而非 toISOString 的 UTC）格式化：A 股/港股的估值日期按中国时区生成，
 * 若用 UTC 会在北京时间凌晨把「今天」算成「昨天」，导致当日点位被裁掉。
 * 末端再放宽 1 天作为缓冲。
 *
 * @param {number} days
 * @param {Date} [now]
 * @returns {{ from: string, to: string }}
 */
export function getPeriodRange(days, now = new Date()) {
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // 'all'：不设下界（用极早日期收纳全部点位）
  const from = days == null ? EPOCH_FROM : fmt(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
  const to = fmt(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  return { from, to };
}

/**
 * 构造「参照分布的秩查询器」。
 *
 * 区间走势会对每个日期 × 每只股票 × 每个指标做一次分位计算，
 * 长区间（近 3 年/成立来）下点数可达数百，若每次都线性扫参照数组
 * （A 股近 5 年约 1212 个值）会有上千万次比较。
 * 这里先把参照分布排序一次，之后用二分求「严格小于当前值的个数」——
 * 与 computePercentile 的判定口径（v < current）完全一致，只是把复杂度从 O(n) 降到 O(log n)。
 *
 * 两处口径必须与 fund.js 的当前分位计算一致，否则走势图末点会和首屏分数分叉：
 *   1. 参照分布剔除 <= 0（亏损期 PE/PB/PS 会把分布左尾拉长）；
 *   2. 当前值 <= 0 直接返回 null（亏损不能读成「极度低估」）；
 *   3. 结果按参照样本数做分位收缩（见 valuationEngine.shrinkPercentile）。
 *
 * @param {number[]} referenceValues
 * @returns {(value: number) => number|null} 返回 0-100（已收缩）分位
 */
export function createRanker(referenceValues) {
  const sorted = (isArray(referenceValues) ? referenceValues : [])
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return () => null;
  return (value) => {
    if (!Number.isFinite(value) || value <= 0) return null;
    // lowerBound：第一个 >= value 的位置，即「严格小于 value」的元素个数
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return shrinkPercentile((lo / sorted.length) * 100, sorted.length);
  };
}

/**
 * 构建基金估值评分的历史序列。
 *
 * @param {object} params
 * @param {Array<{code: string, weight: number, market: string}>} params.perStock - 已穿透的持仓
 * @param {Record<string, {pe?: Array, pb?: Array, ps?: Array}>} params.historyByCode
 *        每只股票各指标的近端序列（[{date, value}]）
 * @param {Record<string, {pe?: number[], pb?: number[], ps?: number[]}>} params.referenceByCode
 *        每只股票各指标的近 5 年参照分布（用于分位）
 * @param {Record<string, {pe?: number|null, pb?: number|null, ps?: number|null}>} [params.quoteByCode]
 *        个别市场（美股）没有估值历史源：这类持仓**没有序列**，只能在区间内视为常量，
 *        取穿透拿到的当前值。注意只对「序列为空」的股票兜底——A/港股某天没有数据时
 *        仍应返回 null，否则等于把今天的数据搬到过去（前视偏差）。
 * @param {{roe?: number|null, epsGrowth?: number|null, revenueGrowth?: number|null,
 *   peg?: number|null, dividendYield?: number|null, dividendPayoutRatio?: number|null}} [params.fundamentals]
 *        季度/快照指标，区间内视为常量（含 peg 与股息率——它们与 roe 一样没有日频历史，
 *        若在此留空，末点就会与首屏分数分叉：首屏算 peg 而走势图算空）
 * @param {string} params.category - 估值规则分类
 * @param {string} params.from - YYYY-MM-DD
 * @param {string} params.to - YYYY-MM-DD
 * @returns {Array<{date: string, score: number|null, rating: string, confidence: number, metrics: object, coverage: number}>}
 */
export function buildValuationScoreSeries({
  perStock,
  historyByCode,
  referenceByCode,
  quoteByCode,
  fundamentals,
  category,
  from,
  to
}) {
  // 不再要求「必须有估值历史」：美股持仓没有历史源，但它的 PE/PB 会进首屏的加权，
  // 若在这里被过滤掉，走势图末点就会与首屏分叉（QDII 尤其明显）。
  const stocks = (isArray(perStock) ? perStock : []).filter((s) => s && (Number(s.weight) || 0) > 0);
  if (stocks.length === 0) return [];

  // 逐股序列归一化（日期升序 + 去非法值），其余聚合交给 buildDailyMetrics
  const seriesByCode = new Map();
  // 股息率历史只在有价格序列时才存在，缺了就自然缺席（PERCENTILE_METRIC_KEYS + EXTRA）
  const seriesKeys = PERCENTILE_METRIC_KEYS.concat(EXTRA_PERCENTILE_KEYS);
  for (const s of stocks) {
    const hist = historyByCode[s.code] || {};
    const series = {};
    for (const key of seriesKeys) {
      series[key] = normalizePoints(hist[key]);
    }
    seriesByCode.set(s.code, series);
  }

  const axis = buildDateAxis(
    [...seriesByCode.values()].flatMap((series) => PERCENTILE_METRIC_KEYS.map((k) => series[k])),
    from,
    to
  );
  if (axis.length === 0) return [];

  // 季度指标在区间内视为常量；与首屏同一份快照（见 fund.js fetchFundValuationHistory）
  const snapshot = {
    roe: fundamentals?.roe ?? null,
    epsGrowth: fundamentals?.epsGrowth ?? null,
    revenueGrowth: fundamentals?.revenueGrowth ?? null,
    peg: fundamentals?.peg ?? null,
    dividendYield: fundamentals?.dividendYield ?? null,
    dividendPayoutRatio: fundamentals?.dividendPayoutRatio ?? null
  };

  const dailyStocks = stocks.map((s) => ({ code: s.code, weight: Number(s.weight) || 0 }));

  const out = [];
  for (const date of axis) {
    // 每个日期一次「当日 metrics 组装」——与首屏同一个函数、同一套分位规则
    const day = buildDailyMetrics({
      stocks: dailyStocks,
      resolveValue: (stock, metricKey) => {
        const series = seriesByCode.get(stock.code)?.[metricKey];
        // 有历史 → 按日期取（取不到就是 null，不拿今天的数据回填过去）
        if (isArray(series) && series.length > 0) return asOfValue(series, date);
        // 完全没有历史（美股）→ 区间内按常量处理
        const quote = quoteByCode?.[stock.code]?.[metricKey];
        return isNumber(quote) ? quote : null;
      },
      referenceByCode,
      snapshot
    });
    if (!day.metrics) continue;

    const result = calculateValuationScore(day.metrics, category);
    out.push({
      date,
      score: result.score,
      rating: result.rating,
      confidence: result.confidence,
      metrics: day.metrics,
      coverage: day.coveredWeight,
      // 离散度与亏损仓位也逐日给出：走势图上的「合理」在高离散度那天并不可信
      dispersion: day.dispersion,
      lossWeight: day.lossWeight
    });
  }

  return out;
}

/**
 * 区间统计：把评分序列压成 UI 需要的几个数字。
 *
 * @param {Array<{date: string, score: number|null}>} series
 * @returns {{
 *   points: number, validPoints: number,
 *   current: {date: string, score: number}|null,
 *   first: {date: string, score: number}|null,
 *   change: number|null, avg: number|null,
 *   max: {date: string, score: number}|null,
 *   min: {date: string, score: number}|null,
 *   position: number|null,
 *   direction: 'cheaper'|'expensive'|'flat'|null
 * }|null}
 */
export function summarizeValuationSeries(series) {
  const valid = (isArray(series) ? series : []).filter((p) => p && isNumber(p.score));
  if (valid.length === 0) {
    return {
      points: isArray(series) ? series.length : 0,
      validPoints: 0,
      current: null,
      first: null,
      change: null,
      avg: null,
      max: null,
      min: null,
      position: null,
      direction: null
    };
  }

  let max = valid[0];
  let min = valid[0];
  let sum = 0;
  for (const p of valid) {
    sum += p.score;
    if (p.score > max.score) max = p;
    if (p.score < min.score) min = p;
  }
  const first = valid[0];
  const current = valid[valid.length - 1];
  const avg = sum / valid.length;
  const change = Math.round((current.score - first.score) * 10) / 10;
  // 当前分数在区间内的位置（0 = 区间最便宜，100 = 区间最贵）
  const position = computePercentile(
    valid.map((p) => p.score),
    current.score
  );

  // 阈值 3 分：小于该幅度视为区间内基本走平，避免噪声被读成趋势
  const direction = change > 3 ? 'expensive' : change < -3 ? 'cheaper' : 'flat';

  return {
    points: isArray(series) ? series.length : 0,
    validPoints: valid.length,
    current,
    first,
    change,
    avg: Math.round(avg * 10) / 10,
    max,
    min,
    position: position == null ? null : Math.round(position),
    direction
  };
}

export const __test__ = { MIN_REFERENCE_SAMPLES, PERCENTILE_METRIC_KEYS, EPOCH_FROM };
