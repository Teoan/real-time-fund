/**
 * 记录每次调用基金估值接口的结果，用于分时图。
 *
 * 存储格式：每只基金一个 key `fundValuationTimeseries:{code}`，值形如
 *   { [dataSource]: [{ date, time, gsz, gszzl, dwjz }] }
 *
 * 为什么按基金拆 key（2026-03 P0 性能修复）：
 * - 旧版全部分时数据存在一个 key 里，`recordValuation` 每次都把「所有基金 × 所有数据源」
 *   整体 stringify 写回。20 只 × 1200 点 ≈ 2.3MB，单次写入 ≈ 12ms 的 stringify + 同步落盘，
 *   而 useRefreshManager 一轮刷新对每只基金都调一次 → 一轮 ≈ 1.1s 主线程（30s 一轮）。
 * - 拆键后单次写入只序列化一只基金（≈115KB / ≤0.5ms），写放大从 O(全部基金) 降到 O(1)。
 * - 旧 key 会在首次读取时自动迁移成新格式并删除（见 migrateLegacyStorage）。
 *
 * 口径说明（2026-03-21 第三批）：
 * - 早期版本只存 { time, value, date } 且「换了日期就整段清空」，导致分时图永远只有当天、
 *   也无法跨日比较（净值本身每天变，直接连净值曲线会在收盘/开盘之间断层）。
 * - 现在保留最近 MAX_TRADING_DAYS 个交易日的点，并把当次估算的三个口径一起落盘：
 *   gsz（估算净值）、gszzl（估算涨跌幅，跨日可比，画图默认轴）、dwjz（参考用的单位净值）。
 * - `value` 字段保留为 gsz 的别名，兼容旧调用方（旧数据没有 gszzl，读取时按需回退）。
 *
 * 容量：单日最多 MAX_POINTS_PER_DAY 点、单基金单数据源最多 MAX_TOTAL_POINTS 点。
 * 9:15-15:00 每 1 分钟一点约 240 点/日，5 日 ≈ 1200 点 ≈ 115KB/基金。
 */
import lodash from 'lodash';

import { TIMESERIES_KEY_PREFIX, TIMESERIES_LEGACY_KEY } from './storageKeys.js';

const { isArray, isFunction, isNumber, isPlainObject, isString } = lodash;

/** 保留的交易日数（含当日） */
export const MAX_TRADING_DAYS = 5;
/** 单日最多保留点数 */
export const MAX_POINTS_PER_DAY = 300;
/** 单基金单数据源最多保留点数 */
export const MAX_TOTAL_POINTS = 1200;

/** 写盘失败后的内存兜底（避免每次刷新都抛错、也避免把已有数据读丢） */
let memoryCache = new Map();
/** 已经从存储里读过（或确认不存在）的基金代码 */
let loadedCodes = new Set();
let degraded = false;
let legacyMigrated = false;

/**
 * 存储适配器（`storageStore`）。
 *
 * 通过 `bindTimeseriesStorage` 注入而不是直接 import：直接 import `@/app/stores`
 * 会把 zustand + 常量 + fundHelpers 整条依赖链拖进来，导致这个模块在纯 node 下
 * 无法单独测试。注入后未绑定时退化为「纯内存」，不抛错。
 *
 * 需要的接口：
 * - getItem(key) / setItem(key, raw)  读写单个基金
 * - removeItem?(key)                  清理（可选）
 * - keysWithPrefix?(prefix)           枚举有哪些基金（可选；缺失时退化为「只认识读写过的基金」）
 */
let storageAdapter = null;

/**
 * 绑定存储适配器（应用启动时调用一次，见 app/lib/timeseriesStorageBind.js）
 * @param {{getItem: Function, setItem: Function, removeItem?: Function, keysWithPrefix?: Function}} adapter
 */
export function bindTimeseriesStorage(adapter) {
  storageAdapter = adapter && isFunction(adapter.getItem) && isFunction(adapter.setItem) ? adapter : null;
  // 重新绑定后必须重读，否则会一直用绑定前那份内存快照
  resetCache();
}

