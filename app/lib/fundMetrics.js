/**
 * 基金指标引擎（13 项风险收益指标）
 *
 * 定位与 app/lib/fundVolatility.js 一致：**只做指标计算**，不做 I/O、不碰 React、不写缓存。
 * 输入是净值序列（+ 可选业绩基准序列），输出可直接渲染，因此能用 `node --test` 纯函数验证。
 *
 * ── 口径（全部集中在这里，便于后续调参）────────────────────────────────────
 *
 * 1. **单位统一为百分数**：日收益率 `r` 形如 0.54 表示 +0.54%，
 *    年化收益率 / 年化波动率 / 最大回撤 / Alpha / VaR / CVaR / 胜率 均为百分数，
 *    夏普 / 索提诺 / 卡尔玛 / 信息比率 / Beta / 盈亏比 为无量纲倍数。
 *    收益率序列复用 fundVolatility 的 `normalizeNavSeries` + `returnSeriesOf`
 *    （复权口径），回撤复用 `buildAdjustedIndex` + 复权指数，保证两个页签口径一致。
 *
 * 2. **统计区间**：调用方负责裁剪（见 METRICS_WINDOW_TRADING_DAYS）。
 *    ⚠️ 必须先裁剪再计算：`fetchFundHistory(code,'all')` 在内存里给出的是**成立以来全量**，
 *    而 IndexedDB 里只保留近 5 年，不裁剪会导致「首次打开（15 年）」与
 *    「刷新后命中缓存（5 年）」算出两个不同的年化收益/最大回撤。
 *
 * 3. **年化收益有两种口径，不能混用**：
 *    - `cagr`（几何）：`(V_end/V_start)^(252/n) − 1`，用于展示与**卡尔玛**
 *      （用户定义的卡尔玛 = 年化收益 / 最大回撤，两者都看几何口径才自洽）。
 *    - `算术年化 = mean(r) × 252`：用于**夏普 / 索提诺 / Alpha**——
 *      这三个是均值-方差框架下的指标，分子用算术均值才是教科书口径。
 *    两者数值接近但不等，面板页脚会向用户说明。
 *
 * 4. **无风险利率** `DEFAULT_RISK_FREE_RATE = 2.0`（年化 %），日度折算用简单除法 `R_f / 252`
 *    （与「算术年化收益 − R_f」保持同一线性量纲）。
 *
 * 5. **VaR / CVaR 用历史模拟法**：单日、95% 置信。
 *    VaR = 日收益率的 5% 分位（线性插值，与 numpy 默认一致）；
 *    CVaR = 所有 ≤ VaR 的日收益率的均值（尾部损失的期望）。
 *
 * 6. **索提诺的下行标准差分母取全部 n 个周期**（行业惯用口径），
 *    不是「只数下跌的那些天」；`MAR = R_f / 252`。
 *
 * 7. **信息比率 / Alpha / Beta 按日期精确对齐后计算**，且先做**日历偏移自校准**
 *    （`detectCalendarOffset`：净值日期在非 UTC+8 浏览器下会整体早一天，不校准会算出假 Beta）。
 *    配对样本不足 `MIN_METRIC_SAMPLES` 时三项一律为 null（不做「用 5 天算 Beta」这种失真）。
 *
 * 8. **所有比率的分母都有一个极小下限**（`MIN_DISPERSION_EPSILON`）：
 *    分散度低到该量级时返回 null 而不是一个由浮点噪声放大出来的比率。
 *
 * 9. **本版本不预测涨跌，也不产生买卖建议。**
 */

// lodash 是 CJS 包，Node 的 ESM 加载器解析不了命名导出，
// 用「默认导入 + 解构」才能让本模块被 node --test 直接加载（同 app/lib/valuationHistory.js）。
import lodash from 'lodash';

import {
  MAIN_VOLATILITY_WINDOW,
  PERCENTILE_WINDOW_YEARS,
  TRADING_DAYS_PER_YEAR,
  annualizeVolatility,
  buildAdjustedIndex,
  computeMaxDrawdown,
  normalizeNavSeries,
  returnSeriesOf
} from './fundVolatility.js';

const { isArray, isNumber, isObject, isString } = lodash;

/** 年化系数：与 fundVolatility 同一常量（A 股一年约 252 个交易日） */
export { TRADING_DAYS_PER_YEAR };

