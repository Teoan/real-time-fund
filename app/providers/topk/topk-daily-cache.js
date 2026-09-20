/**
 * TopK 天维度本地缓存
 *
 * 解决问题：
 *   stock_value_em 每次返回 ~1MB（2107 行历史），但我们只用最新 1 行（~500B）。
 *   持仓穿透每次打开弹框都会触发 N 只股票 ×1MB 的请求，容易被限流。
 *
 * 方案：
 *   1. 首次请求：从 TopK 拉全量 → 提取最新行 → 写入 localStorage
 *   2. 后续请求：先读 localStorage → 命中且未过期则直接返回（不请求网络）
 *   3. 过期策略：每天自然过期（按交易日期比较），或最长24h强制过期
 *
 * 存储结构：
 *   key: "topk:stockFundamentals:{symbol}"
 *   value: { data: StockFundamental, date: "2026-09-07", ts: 1725744000000 }
 *
 * 港股估值序列（stock_hk_indicator_eniu，单次 6~18s、数据静态）同样使用本模块的天级缓存：
 *   key: "topk:hkValueHistory:{symbol}:{pe|pb}"
 *   value: { data: [{ date, value }], ts: 1725744000000 }
 *   ⚠️ 仅缓存参与分位计算的时间窗（近 5 年 ~200 行），全量 4000 行会占满配额。
 *
 * 注意：
 *   - 仅在浏览器环境使用（localStorage 不存在于 SSR）
 *   - 缓存键按 symbol（6 位代码），不按 secid（避免 1.600519 vs 0.000001 重复存储）
 *   - 缓存体积极小：10 只基金 ×500B = 5KB（对比原来 10MB）
 */

const CACHE_PREFIX = 'topk:stockFundamentals:';
/** 港股估值序列缓存前缀（键：`topk:hkValueHistory:{symbol}:{indicator}`） */
const HK_CACHE_PREFIX = 'topk:hkValueHistory:';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 小时强制过期
const CACHE_VERSION = 1;
const HK_CACHE_VERSION = 1;
const CACHE_PREFIXES = [CACHE_PREFIX, HK_CACHE_PREFIX];

/**
 * 从 stock_value_em 的历史序列中提取最新一行并映射为 StockFundamental。
 * 复用 mapStockFundamentalLatest 的逻辑，但内联以避免循环依赖。
 */
const extractLatestRow = (rows, ctx) => {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // 按数据日期降序取最新
  let latest = rows[0];
  let latestTs = 0;
  for (const row of rows) {
    const raw = row['数据日期'];
    if (!raw) continue;
    const d = new Date(raw);
    const ts = Number.isFinite(d.getTime()) ? d.getTime() : 0;
    if (ts > latestTs) {
      latestTs = ts;
      latest = row;
    }
  }
  if (!latest) return null;

  const toNum = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const dateStr = latest['数据日期'];
  const dateObj = dateStr ? new Date(dateStr) : null;
  const updateTime = dateObj && Number.isFinite(dateObj.getTime()) ? dateObj.getTime() : null;

  return {
    secid: ctx?.secid || null,
    market: ctx?.market || 'A',
    code: ctx?.code || null,
    name: ctx?.name || null,
    price: toNum(latest['当日收盘价']),
    totalMv: toNum(latest['总市值']),
    freeMv: toNum(latest['流通市值']),
    pe: toNum(latest['PE(TTM)']),
    pb: toNum(latest['市净率']),
    ps: toNum(latest['市销率']),
    dividendYield: null,
    peg: toNum(latest['PEG值']),
    epsGrowth: null,
    updateTime,
    fetchedAt: Date.now()
  };
};

/**
 * 生成缓存键
 */
const cacheKey = (symbol) => `${CACHE_PREFIX}${symbol}`;

/** 港股估值序列缓存键（symbol 为 4~5 位港股代码，indicator 为 pe / pb） */
const hkCacheKey = (symbol, indicator) =>
  `${HK_CACHE_PREFIX}${String(symbol || '').trim()}:${String(indicator || '').trim()}`;

/**
 * 读取一条缓存记录。
 * 版本不匹配 / 超过 24h / 时间戳异常 / JSON 损坏 均返回 null。
 */
const readEntry = (key, version) => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed._v !== version) return null;

    // 检查是否过期：强制 24h 过期
    const age = Date.now() - (parsed.ts || 0);
    if (age > CACHE_MAX_AGE_MS || age < 0) return null;

    return parsed.data || null;
  } catch {
    return null;
  }
};

