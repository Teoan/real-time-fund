/**
 * 基金指标（13 项）取数编排
 *
 *   读 IndexedDB 净值缓存 ──┐
 *                          ├─→ loadNavSeriesWithCache（与波动信号共用同一份 fundNav）
 *   必要时补最新净值 ───────┘
 *        ↓
 *   选择业绩基准                ← resolveFundBenchmark（按名称，纯函数）
 *        ↓
 *   查基准缓存 → 必要时取数      ← fundBenchmarkCache + fetchBenchmark（调用方注入）
 *        ↓
 *   裁剪到统计窗口               ← trimNavSeries（保证「网络取数」与「缓存命中」结果一致）
 *        ↓
 *   计算 13 项指标               ← computeFundMetrics（纯函数，不落盘）
 *        ↓
 *   React 页面展示              ← app/components/FundMetricsPanel.jsx
 *
 * 与 fundVolatilityService 的两处刻意差异：
 *
 *   1. **指标结果不缓存**。整段计算是毫秒级的纯算术，而缓存它就要再造一套指纹
 *      （净值 + 基准 + 无风险利率 + 口径版本）失效逻辑——那是波动信号缓存踩过的坑
 *      （见 fundVolatilityCache 的版本沿革）。只缓存「净值」与「基准序列」两个输入即可。
 *
 *   2. **基准序列按 secid 跨基金共享**，因此它不随单只基金删除而清理，
 *      也不进 clearFund。
 *
 * 这一层刻意**不 import `app/api/fund.js`**：取数函数由调用方注入（hook 里传
 * fetchFundHistory / fetchIndexKlineHistory），纯逻辑因此可以在 node --test 下
 * 用假取数函数完整验证。
 */

// lodash 是 CJS 包：必须「默认导入 + 解构」才能被 node --test 直接加载（同 app/lib/valuationHistory.js）
import lodash from 'lodash';

import { DEFAULT_RISK_FREE_RATE, METRICS_WINDOW_TRADING_DAYS, computeFundMetrics } from './fundMetrics.js';
import { resolveFundBenchmark } from './fundBenchmark.js';
import { BENCHMARK_CACHE_TTL_MS, fundBenchmarkCache, isBenchmarkCacheStale } from './fundBenchmarkCache.js';
import { NAV_CACHE_TTL_MS, fundVolatilityCache } from './fundVolatilityCache.js';
import { loadNavSeriesWithCache } from './fundVolatilityService.js';
import { trimNavSeries } from './fundVolatility.js';

const { isArray, isFunction, isNumber, isObject, isString } = lodash;

/**
 * 数据不足时的空结果（新基金 / 取数全失败）。
 * 形状与正常返回完全一致，UI 不必分叉。
 */
const buildInsufficientResult = (code, { error = null, navCount = 0, asOfDate = null } = {}) => ({
  code,
  basic: null,
  asOfDate,
  navCount,
  metrics: computeFundMetrics({ rows: [] }),
  benchmark: null,
  benchmarkError: null,
  sources: { nav: 'none', benchmark: 'none' },
  updatedAt: null,
  error
});

/**
 * 加载某只基金的 13 项指标。
 *
 * @param {string} code 6 位基金代码
 * @param {object} options
 * @param {(code: string) => Promise<Array<object>>} options.fetchHistory 拉取历史净值
 * @param {(secid: string) => Promise<{ secid: string, name?: string, rows: Array<object> }|null>} [options.fetchBenchmark]
 *        拉取基准指数日线；不提供时 Alpha/Beta/信息比率 一律为 null
 * @param {object} [options.cache] 净值/基本信息缓存访问器，默认 fundVolatilityCache
 * @param {object} [options.benchmarkCache] 基准序列缓存访问器，默认 fundBenchmarkCache
 * @param {number} [options.ttl] 净值缓存新鲜期
 * @param {number} [options.benchmarkTtl] 基准缓存新鲜期
 * @param {boolean} [options.forceRefresh] 忽略净值与基准的新鲜期，强制重取
 * @param {object|null} [options.basic] 基金基本信息（名称用于选基准，提供时写入 fundBasic）
 * @param {number} [options.riskFreeRate] 年化无风险利率（%），默认 2.0
 * @param {() => number} [options.now] 取时间戳（测试可注入）
 * @returns {Promise<object>} 可直接渲染的指标结果
 */