/** 无风险利率（年化 %）：近似 1 年期国债 / 存款基准的中值。V1 为常量，改动只需改这一处。 */
export const DEFAULT_RISK_FREE_RATE = 2.0;

/** VaR / CVaR 置信水平与持有期（历史模拟法，单日） */
export const VAR_CONFIDENCE_LEVEL = 0.95;
export const VAR_HORIZON_DAYS = 1;

/**
 * 指标可计算所需的最少日收益样本数（≈3 个月）。
 * 低于此值时**全部指标**返回 null，由 UI 提示「数据不足」，而不是给出一个噪音很大的数字。
 * Beta/Alpha/信息比率的配对样本要求同一个门槛。
 */
export const MIN_METRIC_SAMPLES = 60;

/**
 * 指标统计窗口（交易日）。
 * ⚠️ 必须与 fundVolatilityCache 的 NAV_RETENTION_DAYS 相等——净值缓存就只留这么多天，
 *    算更长的窗口在命中缓存时拿不到数据，会退化成「有缓存算 5 年、无缓存算 15 年」。
 *    __tests__/fundMetrics.test.js 有断言守着这个等式。
 */
export const METRICS_WINDOW_TRADING_DAYS = PERCENTILE_WINDOW_YEARS * TRADING_DAYS_PER_YEAR + MAIN_VOLATILITY_WINDOW + 5;

/**
 * 离散度下限（单位与日收益率一致，即百分点）。
 *
 * 低于它的标准差一律视为 0，相关比率返回 null。这不是为了「美化」结果，而是防止
 * **浮点噪声被当成真实风险**：
 *   - 完全相同的一只基金与一条基准（基准收益率由收盘价反推，存在 ~1e-15 的往返误差），
 *     `std(主动收益)` 会是 1e-15 而不是 0，除出来的信息比率是 1.19 这种纯噪声值；
 *   - 反过来，近乎恒定的基准（货基/短债）方差接近 0，Beta 会算出天文数字。
 * 真实场景里哪怕是完美复制的指数基金，日跟踪误差也在 1e-4 量级，远高于该阈值。
 */
export const MIN_DISPERSION_EPSILON = 1e-12;

/** 数值有效性：lodash 判类型 + 原生判有限值（NaN/Infinity 一律视为缺失） */
const isFiniteNumber = (v) => isNumber(v) && Number.isFinite(v);

/** 统一出口：非有限值一律返回 null，杜绝 NaN/Infinity 漏进 UI */
const finiteOrNull = (v) => (isFiniteNumber(v) ? v : null);

/** 均值 */
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

/** 样本标准差（n−1 分母） */
const sampleStd = (values) => {
  if (!isArray(values) || values.length < 2) return null;
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Number.isFinite(variance) && variance >= 0 ? Math.sqrt(variance) : null;
};

/** 样本协方差（n−1 分母） */
const sampleCov = (xs, ys) => {
  if (!isArray(xs) || !isArray(ys) || xs.length !== ys.length || xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  const cov = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i] - my), 0) / (xs.length - 1);
  return finiteOrNull(cov);
};

/** 'YYYY-MM-DD' → UTC 毫秒（不可解析返回 null） */
const dateToMs = (date) => {
  if (!isString(date)) return null;
  const ms = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
};

/** 'YYYY-MM-DD' 加（减）若干自然日 */
const shiftDate = (date, days) => {
  const ms = dateToMs(date);
  if (ms == null || !isFiniteNumber(days)) return null;
  return new Date(ms + days * 86400000).toISOString().slice(0, 10);
};