function resetCache() {
  memoryCache = new Map();
  loadedCodes = new Set();
  legacyMigrated = false;
  degraded = false;
}

/** 单只基金的存储 key */
export function storageKeyForCode(code) {
  return `${TIMESERIES_KEY_PREFIX}${code}`;
}

/**
 * 把旧版单一大 key 迁移为按基金分键。
 * 只跑一次；没有任何旧数据时是空转（一次 getItem 命中 null）。
 */
function migrateLegacyStorage() {
  if (legacyMigrated) return;
  legacyMigrated = true;
  if (!storageAdapter) return;
  let legacy = null;
  try {
    legacy = storageAdapter.getItem(TIMESERIES_LEGACY_KEY);
  } catch {
    legacy = null;
  }
  if (!isPlainObject(legacy)) return;

  const codes = Object.keys(legacy);
  for (const code of codes) {
    const dsMap = legacy[code];
    if (!isPlainObject(dsMap)) continue;
    const target = isPlainObject(memoryCache.get(code)) ? memoryCache.get(code) : {};
    for (const [ds, series] of Object.entries(dsMap)) {
      if (isArray(series) && !isArray(target[ds])) {
        target[ds] = series.map(normalizePoint).filter(Boolean);
      }
    }
    memoryCache.set(code, target);
    loadedCodes.add(code);
  }
  // 先落分键，再删旧大 key：中途失败最多是「多写一份」，不会丢数据
  for (const code of codes) persistFund(code);
  if (isFunction(storageAdapter.removeItem)) {
    try {
      storageAdapter.removeItem(TIMESERIES_LEGACY_KEY);
    } catch {
      // ignore
    }
  }
}

/** 读取单只基金的分层数据（`{ [ds]: points[] }`），返回内存中的引用 */
function getFundData(code) {
  if (!isString(code) || !code) return {};
  migrateLegacyStorage();
  if (!loadedCodes.has(code)) {
    loadedCodes.add(code);
    let data = null;
    if (storageAdapter) {
      try {
        const parsed = storageAdapter.getItem(storageKeyForCode(code));
        if (isPlainObject(parsed)) data = parsed;
      } catch {
        data = null;
      }
    }
    memoryCache.set(code, isPlainObject(data) ? data : {});
  }
  const cached = memoryCache.get(code);
  return isPlainObject(cached) ? cached : {};
}

/** 落盘单只基金（只序列化这一只，不再写全部） */
function persistFund(code) {
  if (!storageAdapter) return;
  const data = memoryCache.get(code);
  if (!isPlainObject(data)) return;
  try {
    storageAdapter.setItem(storageKeyForCode(code), JSON.stringify(data));
    degraded = false;
  } catch (e) {
    // 配额写满等场景：降级为纯内存，本轮会话仍能画图，但刷新页面会丢
    degraded = true;
    console.warn('valuationTimeseries persist failed, falling back to memory', e);
  }
}

