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
 * 注意：
 *   - 仅在浏览器环境使用（localStorage 不存在于 SSR）
 *   - 缓存键按 symbol（6 位代码），不按 secid（避免 1.600519 vs 0.000001 重复存储）
 *   - 缓存体积极小：10 只基金 ×500B = 5KB（对比原来 10MB）
 */

const CACHE_PREFIX = 'topk:stockFundamentals:';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 小时强制过期
const CACHE_VERSION = 1;

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

/**
 * 从 localStorage 读取缓存
 */
const readCache = (symbol) => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(cacheKey(symbol));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed._v !== CACHE_VERSION) return null;

    // 检查是否过期：强制 24h 过期
    const age = Date.now() - (parsed.ts || 0);
    if (age > CACHE_MAX_AGE_MS || age < 0) return null;

    return parsed.data || null;
  } catch {
    return null;
  }
};

/**
 * 写入 localStorage 缓存。
 * data 应为已映射的 StockFundamental 结构（与 fetchStockFundamentalsBatched 返回一致）。
 */
export const writeCache = (symbol, data) => {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload = {
      _v: CACHE_VERSION,
      ts: Date.now(),
      date: data?.updateTime ? new Date(data.updateTime).toISOString().slice(0, 10) : null,
      data
    };
    localStorage.setItem(cacheKey(symbol), JSON.stringify(payload));
  } catch {
    // localStorage 满或不可用，静默忽略
  }
};

/**
 * 清理过期缓存（可选调用，避免 localStorage 积累过多垃圾）
 */
export const cleanExpiredStockFundamentalsCache = () => {
  if (typeof localStorage === 'undefined') return;
  try {
    const keysToDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(CACHE_PREFIX)) continue;
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const age = Date.now() - (parsed?.ts || 0);
        if (age > CACHE_MAX_AGE_MS || age < 0 || parsed?._v !== CACHE_VERSION) {
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
 * 查询缓存统计信息（用于调试/设置页展示）
 */
export const getStockFundamentalsCacheStats = () => {
  if (typeof localStorage === 'undefined') return { count: 0, totalBytes: 0 };
  let count = 0;
  let totalBytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(CACHE_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (raw) {
        count++;
        totalBytes += raw.length;
      }
    }
  } catch {}
  return { count, totalBytes };
};

export const __test__ = { extractLatestRow, CACHE_PREFIX, CACHE_MAX_AGE_MS, CACHE_VERSION };