/** 写入一条缓存记录；localStorage 满或不可用时静默忽略 */
const writeEntry = (key, version, data, extra) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify({ _v: version, ts: Date.now(), ...(extra || {}), data }));
  } catch {
    // localStorage 满或不可用，静默忽略
  }
};

/**
 * 从 localStorage 读取缓存
 */
const readCache = (symbol) => readEntry(cacheKey(symbol), CACHE_VERSION);

/**
 * 写入 localStorage 缓存。
 * data 应为已映射的 StockFundamental 结构（与 fetchStockFundamentalsBatched 返回一致）。
 */
export const writeCache = (symbol, data) => {
  writeEntry(cacheKey(symbol), CACHE_VERSION, data, {
    date: data?.updateTime ? new Date(data.updateTime).toISOString().slice(0, 10) : null
  });
};

/**
 * 查询港股单股估值序列（市盈率/市净率历史）的天级缓存。
 * @param {string} symbol - 港股 4~5 位代码
 * @param {'pe'|'pb'} indicator
 * @returns {Array<{ date: string, value: number }>|null}
 */
export const getCachedStockHkValueHistory = (symbol, indicator) =>
  readEntry(hkCacheKey(symbol, indicator), HK_CACHE_VERSION);

/**
 * 写入港股单股估值序列的天级缓存。
 *
 * ⚠️ 调用方应只写入「参与计算的时间窗」（例如近 5 年 ~200 行）。
 * 上游 eniu 全量历史约 4000 行 / 单指标 ~140KB，10 只港股 × 2 指标 ≈ 2.8MB，
 * 直接落盘会迅速占满 localStorage 配额并影响项目其它数据写入。
 *
 * @param {string} symbol - 港股 4~5 位代码
 * @param {'pe'|'pb'} indicator
 * @param {Array<{ date: string, value: number }>} series
 */
export const writeCachedStockHkValueHistory = (symbol, indicator, series) => {
  if (!Array.isArray(series) || series.length === 0) return;
  writeEntry(hkCacheKey(symbol, indicator), HK_CACHE_VERSION, series);
};

/**
 * 清理过期缓存（可选调用，避免 localStorage 积累过多垃圾）。
 * 覆盖本模块全部缓存族：单股估值最新行 + 港股估值序列。
 */
export const cleanExpiredTopKCache = () => {
  if (typeof localStorage === 'undefined') return;
  try {
    const keysToDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !CACHE_PREFIXES.some((p) => key.startsWith(p))) continue;
      const expectedVersion = key.startsWith(HK_CACHE_PREFIX) ? HK_CACHE_VERSION : CACHE_VERSION;
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const age = Date.now() - (parsed?.ts || 0);
        if (age > CACHE_MAX_AGE_MS || age < 0 || parsed?._v !== expectedVersion) {
          keysToDelete.push(key);
        }
      } catch {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((k) => localStorage.removeItem(k));
  } catch {
    // ignore
  }
};

/**
 * 查询单只股票的天级缓存。
 * @param {string} symbol - 6 位 A 股代码
 * @returns {StockFundamental|null}
 */
export const getCachedStockFundamental = (symbol) => readCache(symbol);

/**
 * 将 TopK 返回的 stock_value_em 全量数据提取最新行并写入天级缓存。
 * @param {string} symbol - 6 位 A 股代码
 * @param {Array<object>} rows - stock_value_em 返回的完整历史数组
 * @param {object} ctx - { secid, market, code, name }
 * @returns {StockFundamental|null}
 */
export const cacheStockFundamentalFromRows = (symbol, rows, ctx) => {
  const latest = extractLatestRow(rows, ctx);
  if (!latest) return null;
  writeCache(symbol, latest);
  return latest;
};

/**
 * 查询缓存统计信息（用于调试/设置页展示）。
 * 覆盖本模块全部缓存族：单股估值最新行 + 港股估值序列。
 */
export const getTopKCacheStats = () => {
  if (typeof localStorage === 'undefined') return { count: 0, totalBytes: 0 };
  let count = 0;
  let totalBytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !CACHE_PREFIXES.some((p) => key.startsWith(p))) continue;
      const raw = localStorage.getItem(key);
      if (raw) {
        count++;
        totalBytes += raw.length;
      }
    }
  } catch {}
  return { count, totalBytes };
};

export const __test__ = {
  extractLatestRow,
  CACHE_PREFIX,
  HK_CACHE_PREFIX,
  CACHE_MAX_AGE_MS,
  CACHE_VERSION,
  HK_CACHE_VERSION
};
