/**
 * 记录每次调用基金估值接口的结果，用于分时图。
 *
 * 存储格式：{ [code]: { [dataSource]: [{ date, time, gsz, gszzl, dwjz }] } }
 *
 * 口径说明（2026-03-21 第三批）：
 * - 早期版本只存 { time, value, date } 且「换了日期就整段清空」，导致分时图永远只有当天、
 *   也无法跨日比较（净值本身每天变，直接连净值曲线会在收盘/开盘之间断层）。
 * - 现在保留最近 MAX_TRADING_DAYS 个交易日的点，并把当次估算的三个口径一起落盘：
 *   gsz（估算净值）、gszzl（估算涨跌幅，跨日可比，画图默认轴）、dwjz（参考用的单位净值）。
 * - `value` 字段保留为 gsz 的别名，兼容旧调用方（旧数据没有 gszzl，读取时按需回退）。
 *
 * 容量：单日最多 MAX_POINTS_PER_DAY 点、单基金单数据源最多 MAX_TOTAL_POINTS 点。
 * 9:15-15:00 每 1 分钟一点约 240 点/日，5 日 ≈ 1200 点 ≈ 60KB，仍在 localStorage 承受范围内。
 */
import lodash from 'lodash';

const { isArray, isFunction, isNumber, isPlainObject, isString } = lodash;

const STORAGE_KEY = 'fundValuationTimeseries';

/** 保留的交易日数（含当日） */
export const MAX_TRADING_DAYS = 5;
/** 单日最多保留点数 */
export const MAX_POINTS_PER_DAY = 300;
/** 单基金单数据源最多保留点数 */
export const MAX_TOTAL_POINTS = 1200;

/** 写盘失败后的内存兜底（避免每次刷新都抛错、也避免把已有数据读丢） */
let memoryCache = null;
let degraded = false;
/**
 * 存储适配器（`storageStore`）。
 *
 * 通过 `bindTimeseriesStorage` 注入而不是直接 import：直接 import `@/app/stores`
 * 会把 zustand + 常量 + fundHelpers 整条依赖链拖进来，导致这个模块在纯 node 下
 * 无法单独测试。注入后未绑定时退化为「纯内存」，不抛错。
 */
let storageAdapter = null;

/**
 * 绑定存储适配器（应用启动时调用一次，见 app/lib/timeseriesStorageBind.js）
 * @param {{getItem: Function, setItem: Function}} adapter
 */
export function bindTimeseriesStorage(adapter) {
  storageAdapter = adapter && isFunction(adapter.getItem) && isFunction(adapter.setItem) ? adapter : null;
  // 重新绑定后必须重读，否则会一直用绑定前那份内存快照
  memoryCache = null;
}

function getStored() {
  if (memoryCache) return memoryCache;
  if (!storageAdapter) return {};
  try {
    const parsed = storageAdapter.getItem(STORAGE_KEY);
    memoryCache = isPlainObject(parsed) ? parsed : {};
  } catch {
    memoryCache = {};
  }
  return memoryCache;
}

function setStored(data) {
  memoryCache = data;
  if (!storageAdapter) return;
  try {
    storageAdapter.setItem(STORAGE_KEY, JSON.stringify(data));
    degraded = false;
  } catch (e) {
    // 配额写满等场景：降级为纯内存，本轮会话仍能画图，但刷新页面会丢
    degraded = true;
    console.warn('valuationTimeseries persist failed, falling back to memory', e);
  }
}

/**
 * 写盘是否已降级为纯内存（供 UI 提示一次）
 * @returns {boolean}
 */
export function isTimeseriesPersistDegraded() {
  return degraded;
}

/** 复位降级标记（已提示过之后调用，避免重复 toast） */
export function clearTimeseriesPersistDegraded() {
  degraded = false;
}

/** 测试用：清空内存缓存 */
export function __resetTimeseriesCache() {
  memoryCache = null;
  degraded = false;
}