/** 已知的基金代码集合（存储中 + 内存中） */
function listCodes() {
  migrateLegacyStorage();
  const codes = new Set(loadedCodes);
  for (const code of memoryCache.keys()) codes.add(code);
  if (storageAdapter && isFunction(storageAdapter.keysWithPrefix)) {
    try {
      for (const key of storageAdapter.keysWithPrefix(TIMESERIES_KEY_PREFIX)) {
        if (isString(key) && key.startsWith(TIMESERIES_KEY_PREFIX)) {
          codes.add(key.slice(TIMESERIES_KEY_PREFIX.length));
        }
      }
    } catch {
      // ignore
    }
  }
  return Array.from(codes).filter(Boolean);
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

/**
 * 由 storageStore 的写盘失败回调触发（`setItem` 改为延迟落盘后不再同步抛错）。
 * 只关心分时序列自己的 key，其它 key 的失败由各自模块处理。
 * @param {{ key?: string }} info
 */
export function notifyPersistError(info) {
  const key = info?.key;
  if (isString(key) && key.startsWith(TIMESERIES_KEY_PREFIX)) degraded = true;
}

/** 测试用：清空内存缓存 */
export function __resetTimeseriesCache() {
  resetCache();
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
  const ds = String(dataSource || 1);
  const fundData = getFundData(code);
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

  const ds = String(dataSource || 1);
  const fundData = getFundData(code);
  const list = isArray(fundData[ds]) ? fundData[ds] : [];

  const nextList = pruneSeries([...list, point]);
  fundData[ds] = nextList;
  persistFund(code);
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
  const ds = String(dataSource || 1);
  const fundData = getFundData(code);
  fundData[ds] = pruneSeries(series);
  persistFund(code);
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
  if (!isString(code) || !code) return;
  memoryCache.delete(code);
  loadedCodes.delete(code);
  if (!storageAdapter || !isFunction(storageAdapter.removeItem)) return;
  try {
    storageAdapter.removeItem(storageKeyForCode(code));
  } catch {
    // ignore
  }
}

/**
 * 获取全部分时数据，按基金当前数据源展平，用于页面初始 state
 * 格式：{ [code]: Array<object> }
 * @param {Array} [funds] - 可选的基金列表，用于确定每个基金的当前数据源
 * @returns {{ [code: string]: Array<object> }}
 */
export function getAllValuationSeries(funds) {
  const result = {};
  // 构建 code -> dataSource 映射
  const dsMap = new Map();
  if (isArray(funds)) {
    for (const f of funds) {
      if (f?.code) dsMap.set(f.code, String(f.dataSource || 1));
    }
  }
  for (const code of listCodes()) {
    const dsDataMap = getFundData(code);
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
 * 获取全部原始数据（含数据源分层），用于云端同步。
 * 分键存储对同步侧透明：仍然返回 `{ [code]: { [dataSource]: Array } }` 的整块结构。
 * @returns {{ [code: string]: { [dataSource: string]: Array } }}
 */
export function getAllValuationSeriesRaw() {
  const result = {};
  for (const code of listCodes()) {
    const dsDataMap = getFundData(code);
    if (!isPlainObject(dsDataMap)) continue;
    // 外层与数源各拷一层，避免同步侧合并时原地修改污染内存镜像
    const copy = {};
    let hasData = false;
    for (const [ds, series] of Object.entries(dsDataMap)) {
      if (!isArray(series)) continue;
      copy[ds] = series.slice();
      hasData = true;
    }
    if (hasData) result[code] = copy;
  }
  return result;
}

/**
 * 用云端数据整体覆盖本地的分时序列（云端同步恢复用）。
 * 只更新传入的基金，其余基金保持不动——与原「写单个大 key 时先合并再覆盖」的行为一致。
 * @param {{ [code: string]: { [dataSource: string]: Array } }} raw
 */
export function replaceAllValuationSeriesRaw(raw) {
  if (!isPlainObject(raw)) return;
  const nextCodes = new Set();
  for (const [code, dsDataMap] of Object.entries(raw)) {
    if (!isString(code) || !code || !isPlainObject(dsDataMap)) continue;
    const target = {};
    for (const [ds, series] of Object.entries(dsDataMap)) {
      if (isArray(series)) target[ds] = series;
    }
    memoryCache.set(code, target);
    loadedCodes.add(code);
    nextCodes.add(code);
    persistFund(code);
  }
  // 传入里有、但清洗后没剩下任何数据的基金，视为清空
  for (const code of Object.keys(raw)) {
    if (nextCodes.has(code)) continue;
    clearFund(code);
  }
}

export const __test__ = {
  normalizePoint,
  pruneSeries,
  toDateStr,
  storageKeyForCode,
  listCodes,
  MAX_TRADING_DAYS,
  MAX_POINTS_PER_DAY,
  MAX_TOTAL_POINTS
};
