/**
 * 波动信号本地缓存（IndexedDB）
 *
 * 对应规格 §3 的四类缓存数据，落成 4 个对象仓库（见 app/lib/idb.js 的 IDB_STORES）：
 *
 *   fundBasic   基金基本信息
 *   fundNav     基金历史净值
 *   fundRisk    基金风险指标
 *   fundSignal  基金波动信号
 *
 * 三个约定：
 *
 *   1. **版本号强制失效**：每条记录写成 `{ _v, ts, data }`。
 *      `_v` 与当前常量不一致时直接删除并当作未命中——否则改了字段名之后，
 *      旧结构会继续被读出来（表现为「某个指标恒为 null 且看不出原因」）。
 *      这与 app/providers/aktools/aktools-daily-cache.js 的做法一致。
 *
 *   2. **指标/信号按「净值指纹」复用**：只有 `asOfDate` 与 `navCount` 都和当前净值序列一致时，
 *      缓存的风险指标与波动信号才算有效。否则重算——避免净值补了新数据、
 *      指标却还是昨天算出来的错配。
 *
 *   3. **adapter 可注入**：默认走真实 IndexedDB，测试传假 adapter 即可，
 *      不必为单测引入 fake-indexeddb 依赖。
 */

// lodash 是 CJS 包：必须「默认导入 + 解构」才能被 node --test 直接加载（同 app/lib/valuationHistory.js）
import lodash from 'lodash';

import { idbClearStore, idbDelete, idbGet, idbSet, IDB_STORES } from './idb.js';
import {
  MAIN_VOLATILITY_WINDOW,
  PERCENTILE_WINDOW_YEARS,
  TRADING_DAYS_PER_YEAR,
  normalizeNavSeries,
  trimNavSeries
} from './fundVolatility.js';

const { isArray, isNumber, isObject, isString } = lodash;

/**
 * 各仓库的结构版本。
 *
 * ⚠️ 触发 +1 的两种情况（都踩过）：
 *   1. 字段增删改名；
 *   2. **口径变化**——即使字段没动，只要计算结果的含义变了也要 +1。
 *      例：日收益率的推导从「累计净值环比」改成「累计净值绝对额之差 ÷ 前一日单位净值」后，
 *      旧缓存里存的 dailyReturn 是错的，而 normalizeNavSeries 会原样保留已声明的 dailyReturn；
 *      不升版本就会把错误数据当有效数据继续复用。
 *
 * 版本沿革：
 *   v1 → v2：日收益率与回撤口径修正（累计净值环比 → 绝对额之差 ÷ 前一日单位净值；
 *            回撤改算在复权收益指数上）。NAV / METRICS / SIGNAL 一起升。
 *   v2 → v3：状态词表新增「回撤加深」、新增 60 日/当前回撤三个信号。
 *            只影响 SIGNAL（指标本身没变）。
 */
export const BASIC_CACHE_VERSION = 1;
export const NAV_CACHE_VERSION = 2;
export const METRICS_CACHE_VERSION = 2;
export const SIGNAL_CACHE_VERSION = 3;

/**
 * 净值缓存的新鲜期。
 *
 * 为什么不用「日期变了就失效」：周末和节假日永远不会有当天净值，
 * 那样每次打开都会重新拉一次全量历史（pingzhongdata 单只约几百 KB）。
 * 基金净值日频更新、且盘后才公布，6 小时足以覆盖「隔夜 → 盘后」的更新窗口，
 * 需要即时数据时走手动刷新（forceRefresh）。
 */
export const NAV_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 净值序列保留条数：近 5 年分位窗口 + 20 日波动率窗口 + 少量缓冲。
 * ≈ 1285 个交易日，足够算出全部分位/回撤指标。
 */
export const NAV_RETENTION_DAYS = PERCENTILE_WINDOW_YEARS * TRADING_DAYS_PER_YEAR + MAIN_VOLATILITY_WINDOW + 5;

/** 默认 adapter：真实 IndexedDB */
const defaultAdapter = {
  get: idbGet,
  set: idbSet,
  delete: idbDelete,
  clear: idbClearStore
};

/** 读一条带版本号的记录；版本不符或结构非法时删除并返回 null */
const readVersioned = async (adapter, store, key, version) => {
  const raw = await adapter.get(store, key);
  if (!isObject(raw) || raw._v !== version || !isObject(raw.data)) {
    if (raw != null) await adapter.delete(store, key);
    return null;
  }
  return { ts: isNumber(raw.ts) ? raw.ts : 0, data: raw.data };
};

/** 写一条带版本号的记录 */
const writeVersioned = (adapter, store, key, version, data, now) =>
  adapter.set(store, key, { _v: version, ts: now, data });

/**
 * 创建一套缓存访问器。
 * @param {{ get: Function, set: Function, delete: Function, clear: Function }} [adapter]
 * @param {() => number} [now] 取当前时间戳（测试可注入）
 */
