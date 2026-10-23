import lodash from 'lodash';

import { computePercentile, shrinkPercentile } from './valuationEngine.js';

/**
 * 当日估值指标的「唯一组装口径」。
 *
 * 背景：这套指标原先算了两遍 —— 首屏用 `app/api/fund.js` 的
 * `calculateHoldingsPercentiles`（取天级缓存的当前值），走势图用
 * `app/lib/valuationHistory.js` 的 `buildValuationScoreSeries`（取当日序列值）。
 * 两处的样本过滤、收缩、加权聚合各写了一套，结果就是同一个基金在同一天
 * 出现「首屏 43.5 / 走势末点 36.5」，并且任何一处改了规则另一处不会跟着变。
 *
 * 现在把「给定一批持仓 + 一个取值方式 → 当日 metrics」抽成 `buildDailyMetrics`：
 *   - 走势图每个日期调用一次（取值方式 = 该日序列值）；
 *   - 首屏对「今天」调用一次（取值方式 = 当前值）。
 * 取值方式由调用方注入，聚合逻辑只有一份。
 *
 * 除 metrics 外还产出三个此前完全没有的信息量：
 *   - `dispersion`：各持仓分位的标准差。均值分位 50 的「合理」，在哑铃型持仓下
 *     可能只是 10 和 90 的平均值，光看均值会得出错误结论；
 *   - `lossWeight`：亏损仓位占比。PE 分位低有时不是便宜，而是持仓在亏钱；
 *   - `percents`：逐持仓分位，供 §4.7 的横向（自选池）相对分位使用。
 */

/** 计算分位所需的最少参照样本数：60 个样本时标准误约 ±6.5pt（p=0.5），再少就没有意义 */
export const MIN_REFERENCE_SAMPLES = 60;

/** 参与分位计算的估值乘数（PEG/ROE 等季度指标没有日频历史，不进分位） */
export const PERCENTILE_METRIC_KEYS = ['pe', 'pb', 'ps'];

/**
 * 有历史序列时才启用的分位指标：股息率。
 *
 * 股息率的分位此前永远是 null —— 上游只有 push2 `f126` 的当日值，没有股息率历史。
 * 本文件用价格序列倒推出历史股息率（见 deriveDividendYieldReference），
 * 因此「有没有这列」取决于该股票是否拿到了价格历史；拿不到就整列缺席，
 * 判分逻辑（valuationEngine 的 usePercentile 分支）会自动回退到绝对阈值。
 *
 * 注意：这一列不进 PERCENTILE_METRIC_KEYS，因为它不是估值乘数，
 * 不能参与 coveredWeight / 亏损仓位 / 离散度的乘数口径统计。
 */
export const EXTRA_PERCENTILE_KEYS = ['dividendYield'];

/**
 * 用价格序列倒推历史股息率序列（代理口径）。
 *
 * 口径：`DY_t = DY_now × price_now / price_t`，即假设窗口内「每股分红」不变。
 * 为什么可以这样：股息率 = 每股分红 / 股价，分子按年更新且变动缓慢（分红政策调整才动），
 * 分母每天跳动。真实误差来自分红增减（红利股通常 ±20% 以内），而股价 5 年振幅远超此数，
 * 因此「股息率处于自身历史的什么位置」这个相对判断基本成立。
 *
 * 为什么不用真源：`stock_a_indicator_lg`（聚合+股息率历史）在当前 AKTools 上 404，
 * 东财 `RPT_VALUEANALYSIS_DET` 虽有 PE/PB/PS/收盘价历史但 22 个字段里没有股息率。
 * 详见 doc/估值功能审计与指标优化建议.md §十。
 *
 * @param {Array<{date: string, price: number|null}>} recentRows - 带日期的价格序列（升序）
 * @param {number|null} currentYield - 当前股息率（%）
 * @returns {Array<{date: string, value: number}>} 升序序列；样本不足或价格非法时返回 []
 */
export const deriveDividendYieldReference = (recentRows, currentYield) => {
  const rows = (lodash.isArray(recentRows) ? recentRows : []).filter(
    (r) => r && lodash.isString(r.date) && lodash.isNumber(r.price) && Number.isFinite(r.price) && r.price > 0
  );
  if (rows.length < MIN_REFERENCE_SAMPLES) return [];
  if (!lodash.isNumber(currentYield) || !Number.isFinite(currentYield) || currentYield <= 0) return [];
  const lastPrice = rows[rows.length - 1].price;
  if (!(lastPrice > 0)) return [];
  const out = [];
  for (const r of rows) {
    const value = (currentYield * lastPrice) / r.price;
    if (Number.isFinite(value) && value > 0 && value < 100) out.push({ date: r.date, value: round(value, 3) });
  }
  return out.length >= MIN_REFERENCE_SAMPLES ? out : [];
};

