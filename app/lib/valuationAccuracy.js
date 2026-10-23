import lodash from 'lodash';

/**
 * 实时估值的「误差历史」。
 *
 * 现有实现只能回答「今天哪个数据源最准」（Supabase RPC best-valuation-source，
 * 拿当日估算涨幅和确权涨幅比一次），这带来两个问题：
 *   1. 单日样本噪声极大，选出来的「最准」第二天可能就换人；
 *   2. 没有历史，用户无法判断「这个估值本身有多可信」。
 *
 * 这里在本地按「基金 × 交易日」记录两件事：
 *   - 盘中最后一次估算涨幅（gszzl）及其数据源；
 *   - 该交易日最终确权的净值涨幅（zzl）。
 * 两者配对后得到一组误差样本，进而可以算 MAE、系统偏差（bias）、方向命中率，
 * 以及按数据源分组的 MAE —— 数据源优劣由自己的历史决定，而不是一天的运气。
 *
 * 存储结构（localStorage: valuationAccuracy）：
 *   { [fundCode]: { samples: [{ date, source, estimate, actual, absErr, signedErr }] } }
 *
 * 纯函数（summarizeSamples / upsertSample / pruneSamples）与存储读写分离，
 * 便于单测；写盘走 storageStore，符合项目「禁止直接用 window.localStorage」的约束。
 */

/** 每只基金保留的样本上限（约半年交易日，足够估计 MAE 又不会无限膨胀） */
export const ACCURACY_SAMPLE_CAP = 120;
/** 统计至少要几个样本才给出结论（少于 3 个样本的 MAE 没有意义） */
export const ACCURACY_MIN_SAMPLES = 3;
/** 近期窗口：滚动最近 N 个已配对样本（约一个月交易日），近期表现比全历史更能预测今天 */
export const ACCURACY_WINDOW = 20;
/** 校准所需的最少窗口样本：20 日窗口要满才能拿出来当校正系数 */
export const ACCURACY_CALIBRATION_MIN_SAMPLES = 20;
/** 系统偏差超过该值（百分点）才值得校准；小于它属于噪声，硬校准反而引入误差 */
export const ACCURACY_BIAS_THRESHOLD = 0.15;

const isFiniteNumber = (v) => lodash.isNumber(v) && Number.isFinite(v);

/**
 * 汇总误差样本。
 *
 * @param {Array<{estimate?: number, actual?: number, absErr?: number, signedErr?: number, source?: string}>} samples
 * @returns {{samples: number, mae: number|null, bias: number|null, hitRate: number|null,
 *   worst: number|null, bySource: Array<{source: string, samples: number, mae: number|null}>}}
 */
const round2 = (v) => Number(v.toFixed(2));

/**
 * 只取「已配对」的样本（既有估算也有确权涨幅），按日期升序。
 * 未配对的样本只是记了一笔估算，还没法算误差。
 *
 * @param {Array} samples
 * @returns {Array}
 */
export const settledSamples = (samples) =>
  (lodash.isArray(samples) ? samples : [])
    .filter((s) => isFiniteNumber(s?.estimate) && isFiniteNumber(s?.actual))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

/**
 * 一组样本的核心误差指标（MAE / RMSE / 系统偏差 / 方向命中率）。
 *
 * MAE 与 RMSE 一起看：二者接近说明误差均匀，RMSE 明显大于 MAE 说明存在少数大偏差日，
 * 那种情况下「平均表现」会骗人。
 *
 * @param {Array} usable
 * @returns {{samples: number, mae: number|null, rmse: number|null, bias: number|null, hitRate: number|null, worst: number|null}}
 */
const computeErrorStats = (usable) => {
  if (usable.length === 0) {
    return { samples: 0, mae: null, rmse: null, bias: null, hitRate: null, worst: null };
  }
  let absSum = 0;
  let signedSum = 0;
  let sqSum = 0;
  let hits = 0;
  let worst = 0;
  for (const s of usable) {
    const diff = s.estimate - s.actual;
    const abs = Math.abs(diff);
    absSum += abs;
    signedSum += diff;
    sqSum += diff * diff;
    worst = Math.max(worst, abs);
    if (diff === 0 || Math.sign(diff) === Math.sign(s.actual)) hits += 1;
  }
  return {
    samples: usable.length,
    // 平均绝对误差：涨跌幅口径的百分点
    mae: round2(absSum / usable.length),
    // 均方根误差：对大偏差更敏感，与 MAE 差距大说明误差分布有肥尾
    rmse: round2(Math.sqrt(sqSum / usable.length)),
    // 系统偏差：正值表示估值系统性偏高
    bias: round2(signedSum / usable.length),
    hitRate: Math.round((hits / usable.length) * 100),
    worst: round2(worst)
  };
};