export const createFundVolatilityCache = (adapter = defaultAdapter, now = () => Date.now()) => {
  /** 读历史净值 */
  const readNav = async (code) => {
    const key = String(code || '').trim();
    if (!key) return null;
    const entry = await readVersioned(adapter, IDB_STORES.NAV, key, NAV_CACHE_VERSION);
    if (!entry || !isArray(entry.data.rows)) return null;
    const rows = normalizeNavSeries(entry.data.rows);
    if (rows.length === 0) return null;
    return { ts: entry.ts, rows, asOfDate: rows[rows.length - 1].date };
  };

  /** 写历史净值（自动裁剪到保留窗口） */
  const writeNav = async (code, rows) => {
    const key = String(code || '').trim();
    if (!key) return false;
    const trimmed = trimNavSeries(normalizeNavSeries(rows), NAV_RETENTION_DAYS);
    if (trimmed.length === 0) return false;
    return writeVersioned(
      adapter,
      IDB_STORES.NAV,
      key,
      NAV_CACHE_VERSION,
      { rows: trimmed, asOfDate: trimmed[trimmed.length - 1].date },
      now()
    );
  };

  /**
   * 读风险指标（需净值指纹一致）。
   * @param {string} code
   * @param {{ asOfDate: string|null, navCount: number }} fingerprint
   */
  const readMetrics = async (code, fingerprint) => {
    const key = String(code || '').trim();
    if (!key || !isObject(fingerprint)) return null;
    const entry = await readVersioned(adapter, IDB_STORES.RISK, key, METRICS_CACHE_VERSION);
    if (!entry) return null;
    if (entry.data.asOfDate !== fingerprint.asOfDate || entry.data.navCount !== fingerprint.navCount) return null;
    if (!isObject(entry.data.metrics)) return null;
    return { ts: entry.ts, metrics: entry.data.metrics };
  };

  /** 写风险指标 */
  const writeMetrics = async (code, metrics) => {
    const key = String(code || '').trim();
    if (!key || !isObject(metrics)) return false;
    return writeVersioned(
      adapter,
      IDB_STORES.RISK,
      key,
      METRICS_CACHE_VERSION,
      { metrics, asOfDate: metrics.asOfDate ?? null, navCount: metrics.navCount ?? null },
      now()
    );
  };

  /**
   * 读波动信号（需净值指纹一致）。
   * @param {string} code
   * @param {{ asOfDate: string|null, navCount: number }} fingerprint
   */
  const readSignal = async (code, fingerprint) => {
    const key = String(code || '').trim();
    if (!key || !isObject(fingerprint)) return null;
    const entry = await readVersioned(adapter, IDB_STORES.SIGNAL, key, SIGNAL_CACHE_VERSION);
    if (!entry) return null;
    if (entry.data.asOfDate !== fingerprint.asOfDate || entry.data.navCount !== fingerprint.navCount) return null;
    if (!isString(entry.data.state)) return null;
    return { ts: entry.ts, ...entry.data };
  };

  /** 写波动信号 */
  const writeSignal = async (code, analysis) => {
    const key = String(code || '').trim();
    if (!key || !isObject(analysis)) return false;
    const { asOfDate, navCount, state, stateLevel, signals, primarySignals, riskScore } = analysis;
    return writeVersioned(
      adapter,
      IDB_STORES.SIGNAL,
      key,
      SIGNAL_CACHE_VERSION,
      { asOfDate: asOfDate ?? null, navCount: navCount ?? null, state, stateLevel, signals, primarySignals, riskScore },
      now()
    );
  };

  /** 读基金基本信息（与其它读方法同构：{ ts, data }） */
  const readBasic = async (code) => {
    const key = String(code || '').trim();
    if (!key) return null;
    const entry = await readVersioned(adapter, IDB_STORES.BASIC, key, BASIC_CACHE_VERSION);
    return entry ? { ts: entry.ts, data: entry.data } : null;
  };

  /** 写基金基本信息 */
  const writeBasic = async (code, info) => {
    const key = String(code || '').trim();
    if (!key || !isObject(info)) return false;
    return writeVersioned(adapter, IDB_STORES.BASIC, key, BASIC_CACHE_VERSION, info, now());
  };

  /** 清空某只基金的全部缓存（4 个仓库） */
  const clearFund = async (code) => {
    const key = String(code || '').trim();
    if (!key) return false;
    const results = await Promise.all([
      adapter.delete(IDB_STORES.BASIC, key),
      adapter.delete(IDB_STORES.NAV, key),
      adapter.delete(IDB_STORES.RISK, key),
      adapter.delete(IDB_STORES.SIGNAL, key)
    ]);
    return results.some(Boolean);
  };

  return {
    readBasic,
    writeBasic,
    readNav,
    writeNav,
    readMetrics,
    writeMetrics,
    readSignal,
    writeSignal,
    clearFund
  };
};

/** 生产用缓存实例 */
export const fundVolatilityCache = createFundVolatilityCache();

/**
 * 净值缓存是否已过期（需要重新拉取并合并）。
 * @param {{ ts: number }|null} navEntry readNav 的返回值
 * @param {number} [nowTs]
 * @param {number} [ttl] 覆盖默认新鲜期
 */
export const isNavCacheStale = (navEntry, nowTs = Date.now(), ttl = NAV_CACHE_TTL_MS) => {
  if (!isObject(navEntry) || !isNumber(navEntry.ts) || navEntry.ts <= 0) return true;
  if (!isArray(navEntry.rows) || navEntry.rows.length === 0) return true;
  return nowTs - navEntry.ts >= ttl;
};
