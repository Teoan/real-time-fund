/**
 * 基金波动信号取数编排（规格 §8 的业务流程）
 *
 *   用户选择基金
 *        ↓
 *   查 IndexedDB 缓存          ← cache.readNav
 *        ↓
 *   必要时补最新净值            ← fetchHistory + mergeNavSeries（并回写缓存）
 *        ↓
 *   计算风险指标                ← computeVolatilityMetrics（命中 fundRisk 缓存则跳过）
 *        ↓
 *   判断波动信号 + 生成状态      ← computeVolatilitySignals / resolveVolatilityState
 *        ↓
 *   缓存计算结果                ← cache.writeMetrics / writeSignal
 *        ↓
 *   React 页面展示              ← app/components/FundVolatilityPanel.jsx
 *
 * 这一层刻意**不 import `app/api/fund.js`**：
 *   取数函数由调用方注入（hook 里传 fetchFundHistory）。
 *   好处是纯逻辑可以在 node --test 下用假取数函数完整验证，
 *   不必把整个 JSONP 取数层拖进测试环境。
 */

// lodash 是 CJS 包：必须「默认导入 + 解构」才能被 node --test 直接加载（同 app/lib/valuationHistory.js）
import lodash from 'lodash';

import {
  VOLATILITY_STATES,
  VOLATILITY_STATE_LEVELS,
  computeRiskScore,
  computeVolatilityMetrics,
  computeVolatilitySignals,
  mergeNavSeries,
  pickPrimarySignals,
  resolveVolatilityState
} from './fundVolatility.js';
import { NAV_CACHE_TTL_MS, fundVolatilityCache, isNavCacheStale } from './fundVolatilityCache.js';

const { isArray, isFunction, isObject } = lodash;

/** 数据不足时的空画像（新基金 / 取数全失败） */
const buildInsufficientResult = (code, { error = null, navCount = 0, asOfDate = null } = {}) => ({
  code,
  basic: null,
  asOfDate,
  navCount,
  metrics: computeVolatilityMetrics([]),
  signals: [],
  primarySignals: [],
  state: VOLATILITY_STATES.INSUFFICIENT,
  stateLevel: VOLATILITY_STATE_LEVELS[VOLATILITY_STATES.INSUFFICIENT],
  riskScore: null,
  sources: { nav: 'none', metrics: 'none', signal: 'none' },
  updatedAt: null,
  error
});

/**
 * 加载某只基金的历史净值序列（本地缓存 → 必要时补最新 → 回写）。
 *
 * 这是「净值取数」的唯一实现，被波动画像（loadFundVolatility）与
 * 基金指标（app/lib/fundMetricsService.js）共用：
 *   两个功能读的是同一份 fundNav 缓存，各写一份会立刻出现两套新鲜度判断，
 *   而下面「静默空数组」「写缓存失败」两条细节都有回归护栏，不能复制。
 *
 * @param {string} fundCode 已 trim 的基金代码
 * @param {object} options
 * @param {(code: string) => Promise<Array<object>>} options.fetchHistory 拉取历史净值
 * @param {object} options.cache 缓存访问器
 * @param {number} options.ttl 净值缓存新鲜期
 * @param {boolean} options.forceRefresh 忽略新鲜期强制重取
 * @param {() => number} options.now 取时间戳
 * @returns {Promise<{ rows: Array<object>, navFromCache: boolean, fetchError: string|null }>}
 */
export const loadNavSeriesWithCache = async (fundCode, { fetchHistory, cache, ttl, forceRefresh = false, now }) => {
  let fetchError = null;
  let navFromCache = false;
  let cachedNav = null;

  // ── 1. 读 IndexedDB 净值缓存 ─────────────────────────────────────────────
  try {
    cachedNav = await cache.readNav(fundCode);
  } catch {
    cachedNav = null;
  }

  let rows = isArray(cachedNav?.rows) ? cachedNav.rows : [];

  // ── 2. 检查新鲜度，必要时补最新净值 ──────────────────────────────────────
  const stale = forceRefresh || isNavCacheStale(cachedNav, now(), ttl);
  if (stale) {
    let incoming = [];
    try {
      const raw = await fetchHistory(fundCode);
      incoming = isArray(raw) ? raw : isArray(raw?.rows) ? raw.rows : [];
    } catch (e) {
      // ⚠️ 注意 fetchFundHistory 内部是 try/catch → 失败时返回 []，不会抛。
      //    所以「拿到空数组」既可能是真没有数据，也可能是取数失败，这里统一按「没补到新数据」处理。
      fetchError = e?.message || String(e);
    }

    if (isArray(incoming) && incoming.length > 0) {
      const merged = mergeNavSeries(rows, incoming);
      if (merged.length > 0) rows = merged;
      // 回写失败与取数无关，必须单独兜住：否则写缓存出错会被记成「净值拉取失败」
      try {
        await cache.writeNav(fundCode, rows);
      } catch {
        /* 忽略：算不出来还能算，只是下次仍要重取 */
      }
    } else {
      // 没有补到任何新数据（取数抛错、或上游静默返回空数组）
      if (rows.length === 0) {
        return { rows, navFromCache: false, fetchError };
      }
      // 用的是本地历史 → 来源要如实标成 cache，并留一条提示，
      // 否则用户点「刷新」后会以为已经拿到最新净值
      navFromCache = true;
      if (!fetchError) fetchError = '本次未取到新净值';
    }
  } else {
    navFromCache = true;
  }

  return { rows, navFromCache, fetchError };
};