/**
 * 汇总误差样本（全历史 + 最近 ACCURACY_WINDOW 个已配对样本）。
 *
 * @param {Array<{estimate?: number, actual?: number, absErr?: number, signedErr?: number, source?: string}>} samples
 * @returns {{samples: number, pending: number, mae: number|null, rmse: number|null, bias: number|null,
 *   hitRate: number|null, worst: number|null, recent: object, bySource: Array}}
 */
export const summarizeSamples = (samples) => {
  const list = lodash.isArray(samples) ? samples : [];
  const usable = settledSamples(list);
  const stats = computeErrorStats(usable);
  const recent = computeErrorStats(usable.slice(-ACCURACY_WINDOW));

  const sourceMap = new Map();
  for (const s of usable) {
    const key = s.source || 'unknown';
    const bucket = sourceMap.get(key) || { source: key, samples: 0, absSum: 0 };
    bucket.samples += 1;
    bucket.absSum += Math.abs(s.estimate - s.actual);
    sourceMap.set(key, bucket);
  }

  return {
    ...stats,
    // 还没配对（今天刚记、净值未出）的样本数，用于向用户解释「为什么样本没变化」
    pending: list.length - usable.length,
    recent,
    bySource: [...sourceMap.values()]
      .map((b) => ({ source: b.source, samples: b.samples, mae: round2(b.absSum / b.samples) }))
      .sort((a, b) => a.mae - b.mae)
  };
};

/**
 * 用近期系统偏差校准估值。
 *
 * 逻辑：若最近 20 个样本的 bias 稳定偏高（>+0.15pt 或 <-0.15pt）且样本满 20，
 * 说明这个数据源对这只基金存在系统性偏移，把 bias 减掉比原样展示更接近确权值。
 *
 * 注意：只在「有足够样本 + 偏差显著」时校准，否则返回原值 —— 拿两三个样本校准会把噪声当系数。
 *
 * @param {number} estimate - 原始估算涨幅（百分点）
 * @param {object} summary - summarizeSamples 的返回值
 * @returns {{value: number, applied: boolean, adjustment: number, samples: number, reason: string|null}}
 */
export const calibrateEstimate = (estimate, summary) => {
  const base = { value: estimate, applied: false, adjustment: 0, samples: summary?.recent?.samples || 0, reason: null };
  if (!isFiniteNumber(estimate)) return { ...base, value: null, reason: 'invalid' };
  const recent = summary?.recent;
  if (!recent || !isFiniteNumber(recent.bias)) return { ...base, reason: 'no-data' };
  if (recent.samples < ACCURACY_CALIBRATION_MIN_SAMPLES) return { ...base, reason: 'insufficient' };
  if (Math.abs(recent.bias) < ACCURACY_BIAS_THRESHOLD) return { ...base, reason: 'not-significant' };
  return {
    value: Number((estimate - recent.bias).toFixed(2)),
    applied: true,
    adjustment: -recent.bias,
    samples: recent.samples,
    reason: null
  };
};

/**
 * 写入/更新一条「当日估算」样本（同一日期重复刷新时后来者覆盖，保留已有确权结果）。
 *
 * @param {Array} samples
 * @param {{date: string, source?: string, estimate: number, actual?: number|null}} entry
 * @param {number} [cap]
 * @returns {Array}
 */
export const upsertSample = (samples, entry, cap = ACCURACY_SAMPLE_CAP) => {
  if (!entry?.date || !isFiniteNumber(entry.estimate)) {
    return lodash.isArray(samples) ? samples : [];
  }
  const list = lodash.isArray(samples) ? samples : [];
  const existing = list.find((s) => s.date === entry.date);
  const merged = {
    date: entry.date,
    source: entry.source || existing?.source || 'unknown',
    estimate: entry.estimate,
    actual: isFiniteNumber(entry.actual) ? entry.actual : (existing?.actual ?? null)
  };
  // 误差保留 4 位小数：0.9 - 1.0 这类浮点差值不该带着 1e-17 的尾巴进存储
  merged.signedErr = isFiniteNumber(merged.actual) ? Number((merged.estimate - merged.actual).toFixed(4)) : null;
  merged.absErr = merged.signedErr == null ? null : Number(Math.abs(merged.signedErr).toFixed(4));

  const next = existing ? list.map((s) => (s.date === entry.date ? merged : s)) : [...list, merged];
  return pruneSamples(next, cap);
};