/**
 * 单只股票的分位统计：剔除亏损样本、样本不足判空、结果向 50 收缩。
 *
 * @param {Array<number>|null} referenceValues - 参照分布（近 5 年）
 * @param {number|null} currentValue - 当日估值乘数
 * @param {{minSamples?: number}} [options]
 * @returns {{percentile: number|null, sampleCount: number,
 *   reason: 'missing'|'non-positive'|'insufficient'|'undefined'|null}}
 */
export const percentileStat = (referenceValues, currentValue, options = {}) => {
  const minSamples = options.minSamples ?? MIN_REFERENCE_SAMPLES;
  // 参照分布剔除 <= 0 的样本：亏损期的负 PE 会把分布左尾拉长，让正常值显得「很贵」
  const clean = (lodash.isArray(referenceValues) ? referenceValues : []).filter(
    (v) => lodash.isNumber(v) && Number.isFinite(v) && v > 0
  );
  if (!lodash.isNumber(currentValue) || !Number.isFinite(currentValue)) {
    return { percentile: null, raw: null, sampleCount: clean.length, reason: 'missing' };
  }
  // PE/PB/PS <= 0 = 亏损或净资产为负：分位会把「最差」读成「极度低估」
  if (currentValue <= 0) {
    return { percentile: null, raw: null, sampleCount: clean.length, reason: 'non-positive' };
  }
  if (clean.length < minSamples) {
    return { percentile: null, raw: null, sampleCount: clean.length, reason: 'insufficient' };
  }
  const raw = computePercentile(clean, currentValue, { excludeNonPositive: true });
  if (raw == null) {
    return { percentile: null, raw: null, sampleCount: clean.length, reason: 'undefined' };
  }
  // raw 保留未收缩分位：聚合评分用收缩后的 percentile，
  // 但「持仓之间差多少」必须用未收缩值，否则所有持仓都被压进 25~75，
  // 离散度永远算不出「哑铃型」（见 dispersion 的说明）。
  return {
    percentile: shrinkPercentile(raw, clean.length),
    raw,
    sampleCount: clean.length,
    reason: null
  };
};

/**
 * 总体标准差（不是样本标准差：这里的「总体」就是这只基金的持仓）。
 *
 * @param {Array<number>} values
 * @returns {number|null}
 */
export const stdDev = (values) => {
  const clean = (lodash.isArray(values) ? values : []).filter((v) => lodash.isNumber(v) && Number.isFinite(v));
  if (clean.length === 0) return null;
  const mean = clean.reduce((s, v) => s + v, 0) / clean.length;
  const variance = clean.reduce((s, v) => s + (v - mean) ** 2, 0) / clean.length;
  return Math.sqrt(variance);
};

const round = (v, digits = 2) => (lodash.isNumber(v) && Number.isFinite(v) ? Number(v.toFixed(digits)) : null);

/**
 * 组装某一时点的基金级估值指标。
 *
 * @param {object} params
 * @param {Array<{code: string, weight: number}>} params.stocks - 已穿透的持仓（权重为百分数）
 * @param {(stock: object, metricKey: string) => number|null} params.resolveValue - 该时点的取值方式
 * @param {object} [params.referenceByCode] - { [code]: { pe: number[], pb: number[], ps: number[] } }
 * @param {object} [params.snapshot] - 当日快照指标（peg / dividendYield / dividendPayoutRatio / roe / epsGrowth / revenueGrowth）
 * @param {number} [params.minSamples]
 * @returns {{
 *   metrics: object, coveredWeight: number, normSum: number,
 *   percents: {pe: number|null, pb: number|null, ps: number|null},
 *   samples: {pe: number, pb: number, ps: number},
 *   dispersion: {pe: number|null, pb: number|null, ps: number|null},
 *   lossWeight: number, perStockPercents: Array<{code: string, pe: number|null, pb: number|null, ps: number|null}>
 * }}
 */
