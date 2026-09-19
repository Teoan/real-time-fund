/**
 * TopK Fund Provider
 *
 * 暴露与项目内既有 API 命名风格一致的接口：
 *   searchFund(keyword)             -> [{ code, name, type }]
 *   getFundDetail(code)             -> { code, name, type, ... }
 *   getFundLatestNav(code)          -> { code, date, nav }
 *   getFundNavHistory(code, sdate, edate) -> [{ date, unitNav, accumulatedNav, dailyReturn }]
 *   getFundHoldings(code, year?)    -> { reportDate, dataDate, source, holdings: [...] }
 *
 * 所有方法使用注入的缓存抽象（默认 no-op；业务侧通过 createTopKProviderForApp 注入真实缓存）
 * 不实现的接口直接抛 TopKUnsupportedError，由调用方决定 fallback。
 */

import { FundNotFoundError, TopKError, TopKUnsupportedError } from './topk-errors.js';
import { TOPK_CACHE_TTL, TOPK_ENDPOINTS, TOPK_METADATA } from './topk-config.js';
import { TOPK_CAPABILITIES, isCapabilitySupported, mergeCapabilities } from './topk-capabilities.js';
import {
  mapHoldingRow,
  mapNavHistoryRow,
  mapOverviewRows,
  mapSearchFundRow,
  mapStockFundamentalLatest,
  mapStockValueHistory,
  mapStockRoe
} from './topk-mappers.js';
import { createTopKClient } from './topk-client.js';

/**
 * 简易并发池（内联，避免 Node ESM 加载项目别名路径）
 */
async function asyncPool(limit, iterable, iteratorFn) {
  const ret = [];
  const executing = new Set();
  for (const item of iterable) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean).catch(clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(ret);
}

/**
 * 默认 no-op 缓存：每次调用都执行 queryFn。
 * 业务侧接入时应注入基于 TanStack Query 的缓存实现。
 */
const defaultCache = {
  async fetch({ queryFn }) {
    return queryFn();
  }
};

/**
 * 创建 TopK Provider
 *
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {object} [options.clientOptions]
 * @param {number} [options.concurrency]
 * @param {{ fetch: Function }} [options.cache]
 */