/**
 * 把某交易日的「确权涨幅」回填到已有估算样本上。
 *
 * @param {Array} samples
 * @param {{date: string, actual: number}} params
 * @returns {Array} 原数组（没有对应估算样本时不做改动）
 */
export const settleSample = (samples, { date, actual }) => {
  if (!lodash.isArray(samples) || !date || !isFiniteNumber(actual)) return samples || [];
  if (!samples.some((s) => s.date === date)) return samples;
  const target = samples.find((s) => s.date === date);
  return upsertSample(samples, { date, estimate: target.estimate, source: target.source, actual });
};

/**
 * 截断到 cap 条：按日期升序保留最近的 cap 天。
 *
 * @param {Array<{date: string}>} samples
 * @param {number} [cap]
 * @returns {Array}
 */
export const pruneSamples = (samples, cap = ACCURACY_SAMPLE_CAP) => {
  const list = (lodash.isArray(samples) ? samples : []).filter((s) => s?.date);
  const sorted = [...list].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return sorted.length <= cap ? sorted : sorted.slice(sorted.length - cap);
};

/**
 * 绑定存储的控制器。
 *
 * @param {{getItem: Function, setItem: Function, key?: string}} deps
 */
export const createAccuracyStore = ({ getItem, setItem, key = 'valuationAccuracy' }) => {
  const read = () => {
    const raw = getItem(key, {});
    return lodash.isObject(raw) && !lodash.isArray(raw) ? raw : {};
  };

  const write = (code, samples) => {
    const all = read();
    all[code] = { samples: pruneSamples(samples) };
    setItem(key, all);
  };

  return {
    /** 记录盘中最后一次估算（同一交易日重复调用覆盖为最新一次） */
    recordEstimate: ({ code, date, estimate, source }) => {
      if (!code || !date || !isFiniteNumber(estimate)) return;
      const all = read();
      const samples = all[code]?.samples || [];
      write(code, upsertSample(samples, { date, estimate, source }));
    },

    /** 确权涨幅出来后回填误差 */
    settleActual: ({ code, date, actual }) => {
      if (!code || !date || !isFiniteNumber(actual)) return;
      const all = read();
      const samples = all[code]?.samples || [];
      const next = settleSample(samples, { date, actual });
      if (next !== samples) write(code, next);
    },

    /** 单只基金的误差统计 */
    getSummary: (code) => summarizeSamples(read()[code]?.samples),

    /** 单只基金的校准结果（估算涨幅 → 校准后的涨幅） */
    getCalibration: (code, estimate) => calibrateEstimate(estimate, summarizeSamples(read()[code]?.samples)),

    /** 全部基金合并统计（大数定律：跨基金的 MAE 更能说明模型本身） */
    getAllSummary: () => {
      const all = read();
      return summarizeSamples(Object.values(all).flatMap((v) => (lodash.isArray(v?.samples) ? v.samples : [])));
    },

    /** 原始样本（调试 / 导出用） */
    getSamples: (code) => read()[code]?.samples || [],

    reset: () => setItem(key, {})
  };
};

/**
 * storageStore 的延迟引用。
 * 这个模块被 useRefreshManager（客户端）和 Selector 共用；把 store import 放在顶层
 * 会让纯函数单测也被迫加载 zustand + localStorage，所以由调用方注入。
 */
let storageStoreRef = null;

/** 注入真实的 storageStore（见 app/hooks/useRefreshManager.js 顶部） */
export const bindAccuracyStorage = (store) => {
  if (store && lodash.isFunction(store.getItem) && lodash.isFunction(store.setItem)) {
    storageStoreRef = store;
  }
};

/** 默认实例：读写都走注入的 storageStore（未注入时静默降级为不落盘） */
export const valuationAccuracy = createAccuracyStore({
  getItem: (k, d) => (storageStoreRef ? storageStoreRef.getItem(k, d) : d),
  setItem: (k, v) => {
    if (storageStoreRef) storageStoreRef.setItem(k, v);
  }
});