/**
 * 从 gztime 或 Date 得到日期字符串 YYYY-MM-DD
 */
function toDateStr(gztimeOrNow) {
  if (isString(gztimeOrNow) && /^\d{4}-\d{2}-\d{2}/.test(gztimeOrNow)) {
    return gztimeOrNow.slice(0, 10);
  }
  try {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return null;
  }
}

function toFiniteOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 归一化一个分时点：兼容旧格式 { time, value, date } 与新格式 { date, time, gsz, gszzl, dwjz }
 * @param {object} raw
 * @returns {{ date: string, time: string, gsz: number|null, gszzl: number|null, dwjz: number|null, value: number|null }|null}
 */
function normalizePoint(raw) {
  if (!isPlainObject(raw)) return null;
  const date = isString(raw.date) && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  const time = isString(raw.time) ? raw.time.slice(0, 5) : null;
  if (!date || !time) return null;
  const gsz = toFiniteOrNull(raw.gsz ?? raw.value);
  const gszzl = toFiniteOrNull(raw.gszzl);
  const dwjz = toFiniteOrNull(raw.dwjz);
  if (gsz == null && gszzl == null) return null;
  return { date, time, gsz, gszzl, dwjz, value: gsz };
}

function pointKey(p) {
  return `${p.date} ${p.time}`;
}

/**
 * 清洗序列：去重（同日同分钟保留后写入者）、按日截断、只保留最近 MAX_TRADING_DAYS 个交易日
 * @param {Array<object>} series
 * @returns {Array<object>}
 */
export function pruneSeries(series) {
  if (!isArray(series)) return [];
  const byKey = new Map();
  for (const raw of series) {
    const p = normalizePoint(raw);
    if (!p) continue;
    byKey.set(pointKey(p), p);
  }
  const all = Array.from(byKey.values()).sort((a, b) =>
    a.date === b.date ? (a.time < b.time ? -1 : 1) : a.date < b.date ? -1 : 1
  );

  // 按日分组后只保留最近 N 个交易日
  const dayCount = new Map();
  for (const p of all) dayCount.set(p.date, (dayCount.get(p.date) || 0) + 1);
  const keepDays = new Set(Array.from(dayCount.keys()).sort().slice(-MAX_TRADING_DAYS));

  const perDay = new Map();
  for (const p of all) {
    if (!keepDays.has(p.date)) continue;
    if (!perDay.has(p.date)) perDay.set(p.date, []);
    perDay.get(p.date).push(p);
  }
  const kept = [];
  for (const date of Array.from(perDay.keys()).sort()) {
    const dayPts = perDay.get(date);
    // 超量时丢最早的点，保住最新的走势
    kept.push(...(dayPts.length > MAX_POINTS_PER_DAY ? dayPts.slice(dayPts.length - MAX_POINTS_PER_DAY) : dayPts));
  }
  return kept.length > MAX_TOTAL_POINTS ? kept.slice(kept.length - MAX_TOTAL_POINTS) : kept;
}

/**
 * 获取指定基金指定数据源的分时序列
 * @param {string} code
 * @param {number} dataSource
 * @returns {Array<object>}
 */
function getSeriesBySource(code, dataSource) {
  const all = getStored();
  const ds = String(dataSource || 1);
  const fundData = all[code];
  if (!isPlainObject(fundData)) return [];
  return isArray(fundData[ds]) ? fundData[ds].map(normalizePoint).filter(Boolean) : [];
}

/**
 * 记录一条估值。
 *
 * @param {string} code - 基金代码
 * @param {{ gsz?: number|null, gszzl?: number|null, dwjz?: number|null, gztime?: string|null }} payload
 * @param {number} [dataSource=1] - 数据源编号
 * @returns {Array<object>} 该基金当前数据源的分时序列（按时间升序）
 */
