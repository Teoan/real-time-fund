/**
 * 业绩基准（指数）日线序列本地缓存（IndexedDB，仓库 fundBenchmark）
 *
 * 为什么单独一个模块而不是塞进 fundVolatilityCache：
 *   1. **键是 secid 而不是基金代码**。沪深300 一条序列服务几百只基金，
 *      按基金代码存会成倍放大存储，也让「换基准」变成每只基金各存一份。
 *   2. **生命周期不同**。它不随单只基金删除而清理（clearFund 有意不清它），
 *      否则删掉一只基金就会让所有沪深300 基金的基准缓存一起消失。
 *
 * 缓存契约与 fundVolatilityCache 完全一致：
 *   - 记录写成 `{ _v, ts, data }`，版本号不符即删除并当未命中；
 *   - 新鲜期 6 小时，与 NAV_CACHE_TTL_MS 对齐，使「净值 + 基准」同批刷新；
 *   - adapter 可注入，单测无需 fake-indexeddb。
 *
 * 失败一律静默降级（返回 null / false），不抛给 UI：基准只是指标的一部分，
 * 取不到时应当只让 Alpha/Beta/信息比率变成 `--`，而不是把整个面板打成错误。
 */

// lodash 是 CJS 包：必须「默认导入 + 解构」才能被 node --test 直接加载（同 app/lib/valuationHistory.js）
import lodash from 'lodash';

import { idbClearStore, idbDelete, idbGet, idbSet, IDB_STORES } from './idb.js';
import { readVersionedRecord, writeVersionedRecord } from './fundVolatilityCache.js';

const { isArray, isNumber, isObject, isString } = lodash;

/**
 * 结构版本。字段增删改名、或**口径变化**（例如把基准日线改成复权口径）都必须 +1，
 * 否则旧结构会被当作有效数据继续读出来。
 */
export const BENCHMARK_CACHE_VERSION = 1;

/** 基准序列新鲜期：与 NAV_CACHE_TTL_MS 对齐（指数收盘后日频更新，6 小时足够覆盖隔夜→盘后） */
export const BENCHMARK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** 默认 adapter：真实 IndexedDB */
const defaultAdapter = {
  get: idbGet,
  set: idbSet,
  delete: idbDelete,
  clear: idbClearStore
};

/** 归一化 secid（去空白；非字符串/空值一律视为无效键） */
const normalizeSecid = (secid) => {
  if (isNumber(secid)) return String(secid);
  return isString(secid) ? secid.trim() : '';
};

/** 序列清洗：只保留 `{ date, close }` 且两者有效的行，按日期升序去重 */
const sanitizeRows = (rows) => {
  if (!isArray(rows)) return [];
  const byDate = new Map();
  for (const row of rows) {
    if (!isObject(row)) continue;
    const date = isString(row.date) ? row.date.trim() : '';
    const close = Number(row.close);
    if (!date || !Number.isFinite(close)) continue;
    byDate.set(date, { date, close });
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};

/**
 * 创建一套基准序列缓存访问器。
 * @param {{ get: Function, set: Function, delete: Function, clear: Function }} [adapter]
 * @param {() => number} [now] 取当前时间戳（测试可注入）
 */
export const createFundBenchmarkCache = (adapter = defaultAdapter, now = () => Date.now()) => {
  /**
   * 读基准序列。
   * @param {string} secid 例如 '1.000300'
   * @returns {Promise<{ ts: number, name: string, rows: Array<{date: string, close: number}> }|null>}
   */
  const read = async (secid) => {
    const key = normalizeSecid(secid);
    if (!key) return null;
    const entry = await readVersionedRecord(adapter, IDB_STORES.BENCHMARK, key, BENCHMARK_CACHE_VERSION);
    if (!entry) return null;
    const rows = sanitizeRows(entry.data.rows);
    if (rows.length === 0) return null;
    return {
      ts: isNumber(entry.ts) ? entry.ts : 0,
      name: isString(entry.data.name) ? entry.data.name : '',
      rows
    };
  };

  /**
   * 写基准序列。
   * @param {string} secid
   * @param {{ name?: string, rows: Array<{date: string, close: number}> }} payload
   * @returns {Promise<boolean>}
   */
  const write = async (secid, payload) => {
    const key = normalizeSecid(secid);
    if (!key || !isObject(payload)) return false;
    const rows = sanitizeRows(payload.rows);
    if (rows.length === 0) return false;
    return writeVersionedRecord(
      adapter,
      IDB_STORES.BENCHMARK,
      key,
      BENCHMARK_CACHE_VERSION,
      { name: isString(payload.name) ? payload.name : '', rows, asOfDate: rows[rows.length - 1].date },
      now()
    );
  };

  /** 删掉某条基准缓存（下次强制重取） */
  const clear = async (secid) => {
    const key = normalizeSecid(secid);
    if (!key) return false;
    return adapter.delete(IDB_STORES.BENCHMARK, key);
  };

  return { read, write, clear };
};

/** 生产用缓存实例 */
export const fundBenchmarkCache = createFundBenchmarkCache();

/**
 * 基准缓存是否已过期（需要重新拉取）。
 * @param {{ ts: number, rows: Array<object> }|null} entry read 的返回值
 * @param {number} [nowTs]
 * @param {number} [ttl] 覆盖默认新鲜期
 */
export const isBenchmarkCacheStale = (entry, nowTs = Date.now(), ttl = BENCHMARK_CACHE_TTL_MS) => {
  if (!isObject(entry) || !isNumber(entry.ts) || entry.ts <= 0) return true;
  if (!isArray(entry.rows) || entry.rows.length === 0) return true;
  return nowTs - entry.ts >= ttl;
};