/**
 * 加载某只基金的波动画像。
 *
 * @param {string} code 6 位基金代码
 * @param {object} options
 * @param {(code: string) => Promise<Array<object>>} options.fetchHistory
 *        拉取历史净值的函数（返回 app/api/fund.js fetchFundHistory 的结构，或 `{ rows }`）
 * @param {object} [options.cache] 缓存访问器，默认 fundVolatilityCache
 * @param {number} [options.ttl] 净值缓存新鲜期
 * @param {boolean} [options.forceRefresh] 忽略净值新鲜期，强制重取
 * @param {object|null} [options.basic] 基金基本信息（名称/类型等），提供时写入 fundBasic
 * @param {() => number} [options.now] 取时间戳（测试可注入）
 * @returns {Promise<object>} 可直接渲染的波动画像
 */
export const loadFundVolatility = async (code, options = {}) => {
  const fundCode = code != null ? String(code).trim() : '';
  if (!fundCode) return buildInsufficientResult('', { error: '缺少基金代码' });

  const {
    fetchHistory,
    cache = fundVolatilityCache,
    ttl = NAV_CACHE_TTL_MS,
    forceRefresh = false,
    basic = null,
    now = () => Date.now()
  } = options;

  if (!isFunction(fetchHistory)) {
    return buildInsufficientResult(fundCode, { error: '未提供历史净值取数函数' });
  }

  const { rows, navFromCache, fetchError } = await loadNavSeriesWithCache(fundCode, {
    fetchHistory,
    cache,
    ttl,
    forceRefresh,
    now
  });

  if (rows.length === 0) {
    // fetchFundHistory 失败时是静默返回 []，不会带出原因，这里补一句可展示的说明，
    // 免得面板只显示「暂无足够净值数据」而用户不知道是网络问题还是基金本身没有历史。
    return buildInsufficientResult(fundCode, { error: fetchError || '未获取到该基金的净值数据' });
  }

  // 基本信息：调用方给了就顺手回写，没给就读缓存里的旧值（失败都不影响主流程）
  let basicInfo = isObject(basic) ? basic : null;
  try {
    if (isObject(basic)) {
      await cache.writeBasic(fundCode, basic);
    } else {
      const hit = await cache.readBasic(fundCode);
      if (isObject(hit?.data)) basicInfo = hit.data;
    }
  } catch {
    basicInfo = isObject(basic) ? basic : null;
  }

  const asOfDate = rows[rows.length - 1].date;
  const navCount = rows.length;
  const fingerprint = { asOfDate, navCount };

  // ── 3. 风险指标（命中缓存则复用） ────────────────────────────────────────
  let metrics = null;
  let metricsFromCache = false;
  try {
    const hit = await cache.readMetrics(fundCode, fingerprint);
    if (hit) {
      metrics = hit.metrics;
      metricsFromCache = true;
    }
  } catch {
    metrics = null;
  }

  if (!metrics) {
    metrics = computeVolatilityMetrics(rows);
    try {
      await cache.writeMetrics(fundCode, metrics);
    } catch {
      /* 忽略 */
    }
  }

  // ── 4. 波动信号 + 综合状态（命中缓存则复用） ─────────────────────────────
  let analysis = null;
  let signalFromCache = false;
  try {
    analysis = await cache.readSignal(fundCode, fingerprint);
    if (analysis) signalFromCache = true;
  } catch {
    analysis = null;
  }

  if (!analysis) {
    const signals = computeVolatilitySignals(metrics);
    const state = resolveVolatilityState(metrics, signals);
    analysis = {
      signals,
      primarySignals: pickPrimarySignals(signals),
      state,
      stateLevel: VOLATILITY_STATE_LEVELS[state] || 'muted',
      riskScore: computeRiskScore(metrics)
    };
    try {
      await cache.writeSignal(fundCode, { ...analysis, asOfDate, navCount });
    } catch {
      /* 忽略 */
    }
  }

  return {
    code: fundCode,
    basic: basicInfo,
    asOfDate,
    navCount,
    metrics,
    signals: isArray(analysis.signals) ? analysis.signals : [],
    primarySignals: isArray(analysis.primarySignals) ? analysis.primarySignals : [],
    state: analysis.state,
    stateLevel: analysis.stateLevel,
    riskScore: analysis.riskScore,
    sources: {
      nav: navFromCache ? 'cache' : 'network',
      metrics: metricsFromCache ? 'cache' : 'computed',
      signal: signalFromCache ? 'cache' : 'computed'
    },
    updatedAt: now(),
    error: fetchError
  };
};

/**
 * 清掉某只基金的全部波动缓存，下次强制重算。
 * @param {string} code
 * @param {object} [cache]
 */
export const clearFundVolatilityCache = (code, cache = fundVolatilityCache) => cache.clearFund(code);