export function recordValuation(code, payload, dataSource = 1) {
  const gztime = payload?.gztime ?? null;
  const dateStr = toDateStr(gztime);
  if (!dateStr) return getSeriesBySource(code, dataSource);

  const timeLabel =
    isString(gztime) && gztime.length > 10
      ? gztime.slice(11, 16)
      : (() => {
          const d = new Date();
          return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        })();

  const point = normalizePoint({
    date: dateStr,
    time: timeLabel,
    gsz: payload?.gsz,
    gszzl: payload?.gszzl,
    dwjz: payload?.dwjz
  });
  // gsz 与 gszzl 都为空的点没有作图价值，直接忽略（旧实现要求 gsz 有效）
  if (!point) return getSeriesBySource(code, dataSource);

  const all = getStored();
  const ds = String(dataSource || 1);
  if (!isPlainObject(all[code])) all[code] = {};
  const list = isArray(all[code][ds]) ? all[code][ds] : [];

  const nextList = pruneSeries([...list, point]);
  all[code][ds] = nextList;
  setStored(all);
  return nextList;
}

/**
 * 批量设置指定基金指定数据源的分时序列（数据源 2/3 使用，也会做清洗与容量截断）
 * @param {string} code
 * @param {number} dataSource
 * @param {Array<object>} series
 */
export function setValuationSeries(code, dataSource, series) {
  if (!code || !isArray(series) || series.length === 0) return;
  const all = getStored();
  const ds = String(dataSource || 1);
  if (!isPlainObject(all[code])) all[code] = {};
  all[code][ds] = pruneSeries(series);
  setStored(all);
}

/**
 * 获取某基金当前数据源的分时序列（只读）
 * @param {string} code - 基金代码
 * @param {number} [dataSource=1] - 数据源编号
 * @returns {Array<object>}
 */
export function getValuationSeries(code, dataSource = 1) {
  return getSeriesBySource(code, dataSource);
}

/**
 * 删除某基金的全部分时数据（如用户删除该基金时调用）
 * @param {string} code
 */
export function clearFund(code) {
  const all = getStored();
  if (!(code in all)) return;
  const next = { ...all };
  delete next[code];
  setStored(next);
}

/**
 * 获取全部分时数据，按基金当前数据源展平，用于页面初始 state
 * 格式：{ [code]: Array<object> }
 * @param {Array} [funds] - 可选的基金列表，用于确定每个基金的当前数据源
 * @returns {{ [code: string]: Array<object> }}
 */
export function getAllValuationSeries(funds) {
  const all = getStored();
  const result = {};
  // 构建 code -> dataSource 映射
  const dsMap = new Map();
  if (isArray(funds)) {
    for (const f of funds) {
      if (f?.code) dsMap.set(f.code, String(f.dataSource || 1));
    }
  }
  for (const [code, dsDataMap] of Object.entries(all)) {
    if (!isPlainObject(dsDataMap)) continue;
    // 优先使用基金当前数据源的数据
    const currentDs = dsMap.get(code);
    if (currentDs && isArray(dsDataMap[currentDs]) && dsDataMap[currentDs].length > 0) {
      result[code] = dsDataMap[currentDs].map(normalizePoint).filter(Boolean);
      continue;
    }
    // 回退：取第一个有数据的数据源
    for (const series of Object.values(dsDataMap)) {
      if (isArray(series) && series.length > 0) {
        result[code] = series.map(normalizePoint).filter(Boolean);
        break;
      }
    }
  }
  return result;
}

/**
 * 获取全部原始数据（含数据源分层），用于云端同步
 * @returns {{ [code: string]: { [dataSource: string]: Array } }}
 */
export function getAllValuationSeriesRaw() {
  return getStored();
}

export const __test__ = {
  normalizePoint,
  pruneSeries,
  toDateStr,
  MAX_TRADING_DAYS,
  MAX_POINTS_PER_DAY,
  MAX_TOTAL_POINTS
};