export const loadFundMetrics = async (code, options = {}) => {
  const fundCode = code != null ? String(code).trim() : '';
  if (!fundCode) return buildInsufficientResult('', { error: '缺少基金代码' });

  const {
    fetchHistory,
    fetchBenchmark,
    cache = fundVolatilityCache,
    benchmarkCache = fundBenchmarkCache,
    ttl = NAV_CACHE_TTL_MS,
    benchmarkTtl = BENCHMARK_CACHE_TTL_MS,
    forceRefresh = false,
    basic = null,
    riskFreeRate = DEFAULT_RISK_FREE_RATE,
    now = () => Date.now()
  } = options;

  if (!isFunction(fetchHistory)) {
    return buildInsufficientResult(fundCode, { error: '未提供历史净值取数函数' });
  }

  // ── 1. 净值（与波动信号共用同一份缓存与同一套新鲜度判断）────────────────
  const { rows, navFromCache, fetchError } = await loadNavSeriesWithCache(fundCode, {
    fetchHistory,
    cache,
    ttl,
    forceRefresh,
    now
  });

  if (rows.length === 0) {
    return buildInsufficientResult(fundCode, {
      error: fetchError || '未获取到该基金的净值数据'
    });
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

  // ── 2. 业绩基准 ──────────────────────────────────────────────────────────
  const resolved = resolveFundBenchmark(basicInfo);
  let benchmark = null;
  let benchmarkError = null;
  let benchmarkFromCache = 'none';

  if (resolved) {
    let cachedBenchmark = null;
    try {
      cachedBenchmark = await benchmarkCache.read(resolved.secid);
    } catch {
      cachedBenchmark = null;
    }

    const benchmarkStale = forceRefresh || isBenchmarkCacheStale(cachedBenchmark, now(), benchmarkTtl);

    if (!benchmarkStale && isArray(cachedBenchmark?.rows)) {
      benchmark = {
        secid: resolved.secid,
        name: cachedBenchmark.name || resolved.name,
        rows: cachedBenchmark.rows
      };
      benchmarkFromCache = 'cache';
    } else if (isFunction(fetchBenchmark)) {
      let incoming = null;
      try {
        incoming = await fetchBenchmark(resolved.secid);
      } catch (e) {
        benchmarkError = e?.message || String(e);
      }

      const incomingRows = isArray(incoming?.rows) ? incoming.rows : isArray(incoming) ? incoming : [];
      if (incomingRows.length > 0) {
        benchmark = {
          secid: resolved.secid,
          name: (isString(incoming?.name) && incoming.name) || resolved.name,
          rows: incomingRows
        };
        benchmarkFromCache = 'network';
        // 回写失败与取数无关，单独兜住，否则会被记成「基准取数失败」
        try {
          await benchmarkCache.write(resolved.secid, { name: benchmark.name, rows: incomingRows });
        } catch {
          /* 忽略：本次仍能用新数据算 */
        }
      } else {
        // 取数失败或上游给空：退回本地旧数据（哪怕已过期），总比没有基准强
        if (isArray(cachedBenchmark?.rows) && cachedBenchmark.rows.length > 0) {
          benchmark = {
            secid: resolved.secid,
            name: cachedBenchmark.name || resolved.name,
            rows: cachedBenchmark.rows
          };
          benchmarkFromCache = 'cache';
          if (!benchmarkError) benchmarkError = '本次未取到新基准数据';
        } else {
          benchmarkFromCache = 'none';
          if (!benchmarkError) benchmarkError = '基准指数未取到数据';
        }
      }
    } else {
      benchmarkFromCache = 'none';
      if (!benchmarkError) benchmarkError = '未提供基准指数取数函数';
    }
  }

  // ── 3. 计算（先裁剪到统计窗口，保证「网络取数」与「缓存命中」两条路径结果一致）───
  const windowRows = trimNavSeries(rows, METRICS_WINDOW_TRADING_DAYS);
  const metrics = computeFundMetrics({
    rows: windowRows,
    benchmark,
    riskFreeRate: isNumber(riskFreeRate) ? riskFreeRate : DEFAULT_RISK_FREE_RATE
  });

  return {
    code: fundCode,
    basic: basicInfo,
    asOfDate,
    navCount,
    metrics,
    benchmark: benchmark
      ? {
          secid: benchmark.secid,
          name: benchmark.name,
          asOfDate:
            isArray(benchmark.rows) && benchmark.rows.length > 0
              ? benchmark.rows[benchmark.rows.length - 1].date
              : null,
          rowCount: isArray(benchmark.rows) ? benchmark.rows.length : 0
        }
      : null,
    benchmarkError,
    sources: {
      nav: navFromCache ? 'cache' : 'network',
      benchmark: benchmarkFromCache
    },
    updatedAt: now(),
    error: fetchError
  };
};