export function createTopKProvider(options = {}) {
  const client = options.client || createTopKClient(options.clientOptions || {});
  const concurrency = options.concurrency ?? 4;
  const cache = options.cache || defaultCache;
  const capabilities = mergeCapabilities(options.capabilities);

  const fetchCached = (cacheKey, queryFn, staleTime) =>
    cache.fetch({ queryKey: ['topk', ...cacheKey], queryFn, staleTime });

  const searchFund = async (keyword) => {
    if (!isCapabilitySupported(capabilities, 'searchFund')) {
      throw new TopKUnsupportedError('TopK Provider 未启用 searchFund');
    }
    const normalized = String(keyword || '').trim();
    if (!normalized) return [];
    return fetchCached(
      ['searchFund', normalized],
      async () => {
        try {
          const rows = await client.call(TOPK_ENDPOINTS.searchFund);
          if (!Array.isArray(rows)) return [];
          return rows.map(mapSearchFundRow).filter(Boolean);
        } catch (e) {
          if (e instanceof FundNotFoundError) return [];
          throw e;
        }
      },
      TOPK_CACHE_TTL.searchFund
    );
  };

  const getFundDetail = async (code) => {
    if (!isCapabilitySupported(capabilities, 'getFundDetail')) {
      throw new TopKUnsupportedError('TopK Provider 未启用 getFundDetail');
    }
    const c = String(code || '').trim();
    if (!c) throw new TopKError('基金代码为空');
    return fetchCached(
      ['fundDetail', c],
      async () => {
        const rows = await client.call(TOPK_ENDPOINTS.getFundDetail, { symbol: c });
        const overview = mapOverviewRows(rows);
        if (!overview || Object.keys(overview).length === 0) {
          throw new FundNotFoundError(`TopK 未找到基金详情: ${c}`);
        }
        return {
          code: c,
          name: overview['基金名称'] || overview['基金简称'] || null,
          fullName: overview['基金全称'] || null,
          type: overview['基金类型'] || null,
          establishDate: overview['成立时间'] || null,
          company: overview['基金公司'] || null,
          manager: overview['基金经理'] || overview['基金经理人'] || null,
          custodian: overview['托管银行'] || overview['基金托管人'] || null,
          benchmark: overview['业绩比较基准'] || null,
          latestScale: overview['最新规模'] || overview['资产规模'] || null,
          rating: overview['基金评级'] || null
        };
      },
      TOPK_CACHE_TTL.getFundDetail
    );
  };

  const getFundLatestNav = async (code) => {
    if (!isCapabilitySupported(capabilities, 'getFundLatestNav')) {
      throw new TopKUnsupportedError('TopK Provider 未启用 getFundLatestNav');
    }
    const c = String(code || '').trim();
    if (!c) throw new TopKError('基金代码为空');
    return fetchCached(
      ['fundLatestNav', c],
      async () => {
        const rows = await client.call(TOPK_ENDPOINTS.getFundLatestNav);
        if (!Array.isArray(rows)) throw new FundNotFoundError(`TopK latest nav no data: ${c}`);
        const row = rows.find((r) => String(r['基金代码'] || '').trim() === c);
        if (!row) throw new FundNotFoundError(`TopK 未找到基金 ${c} 净值`);
        const nav = Number(row['单位净值']);
        return {
          code: c,
          nav: Number.isFinite(nav) ? nav : null,
          accumulatedNav: Number.isFinite(Number(row['累计净值'])) ? Number(row['累计净值']) : null,
          dailyReturn: Number.isFinite(Number(row['日增长率'])) ? Number(row['日增长率']) : null,
          date: row['净值日期'] || null,
          source: 'topk'
        };
      },
      TOPK_CACHE_TTL.getFundLatestNav
    );
  };

  const getFundNavHistory = async (code, sdate, edate) => {
    if (!isCapabilitySupported(capabilities, 'getFundNavHistory')) {
      throw new TopKUnsupportedError('TopK Provider 未启用 getFundNavHistory');
    }
    const c = String(code || '').trim();
    if (!c) throw new TopKError('基金代码为空');
    return fetchCached(
      ['fundNavHistory', c, String(sdate || ''), String(edate || '')],
      async () => {
        const rows = await client.call(TOPK_ENDPOINTS.getFundNavHistory, {
          symbol: c,
          indicator: '单位净值走势'
        });
        if (!Array.isArray(rows) || rows.length === 0) {
          throw new FundNotFoundError(`TopK 历史净值未找到: ${c}`);
        }
        const list = rows
          .map(mapNavHistoryRow)
          .filter(Boolean)
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const dedup = [];
        const seen = new Set();
        for (let i = list.length - 1; i >= 0; i--) {
          if (seen.has(list[i].date)) continue;
          seen.add(list[i].date);
          dedup.unshift(list[i]);
        }
        if (sdate && edate) {
          return dedup.filter((d) => d.date >= sdate && d.date <= edate);
        }
        return dedup;
      },
      TOPK_CACHE_TTL.getFundNavHistory
    );
  };

  const getFundHoldings = async (code, year) => {
    if (!isCapabilitySupported(capabilities, 'getFundHoldings')) {
      throw new TopKUnsupportedError('TopK Provider 未启用 getFundHoldings');
    }
    const c = String(code || '').trim();
    if (!c) throw new TopKError('基金代码为空');
    return fetchCached(
      ['fundHoldings', c, year ? String(year) : 'latest'],
      async () => {
        const rows = await client.call(TOPK_ENDPOINTS.getFundHoldings, {
          symbol: c,
          date: year ? String(year) : ''
        });
        if (!Array.isArray(rows) || rows.length === 0) {
          return {
            code: c,
            reportDate: null,
            dataDate: null,
            source: 'topk',
            holdings: []
          };
        }
        const holdings = rows.map(mapHoldingRow).filter(Boolean).slice(0, 10);
        const reportDate = holdings[0]?.reportDate || null;
        return {
          code: c,
          reportDate,
          dataDate: reportDate,
          source: 'topk',
          holdings
        };
      },
      TOPK_CACHE_TTL.getFundHoldings
    );
  };

  const getFundsLatestNavBatch = async (codes) => {
    if (!Array.isArray(codes) || codes.length === 0) return {};
    const results = await asyncPool(concurrency, codes, async (code) => {
      try {
        const v = await getFundLatestNav(code);
        return [code, v];
      } catch (e) {
        return [code, null];
      }
    });
    return Object.fromEntries(results);
  };

  /**
   * 单股估值指标（A 股 6 位代码）。用于持仓穿透估值。
   *
   * 注意：
   * - AKShare stock_value_em 是历史序列接口，返回约 2100 条日数据
   * - 单次只接受一只股票（不支持 batch），每只股票一次 HTTP 调用
   * - 股息率 / 净利润同比 TopK 暂无对应接口，固定返回 null（不影响算法）
   * - secid 由调用方传入（业务层从 push2 secid 推导），用于返回值填充
   *
   * @param {string} symbol - A 股 6 位代码，如 "600519"
   * @param {{ secid?: string, market?: 'A'|'HK'|'US', code?: string, name?: string }} [ctx]
   * @returns {Promise<StockFundamental|null>}
   */
  const getStockFundamentals = async (symbol, ctx = {}) => {
    if (!isCapabilitySupported(capabilities, 'getStockFundamentals')) {
      throw new TopKUnsupportedError('TopK Provider 未启用 getStockFundamentals');
    }
    const s = String(symbol || '').trim();
    if (!/^\d{6}$/.test(s)) {
      throw new TopKError(`stock_value_em 仅接受 A 股 6 位代码: ${symbol}`);
    }
    return fetchCached(
      ['stockFundamentals', s],
      async () => {
        const rows = await client.call(TOPK_ENDPOINTS.getStockFundamentals, { symbol: s });
        const mapped = mapStockFundamentalLatest(rows, { ...ctx, code: s });
        if (!mapped) throw new FundNotFoundError(`TopK 未返回单股估值: ${s}`);
        return mapped;
      },
      TOPK_CACHE_TTL.getStockFundamentals
    );
  };

  /**
   * 单股估值历史序列（A 股 6 位代码）。用于持仓历史分位计算。
   *
   * 与 getStockFundamentals 使用同一 AKShare 接口（stock_value_em），
   * 区别在于本方法保留全量历史（约 2100 条日数据），按数据日期升序返回；
   * 后者只取最新一行。缓存键独立，避免与「最新行」缓存互相覆盖。
   *
   * @param {string} symbol - A 股 6 位代码，如 "600519"
   * @returns {Promise<Array<{ date: string, price: number|null, pe: number|null, pb: number|null, ps: number|null, peg: number|null }>>}
   */
  const getStockValueHistory = async (symbol) => {
    if (!isCapabilitySupported(capabilities, 'getStockFundamentals')) {
      throw new TopKUnsupportedError('TopK Provider 未启用 getStockFundamentals');
    }
    const s = String(symbol || '').trim();
    if (!/^\d{6}$/.test(s)) {
      throw new TopKError(`stock_value_em 仅接受 A 股 6 位代码: ${symbol}`);
    }
    return fetchCached(
      ['stockValueHistory', s],
      async () => {
        const rows = await client.call(TOPK_ENDPOINTS.getStockFundamentals, { symbol: s });
        const series = mapStockValueHistory(rows);
        if (series.length === 0) throw new FundNotFoundError(`TopK 未返回单股估值历史: ${s}`);
        return series;
      },
      TOPK_CACHE_TTL.getStockFundamentals
    );
  };

  /**
   * 单股 ROE（加权净资产收益率，%）。用于持仓穿透估值的 ROE 指标。
   *
   * 数据源：AKShare stock_financial_analysis_indicator（新浪财经-财务指标）。
   * 定位：东财 F10 直连不可用时的兜底数据源，业务层按「先 F10、后本方法」的顺序调用。
   *
   * 接口返回全量历史（实测约 315KB / 103 行），通过 start_year 限定近两年报告期，
   * 将 payload 压到约 30KB；只取最近一期报告的加权 ROE。
   *
   * @param {string} symbol - A 股 6 位代码，如 "600519"
   * @returns {Promise<number|null>}
   */
  const getStockRoe = async (symbol) => {
    if (!isCapabilitySupported(capabilities, 'getStockRoe')) {
      throw new TopKUnsupportedError('TopK Provider 未启用 getStockRoe');
    }
    const s = String(symbol || '').trim();
    if (!/^\d{6}$/.test(s)) {
      throw new TopKError(`stock_financial_analysis_indicator 仅接受 A 股 6 位代码: ${symbol}`);
    }
    const startYear = String(new Date().getFullYear() - 1);
    return fetchCached(
      ['topkStockRoe', s],
      async () => {
        const rows = await client.call(TOPK_ENDPOINTS.getStockRoe, { symbol: s, start_year: startYear });
        const roe = mapStockRoe(rows);
        if (roe == null) throw new FundNotFoundError(`TopK 未返回 ROE: ${s}`);
        return roe;
      },
      TOPK_CACHE_TTL.getStockRoe
    );
  };

  /**
   * 批量获取单股估值（DataLoader 模式，并发受控）。
   * @param {Array<{ symbol: string, secid?: string, market?: 'A'|'HK'|'US', code?: string, name?: string }>} targets
   * @returns {Promise<Record<string, StockFundamental|null>>}  key = symbol
   */
  const getStockFundamentalsBatch = async (targets) => {
    if (!Array.isArray(targets) || targets.length === 0) return {};
    const entries = await asyncPool(concurrency, targets, async (t) => {
      try {
        const v = await getStockFundamentals(t.symbol, t);
        return [t.symbol, v];
      } catch (e) {
        return [t.symbol, null];
      }
    });
    return Object.fromEntries(entries);
  };

  const healthCheck = async () => client.healthCheck();

  return {
    metadata: TOPK_METADATA,
    capabilities,
    searchFund,
    getFundDetail,
    getFundLatestNav,
    getFundNavHistory,
    getFundHoldings,
    getFundsLatestNavBatch,
    getStockFundamentals,
    getStockFundamentalsBatch,
    getStockValueHistory,
    getStockRoe,
    healthCheck
  };
}