/**
 * 允许的「基金日期 → 基准日期」日历偏移候选（自然日）。
 *
 * 为什么需要它（实测踩到的坑）：
 *   天天基金 pingzhongdata 的净值时间戳是 **CST 零点**（实测形如 `...T16:00:00.000Z`），
 *   而 app/api/fund.js 用 `dayjs(d.x).tz(浏览器时区)` 还原日期：
 *   在 UTC+8 及以东的浏览器上得到正确日期，在 UTC / 美洲时区上会**整体早一天**。
 *   基准指数日期来自 push2his 的 `"YYYY-MM-DD"` 字符串（绝对日历日，不受时区影响），
 *   于是两侧在非中国时区下会系统性错位一天。实测 110022（近 5 年 1285 个净值日）：
 *   日期精确匹配只剩 1011 条（78.7%），且其余点全部错配一天 —— Beta 算出 -0.06，
 *   一个「看起来像数字」的垃圾值，比直接显示 `--` 危险得多。
 *
 * 因此这里不再假设两侧日历天然对齐，而是**用数据验证**：在候选偏移中挑命中数最多者，
 * 但要求它比「不偏移」明显更优（CALENDAR_OFFSET_MIN_GAIN），且命中率达标
 * （MIN_CALENDAR_MATCH_RATIO）才认领——宁可少算 Alpha/Beta，也不错配。
 *
 * ⚠️ 为什么需要「明显更优」而不是「命中数最多」：两个日历都是日频连续交易日，
 *    整体平移 1 天往往会落在相邻的交易日上（仍有约 7 成命中），
 *    只看「最多」在有噪声时可能选错。实测两种真实情形差距很大，足以判别：
 *      东八区浏览器（正确）：偏移 0 → 99.8%，偏移 +1 → 78.7%
 *      UTC/美洲浏览器      ：偏移 0 → 78.7%，偏移 +1 → 99.8%
 */
export const CALENDAR_OFFSET_CANDIDATES = Object.freeze([0, 1, -1, 2, -2]);

/** 认领某个日历偏移所需的最低命中比例（相对基金收益点数） */
export const MIN_CALENDAR_MATCH_RATIO = 0.6;

/** 认领某个日历偏移所需的最低**相对增益**（相对「不偏移」的命中数） */
export const CALENDAR_OFFSET_MIN_GAIN = 0.02;

/**
 * 探测基金日期与基准日期之间的稳定日历偏移。
 *
 * @param {Array<{ date: string }>} fundPoints 升序
 * @param {Array<{ date: string }>} benchmarkPoints 升序
 * @returns {{ offsetDays: number, matchRatio: number, bestMatches: number }}
 *          未达到认领门槛时 offsetDays 固定为 0（不做无根据的平移）
 */
export const detectCalendarOffset = (fundPoints, benchmarkPoints) => {
  if (!isArray(fundPoints) || fundPoints.length === 0 || !isArray(benchmarkPoints) || benchmarkPoints.length === 0) {
    return { offsetDays: 0, matchRatio: 0, bestMatches: 0 };
  }

  const benchDates = new Set(benchmarkPoints.map((p) => p?.date).filter((d) => isString(d)));
  if (benchDates.size === 0) return { offsetDays: 0, matchRatio: 0, bestMatches: 0 };

  const matchesOf = (offset) => {
    let matches = 0;
    for (const point of fundPoints) {
      if (!isObject(point) || !isString(point.date)) continue;
      const target = offset === 0 ? point.date : shiftDate(point.date, offset);
      if (target != null && benchDates.has(target)) matches += 1;
    }
    return matches;
  };

  const zeroMatches = matchesOf(0);
  let bestOffset = 0;
  let bestMatches = zeroMatches;
  for (const candidate of CALENDAR_OFFSET_CANDIDATES) {
    if (candidate === 0) continue;
    const matches = matchesOf(candidate);
    if (matches > bestMatches) {
      bestMatches = matches;
      bestOffset = candidate;
    }
  }

  const zeroRatio = zeroMatches / fundPoints.length;
  const bestRatio = bestMatches / fundPoints.length;

  // 默认不动：只在「偏移后明显更优」且「达标」时才认领偏移
  if (
    bestOffset === 0 ||
    bestRatio < MIN_CALENDAR_MATCH_RATIO ||
    bestMatches < zeroMatches * (1 + CALENDAR_OFFSET_MIN_GAIN)
  ) {
    return { offsetDays: 0, matchRatio: zeroRatio, bestMatches: zeroMatches };
  }
  return { offsetDays: bestOffset, matchRatio: bestRatio, bestMatches };
};

/**
 * 分位数（线性插值，等价 numpy.percentile 默认行为）。
 * @param {number[]} sortedValues 升序排列的样本
 * @param {number} p 0~1
 * @returns {number|null}
 */