export const buildDailyMetrics = ({
  stocks,
  resolveValue,
  referenceByCode,
  snapshot,
  minSamples = MIN_REFERENCE_SAMPLES
}) => {
  const list = (lodash.isArray(stocks) ? stocks : []).filter((s) => s && (Number(s.weight) || 0) > 0);
  const empty = {
    metrics: null,
    coveredWeight: 0,
    normSum: 0,
    percents: { pe: null, pb: null, ps: null, dividendYield: null },
    samples: { pe: 0, pb: 0, ps: 0, dividendYield: 0 },
    dispersion: { pe: null, pb: null, ps: null },
    lossWeight: 0,
    perStockPercents: []
  };

  const normSum = list.reduce((sum, s) => sum + (Number(s.weight) || 0), 0);
  if (list.length === 0 || normSum <= 0) return empty;

  let epSum = 0;
  let coveredWeight = 0;
  let lossWeight = 0;
  // 分位指标 = 估值乘数 + 有历史序列才启用的额外列（股息率）；后者该股票没有序列时自然缺席
  const pctKeys = PERCENTILE_METRIC_KEYS.concat(EXTRA_PERCENTILE_KEYS);
  const zeroOf = (keys) => {
    const o = {};
    for (const k of keys) o[k] = 0;
    return o;
  };
  const listOf = (keys) => {
    const o = {};
    for (const k of keys) o[k] = [];
    return o;
  };
  const rawSum = zeroOf(['pb', 'ps']);
  const rawWeight = zeroOf(['pb', 'ps']);
  const pctSum = zeroOf(pctKeys);
  const pctWeight = zeroOf(pctKeys);
  const pctValues = listOf(pctKeys);
  const sampleSum = zeroOf(pctKeys);
  const sampleWeight = zeroOf(pctKeys);
  const perStockPercents = [];

  for (const stock of list) {
    const w = Number(stock.weight) || 0;
    const ref = referenceByCode?.[stock.code] || {};
    const values = {};
    for (const key of pctKeys) {
      // 额外列只在参照分布存在时才取值，避免为没有历史的股票白算一遍
      if (EXTRA_PERCENTILE_KEYS.includes(key) && !lodash.isArray(ref[key])) {
        values[key] = null;
        continue;
      }
      const v = resolveValue ? resolveValue(stock, key) : null;
      values[key] = lodash.isNumber(v) && Number.isFinite(v) ? v : null;
    }
    const hasAny = PERCENTILE_METRIC_KEYS.some((k) => values[k] != null);
    if (!hasAny) continue;
    coveredWeight += w;

    // 亏损仓位：PE <= 0（亏损）或 PB <= 0（净资产为负）都算「便宜得不健康」
    if ((values.pe != null && values.pe <= 0) || (values.pb != null && values.pb <= 0)) {
      lossWeight += w;
    }

    // PE 用 E/P 倒数法：Σw/PE 的倒数是「加权盈利收益率」的倒数，避免高 PE 被权重放大
    if (values.pe != null && values.pe > 0) epSum += w / normSum / values.pe;
    if (values.pb != null) {
      rawSum.pb += w * values.pb;
      rawWeight.pb += w;
    }
    if (values.ps != null) {
      rawSum.ps += w * values.ps;
      rawWeight.ps += w;
    }

    const codePercents = { code: stock.code, pe: null, pb: null, ps: null };
    for (const key of pctKeys) {
      const stat = percentileStat(ref[key], values[key], { minSamples });
      if (stat.percentile == null) continue;
      pctSum[key] += w * stat.percentile;
      pctWeight[key] += w;
      // 离散度用未收缩分位：收缩是为了基金级均值的稳定性，不该抹掉持仓之间的真实差异
      pctValues[key].push(lodash.isNumber(stat.raw) ? stat.raw : stat.percentile);
      sampleSum[key] += stat.sampleCount * w;
      sampleWeight[key] += w;
      if (PERCENTILE_METRIC_KEYS.includes(key)) codePercents[key] = round(stat.percentile, 1);
    }
    perStockPercents.push(codePercents);
  }

  if (coveredWeight <= 0) return { ...empty, perStockPercents };

  const metrics = {
    pe: epSum > 0 ? round(1 / epSum) : null,
    pb: rawWeight.pb > 0 ? round(rawSum.pb / rawWeight.pb) : null,
    ps: rawWeight.ps > 0 ? round(rawSum.ps / rawWeight.ps) : null
  };
  for (const key of pctKeys) {
    metrics[`${key}Percentile`] = pctWeight[key] > 0 ? round(pctSum[key] / pctWeight[key], 1) : null;
  }

  // 快照指标（无日频历史，区间内视为常量）
  if (snapshot) {
    for (const key of ['peg', 'dividendYield', 'dividendPayoutRatio', 'roe', 'epsGrowth', 'revenueGrowth']) {
      metrics[key] = lodash.isNumber(snapshot[key]) && Number.isFinite(snapshot[key]) ? snapshot[key] : null;
    }
  }

  const samples = {};
  for (const key of pctKeys) {
    samples[key] = sampleWeight[key] > 0 ? Math.round(sampleSum[key] / sampleWeight[key]) : 0;
  }

  const percents = {};
  for (const key of pctKeys) percents[key] = metrics[`${key}Percentile`];

  return {
    metrics,
    coveredWeight,
    normSum,
    percents,
    samples,
    dispersion: {
      pe: round(stdDev(pctValues.pe), 1),
      pb: round(stdDev(pctValues.pb), 1),
      ps: round(stdDev(pctValues.ps), 1)
    },
    lossWeight: round((lossWeight / coveredWeight) * 100, 1) ?? 0,
    perStockPercents
  };
};

/**
 * 离散步长的解读：把标准差翻成人话。
 *
 * @param {number|null|undefined} dispersion
 * @returns {'concentrated'|'mixed'|'split'|null}
 */
export const describeDispersion = (dispersion) => {
  if (!lodash.isNumber(dispersion) || !Number.isFinite(dispersion)) return null;
  if (dispersion < 15) return 'concentrated';
  if (dispersion < 28) return 'mixed';
  return 'split';
};

export const __test__ = { MIN_REFERENCE_SAMPLES, PERCENTILE_METRIC_KEYS, EXTRA_PERCENTILE_KEYS };