/**
 * 为业务侧构造默认 Provider（带 TanStack Query 缓存）。
 * 该函数必须在浏览器 / 有完整模块解析的环境下被调用。
 *
 * 实现：动态 import 项目内的 get-query-client 与 query-keys，避免 Node ESM 加载时找不到 Next.js alias。
 */
export async function createTopKProviderForApp(options = {}) {
  let getQueryClient = null;
  let qk = null;
  try {
    const mod1 = await import('@/app/lib/get-query-client.js');
    getQueryClient = mod1.getQueryClient;
  } catch {
    // SSR / 测试环境可能没有路径别名
  }
  try {
    qk = await import('@/app/lib/query-keys.js');
  } catch {
    // 同上
  }

  const cache = {
    async fetch({ queryKey, queryFn, staleTime }) {
      if (!getQueryClient || !qk) return queryFn();
      const qc = getQueryClient();
      // cacheKey 形如 ['topk', 'searchFund', '110022'] → topkSearchFund('110022')
      const rest = queryKey.slice(2);
      const factory = qk[queryKey[1]];
      const actualKey = typeof factory === 'function' ? factory(...rest) : queryKey;
      return qc.fetchQuery({ queryKey: actualKey, queryFn, staleTime });
    }
  };
  return createTopKProvider({ ...options, cache });
}

export const defaultTopKProvider = createTopKProvider();

/**
 * 业务层统一调用入口（推荐 import）。
 *
 * 与 defaultTopKProvider 等价；能力开关见 topk-capabilities.js 的 DEFAULT_CAPABILITIES
 * （当前已开启 getStockFundamentals、getFundDetail，其余默认关闭）。
 * 如需调整某个能力，请修改 DEFAULT_CAPABILITIES 或通过 settingsStore 增加配置项，
 * 并在调用方（如 app/api/fund.js 的 fetchStockFundamentalsBatched）中根据能力
 * 是否启用决定走 TopK 还是 fallback 到原东财 push2 实现。
 *
 * 启用方式（生产）：
 *   const provider = createTopKProvider({
 *     capabilities: { getStockFundamentals: true }
 *   });
 */
export const TOPK_PROVIDER = defaultTopKProvider;