export const computeQuantile = (sortedValues, p) => {
  if (!isArray(sortedValues) || sortedValues.length === 0) return null;
  if (!isFiniteNumber(p)) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const pos = clamped * (sortedValues.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loValue = sortedValues[lo];
  const hiValue = sortedValues[hi];
  if (!isFiniteNumber(loValue) || !isFiniteNumber(hiValue)) return null;
  if (lo === hi) return loValue;
  return finiteOrNull(loValue + (hiValue - loValue) * (pos - lo));
};

/**
 * 几何平均年化收益率（CAGR，%）。
 * @param {number[]} adjustedIndex 复权收益指数（升序，首元素为 1）
 * @returns {number|null} 例如 12.3 表示年化 +12.3%
 */
export const computeCagr = (adjustedIndex) => {
  if (!isArray(adjustedIndex) || adjustedIndex.length < 2) return null;
  const steps = adjustedIndex.length - 1;
  const start = adjustedIndex[0];
  const end = adjustedIndex[adjustedIndex.length - 1];
  if (!isFiniteNumber(start) || !isFiniteNumber(end) || start <= 0 || end <= 0) return null;
  if (steps < 1) return null;
  const ratio = end / start;
  const cagr = (Math.pow(ratio, TRADING_DAYS_PER_YEAR / steps) - 1) * 100;
  return finiteOrNull(cagr);
};

/**
 * 算术年化收益率（%）：日收益率均值 × 252。
 * 夏普 / 索提诺 / Alpha 的分子用它（均值-方差框架口径）。
 */
export const computeArithmeticAnnualizedReturn = (returns) => {
  if (!isArray(returns) || returns.length === 0) return null;
  return finiteOrNull(mean(returns) * TRADING_DAYS_PER_YEAR);
};

/**
 * 年化下行标准差（索提诺分母，%）。
 *
 * `DD = sqrt( (1/n) × Σ min(0, r_i − MAR)² ) × √252`，分母是**全部 n 个周期**
 * （下跌日贡献非零项，上涨日贡献 0），这是行业惯用口径。
 *
 * @param {number[]} returns 日收益率（%）
 * @param {number} [marDaily] 最低可接受日收益（%），默认 0
 */
export const computeDownsideDeviation = (returns, marDaily = 0) => {
  if (!isArray(returns) || returns.length === 0) return null;
  const mar = isFiniteNumber(marDaily) ? marDaily : 0;
  const sumSquares = returns.reduce((acc, r) => {
    const diff = r - mar;
    return acc + (diff < 0 ? diff * diff : 0);
  }, 0);
  const downside = Math.sqrt(sumSquares / returns.length) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  return finiteOrNull(downside);
};

/**
 * 历史模拟法 VaR（%，单日，负值代表损失）。
 * @param {number[]} returns 日收益率（%）
 * @param {number} [confidence] 默认 0.95
 */
export const computeVaR = (returns, confidence = VAR_CONFIDENCE_LEVEL) => {
  if (!isArray(returns) || returns.length === 0) return null;
  if (!isFiniteNumber(confidence) || confidence <= 0 || confidence >= 1) return null;
  const sorted = returns.slice().sort((a, b) => a - b);
  return computeQuantile(sorted, 1 - confidence);
};

/**
 * 历史模拟法 CVaR（%，单日，尾部损失的期望值）。
 * 取所有 ≤ VaR 的样本均值；由于 VaR 是插值分位，尾部样本数约为 n×(1−confidence)。
 */
export const computeCVaR = (returns, confidence = VAR_CONFIDENCE_LEVEL) => {
  const var95 = computeVaR(returns, confidence);
  if (!isFiniteNumber(var95)) return null;
  if (!isArray(returns)) return null;
  const tail = returns.filter((r) => isFiniteNumber(r) && r <= var95);
  if (tail.length === 0) return null;
  return finiteOrNull(mean(tail));
};

/**
 * 胜率（%）：日收益率为正的天数占比。
 * 分母是**全部有效交易日**（收益为 0 的日子计入分母但不计入分子），
 * 这样「只跌不涨的震荡市」不会被算成 50%。
 */
export const computeWinRate = (returns) => {
  if (!isArray(returns) || returns.length === 0) return null;
  const valid = returns.filter(isFiniteNumber);
  if (valid.length === 0) return null;
  const positive = valid.filter((r) => r > 0).length;
  return finiteOrNull((positive / valid.length) * 100);
};

/**
 * 盈亏比（倍）：正收益之和 ÷ 负收益绝对值之和（用户给定口径「总盈利 / 总亏损」）。
 *
 * 注意这与「平均盈利 / 平均亏损」是两个不同指标；本仓库按用户给定公式实现总和口径。
 * 区间内**没有任何下跌日**时返回 null（不是 Infinity）——UI 显示 `--` 并提示「无亏损日」。
 */
export const computeProfitLossRatio = (returns) => {
  if (!isArray(returns) || returns.length === 0) return null;
  let gain = 0;
  let loss = 0;
  for (const r of returns) {
    if (!isFiniteNumber(r)) continue;
    if (r > 0) gain += r;
    else if (r < 0) loss += -r;
  }
  if (loss <= 0) return null;
  return finiteOrNull(gain / loss);
};

/**
 * 由基准日线（收盘价）构造日收益率序列（%，升序）。
 * @param {Array<{ date: string, close: number }>} rows
 * @returns {Array<{ date: string, ret: number }>}
 */
export const buildBenchmarkReturns = (rows) => {
  if (!isArray(rows)) return [];
  const out = [];
  let prevClose = null;
  for (const row of rows) {
    if (!isObject(row)) continue;
    const date = isString(row.date) ? row.date.trim() : '';
    const close = Number(row.close);
    if (!date || !Number.isFinite(close) || close <= 0) continue;
    if (prevClose != null && prevClose > 0) {
      const ret = (close / prevClose - 1) * 100;
      if (Number.isFinite(ret)) out.push({ date, ret });
    }
    prevClose = close;
  }
  return out;
};

/**
 * 由基金净值序列构造「日期 + 当日收益率」点集（升序），供与基准对齐使用。
 *
 * ⚠️ 不能写成 `returns.map((ret, i) => ({ date: series[i+1].date, ret }))`：
 *    `returnSeriesOf` 会**过滤掉** dailyReturn 缺失的行，过滤后下标就与 series 错位了，
 *    `normalizeNavSeries` 在数据有缺口时确实会留下 dailyReturn 为 null 的行。
 *    必须直接在原序列上过滤，日期与收益率才成对。
 *
 * @param {Array<{ date: string, dailyReturn: number|null }>} series 升序净值序列
 * @returns {Array<{ date: string, ret: number }>}
 */
export const buildFundReturnPoints = (series) => {
  if (!isArray(series)) return [];
  const out = [];
  for (const row of series) {
    if (!isObject(row) || !isString(row.date) || !isFiniteNumber(row.dailyReturn)) continue;
    out.push({ date: row.date, ret: row.dailyReturn });
  }
  return out;
};

/**
 * 按日期把基金日收益率与基准日收益率配对。
 *
 * 对齐规则：**日期必须完全相等**（先按 `offsetDays` 把基金日期校准到基准日历上）。
 * 不做「取最近一条基准收益」式的 carry-forward：基准休市而基金有净值的日子
 * （QDII 下很常见，实测 270042 有 49 天），沿用前一条基准收益等于把同一段涨跌数两遍，
 * 会系统性低估跟踪误差、把信息比率抬高。少算几天远好过算错。
 *
 * 同日对齐对所有基准都成立（含美股，实测相关系数 0.958），理由见 app/lib/fundBenchmark.js。
 *
 * @param {Array<{ date: string, ret: number }>} fundReturns 升序
 * @param {Array<{ date: string, ret: number }>} benchmarkReturns 升序
 * @param {{ offsetDays?: number }} [options]
 *        `offsetDays` 是「基金日期 → 基准日期」的日历偏移，由 detectCalendarOffset 探测得到
 *        （不传按 0 处理，即两侧日历天然对齐）
 * @returns {Array<{ date: string, fund: number, bench: number }>} date 始终是**基金侧**日期
 */
export const alignReturnsByDate = (fundReturns, benchmarkReturns, options = {}) => {
  const { offsetDays = 0 } = options;
  if (!isArray(fundReturns) || !isArray(benchmarkReturns)) return [];
  if (fundReturns.length === 0 || benchmarkReturns.length === 0) return [];

  const offset = isFiniteNumber(offsetDays) ? Math.round(offsetDays) : 0;

  const pairs = [];
  let cursor = -1; // 基准序列中最后一个 date ≤ 当前「校准后基金日」的下标
  for (const fundPoint of fundReturns) {
    if (!isObject(fundPoint) || !isString(fundPoint.date) || !isFiniteNumber(fundPoint.ret)) continue;
    const fundDate = fundPoint.date;
    const targetDate = offset === 0 ? fundDate : shiftDate(fundDate, offset);
    if (targetDate == null) continue;

    while (cursor + 1 < benchmarkReturns.length && benchmarkReturns[cursor + 1].date <= targetDate) {
      cursor += 1;
    }
    if (cursor < 0) continue;

    const benchPoint = benchmarkReturns[cursor];
    if (!isObject(benchPoint) || !isFiniteNumber(benchPoint.ret) || benchPoint.date !== targetDate) continue;

    pairs.push({ date: fundDate, fund: fundPoint.ret, bench: benchPoint.ret });
  }
  return pairs;
};

/**
 * 由配对样本算 Beta / Alpha / 信息比率 / 跟踪误差。
 * @param {Array<{ fund: number, bench: number }>} pairs
 * @param {{ riskFreeRate?: number }} [options]
 * @returns {{
 *   beta: number|null, alpha: number|null, informationRatio: number|null,
 *   trackingError: number|null, activeReturn: number|null
 * }}
 */
export const computePairedMetrics = (pairs, options = {}) => {
  const riskFreeRate = isFiniteNumber(options.riskFreeRate) ? options.riskFreeRate : DEFAULT_RISK_FREE_RATE;
  const empty = { beta: null, alpha: null, informationRatio: null, trackingError: null, activeReturn: null };
  if (!isArray(pairs) || pairs.length < MIN_METRIC_SAMPLES) return empty;

  const fundReturns = pairs.map((p) => p.fund);
  const benchReturns = pairs.map((p) => p.bench);
  const benchStd = sampleStd(benchReturns);
  const cov = sampleCov(fundReturns, benchReturns);
  const beta =
    benchStd != null && benchStd > MIN_DISPERSION_EPSILON && cov != null
      ? finiteOrNull(cov / (benchStd * benchStd))
      : null;

  // 算术年化（%）：CAPM 家族统一用算术均值，见文件头口径 3
  const fundMeanAnnual = mean(fundReturns) * TRADING_DAYS_PER_YEAR;
  const benchMeanAnnual = mean(benchReturns) * TRADING_DAYS_PER_YEAR;
  const alpha =
    beta != null ? finiteOrNull(fundMeanAnnual - riskFreeRate - beta * (benchMeanAnnual - riskFreeRate)) : null;

  const active = pairs.map((p) => p.fund - p.bench);
  const activeStd = sampleStd(active);
  const activeMeanAnnual = mean(active) * TRADING_DAYS_PER_YEAR;
  const trackingError = activeStd != null ? finiteOrNull(activeStd * Math.sqrt(TRADING_DAYS_PER_YEAR)) : null;
  const informationRatio =
    activeStd != null && activeStd > MIN_DISPERSION_EPSILON && trackingError != null
      ? finiteOrNull(activeMeanAnnual / trackingError)
      : null;

  return {
    beta,
    alpha,
    informationRatio,
    trackingError,
    activeReturn: finiteOrNull(activeMeanAnnual)
  };
};

/** 13 项指标 + 上下文的全空骨架（数据不足时直接返回它） */
const buildEmptyMetrics = ({ sampleCount, startDate, endDate, riskFreeRate }) => ({
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
  arithmeticAnnualizedReturn: null,
  trackingError: null,
  sampleCount,
  startDate,
  endDate,
  pairedSampleCount: 0,
  alignmentOffsetDays: 0,
  alignmentMatchRatio: 0,
  benchmarkSecid: null,
  benchmarkName: null,
  riskFreeRate,
  varConfidence: VAR_CONFIDENCE_LEVEL,
  varHorizonDays: VAR_HORIZON_DAYS,
  insufficient: true
});

/**
 * 一步算出全部 13 项指标。
 *
 * @param {object} input
 * @param {Array<object>} input.rows 基金净值行（原始 fetchFundHistory 行或已归一化行均可）
 *        ⚠️ 调用方需先按 METRICS_WINDOW_TRADING_DAYS 裁剪（见文件头口径 2）
 * @param {{ secid?: string, name?: string, rows?: Array<{date: string, close: number}> }|null} [input.benchmark]
 *        业绩基准；为 null 时仅信息比率/Alpha/Beta 缺失，其余指标照常
 * @param {number} [input.riskFreeRate] 年化无风险利率（%）
 * @returns {object} 见 buildEmptyMetrics 的字段 + 计算值
 */
export const computeFundMetrics = ({ rows, benchmark = null, riskFreeRate = DEFAULT_RISK_FREE_RATE } = {}) => {
  const rf = isFiniteNumber(riskFreeRate) ? riskFreeRate : DEFAULT_RISK_FREE_RATE;

  const series = normalizeNavSeries(rows);
  const fundReturns = returnSeriesOf(series);
  const adjustedIndex = buildAdjustedIndex(series);
  const sampleCount = fundReturns.length;
  const startDate = series.length > 0 ? series[0].date : null;
  const endDate = series.length > 0 ? series[series.length - 1].date : null;

  if (sampleCount < MIN_METRIC_SAMPLES) {
    return buildEmptyMetrics({ sampleCount, startDate, endDate, riskFreeRate: rf });
  }

  const annualizedVolatility = annualizeVolatility(fundReturns);
  const cagr = computeCagr(adjustedIndex);
  const arithmeticAnnualizedReturn = computeArithmeticAnnualizedReturn(fundReturns);
  const maxDrawdown = computeMaxDrawdown(adjustedIndex);
  const marDaily = rf / TRADING_DAYS_PER_YEAR;
  const downsideDeviation = computeDownsideDeviation(fundReturns, marDaily);

  const sharpe =
    annualizedVolatility != null && annualizedVolatility > MIN_DISPERSION_EPSILON && arithmeticAnnualizedReturn != null
      ? finiteOrNull((arithmeticAnnualizedReturn - rf) / annualizedVolatility)
      : null;
  const sortino =
    downsideDeviation != null && downsideDeviation > MIN_DISPERSION_EPSILON && arithmeticAnnualizedReturn != null
      ? finiteOrNull((arithmeticAnnualizedReturn - rf) / downsideDeviation)
      : null;
  const calmar =
    cagr != null && maxDrawdown != null && maxDrawdown < -MIN_DISPERSION_EPSILON
      ? finiteOrNull(cagr / Math.abs(maxDrawdown))
      : null;

  const benchmarkRows = isObject(benchmark) && isArray(benchmark.rows) ? benchmark.rows : [];
  const benchmarkReturns = buildBenchmarkReturns(benchmarkRows);
  const fundPoints = buildFundReturnPoints(series);
  // 先探测日历偏移再配对：非 UTC+8 浏览器下净值日期会整体早一天（见 detectCalendarOffset 注释）
  const alignment = detectCalendarOffset(fundPoints, benchmarkReturns);
  const paired = alignReturnsByDate(fundPoints, benchmarkReturns, { offsetDays: alignment.offsetDays });
  const pairedMetrics = computePairedMetrics(paired, { riskFreeRate: rf });

  return {
    cagr,
    annualizedVolatility: finiteOrNull(annualizedVolatility),
    maxDrawdown: finiteOrNull(maxDrawdown),
    sharpe,
    sortino,
    calmar,
    informationRatio: pairedMetrics.informationRatio,
    alpha: pairedMetrics.alpha,
    beta: pairedMetrics.beta,
    var95: computeVaR(fundReturns),
    cvar95: computeCVaR(fundReturns),
    winRate: computeWinRate(fundReturns),
    profitLossRatio: computeProfitLossRatio(fundReturns),
    arithmeticAnnualizedReturn,
    trackingError: pairedMetrics.trackingError,
    sampleCount,
    startDate,
    endDate,
    pairedSampleCount: paired.length,
    alignmentOffsetDays: alignment.offsetDays,
    alignmentMatchRatio: alignment.matchRatio,
    benchmarkSecid: isObject(benchmark) && isString(benchmark.secid) ? benchmark.secid : null,
    benchmarkName: isObject(benchmark) && isString(benchmark.name) ? benchmark.name : null,
    riskFreeRate: rf,
    varConfidence: VAR_CONFIDENCE_LEVEL,
    varHorizonDays: VAR_HORIZON_DAYS,
    insufficient: false
  };
};
