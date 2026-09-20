/**
 * TopK 配置与端点集中管理
 *
 * - baseUrl 必须支持环境变量覆盖（生产可能自建 AKTools 实例）
 * - 端点路径集中，未来 TopK/AKShare 改动只动本文件
 * - 缓存 TTL 与现有 query-keys 保持同粒度
 *
 * 注意：本文件故意不依赖项目内常量，避免 Provider 启动时被打包进不必要的依赖
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 默认 baseUrl：https://topk.xyz/api/public
 *
 * 注意：
 * - http://topk.xyz 是无关的 LNMP 演示页面，所有路径返回 nginx 404，必须用 https
 * - TopK 服务的 SSL 证书曾过期（curl -k 提示 expired），生产部署前请确认证书已续期
 * - 真实联调结果（2026-08-31）：
 *     fund_name_em: 200, ~5MB 全量, 17s
 *     fund_individual_basic_info_xq: 200, <3KB, <1s
 *     fund_open_fund_info_em: 200, ~300KB, ~2.5s
 *     fund_open_fund_daily_em: 200, ~5MB, 慢/有控制字符
 *     fund_portfolio_hold_em: 500（TopK/AKShare 端异常，与基金代码无关）
 *     fund_fh_em: 500（TopK/AKShare 端异常）
 *     fund_etf_spot_em: 500（TopK/AKShare 端异常）
 *     fund_overview_em: 404（TopK 未暴露该接口）
 * - 真实联调结果（2026-09-19，单股 ROE 兜底）：
 *     stock_value_em: 200, ~700KB, ~0.8s
 *     stock_financial_analysis_indicator: 200, ~30KB（start_year 限制后）, ~2.4s
 *     stock_financial_analysis_indicator_em: 500（TopK/AKShare 端异常，不可用）
 *     stock_financial_abstract: 200, ~175KB, ~1.6s
 *     stock_zh_dupont_comparison_em: 200, ~4KB, ~0.2s
 * - 真实联调结果（2026-09-19，港股持仓穿透）：
 *     stock_hk_financial_indicator_em: 200, ~0.7KB, ~0.15s（含股东权益回报率/市盈率/市净率/股息率TTM）
 *     stock_hk_spot_em: 500（TopK/AKShare 端异常）
 * - 真实联调结果（2026-09-20，港股历史估值源选型）：
 *     stock_hk_indicator_eniu: 200, ~140~190KB, 6~18s（已采用；数据止于 2022-07-13，见下方说明）
 *     stock_hk_valuation_baidu: 200, ~30KB, ~0.1s（数据到当日，但仅 2004 起 ~626 行、密度低；未采用）
 */
export const TOPK_DEFAULT_BASE_URL = 'https://topk.xyz/api/public';

export const TOPK_BASE_URL = (() => {
  if (typeof process !== 'undefined' && process?.env?.NEXT_PUBLIC_TOPK_BASE_URL) {
    return String(process.env.NEXT_PUBLIC_TOPK_BASE_URL).replace(/\/+$/, '');
  }
  return TOPK_DEFAULT_BASE_URL;
})();

/**
 * TopK Provider metadata
 */
export const TOPK_METADATA = Object.freeze({
  id: 'topk',
  name: 'TopK / AKTools',
  description: '通过 TopK 部署的 AKTools 服务访问 AKShare 数据',
  baseUrl: TOPK_BASE_URL,
  website: 'https://topk.xyz/',
  docsUrl: 'http://topk.xyz/docs',
  type: 'remote-aktools'
});

/**
 * AKShare 接口端点集中注册。
 * 入参为 AKTools 调用约定（query string）。
 */
export const TOPK_ENDPOINTS = Object.freeze({
  searchFund: 'fund_name_em',
  getFundDetail: 'fund_individual_basic_info_xq',
  getFundLatestNav: 'fund_open_fund_daily_em',
  getFundNavHistory: 'fund_open_fund_info_em',
  getFundHoldings: 'fund_portfolio_hold_em',
  getFundOverview: 'fund_overview_em',
  getFundManager: 'fund_manager_em',
  getFundDividend: 'fund_fh_em',
  getFundRank: 'fund_open_fund_rank_em',
  getEtfSpot: 'fund_etf_spot_em',
  // 单股估值（用于持仓穿透）：AKShare stock_value_em，单只 A 股 6 位代码
  getStockFundamentals: 'stock_value_em',
  // 单股 ROE 兜底（用于持仓穿透）：AKShare stock_financial_analysis_indicator（新浪财经-财务指标）
  // 注意：东财口径的 stock_financial_analysis_indicator_em 在 TopK 实例上返回 500，故改用新浪口径
  getStockRoe: 'stock_financial_analysis_indicator',
  // 港股个股财务指标（用于持仓穿透 ROE）：AKShare stock_hk_financial_indicator_em，返回单行快照
  getStockHkFinancial: 'stock_hk_financial_indicator_em',
  // 港股个股估值历史（用于持仓穿透历史分位）：AKShare stock_hk_indicator_eniu，单指标序列
  getStockHkValueHistory: 'stock_hk_indicator_eniu',
  healthCheck: 'fund_open_fund_daily_em'
});

/**
 * 港股估值历史（stock_hk_indicator_eniu，亿牛网）支持的指标映射：领域字段名 → 亿牛网 indicator 参数。
 *
 * ⚠️ 数据新鲜度（已知限制）：亿牛网已下线港股个股页面（eniu.com/gu/hk00700 返回「未收录此股票」），
 * AKShare 只能返回存档数据 —— 实测所有港股标的最后日期均为 2022-07-13。
 * 配合「近 5 年」分位窗口，港股 PE/PB 分位实际基于 2021-09 ~ 2022-07 的区间，存在系统性偏差。
 * 若要新鲜数据应改用 stock_hk_valuation_baidu（数据到当日，但缺日频密度）。
 *
 * 实测（2026-09-20）：市盈率 / 市净率 返回 200；单只 ~140KB~190KB / 6~18s（较慢）。
 * 市销率 返回的字段是 market_value（市值）而非 PS 比率，不可用于 psPercentile，故未纳入。
 */
export const TOPK_HK_VALUATION_INDICATORS = Object.freeze({
  pe: '市盈率',
  pb: '市净率'
});

/**
 * 缓存 TTL：与项目内现有查询粒度对齐。
 *  - 基础信息 1 天
 *  - 历史净值 1 天
 *  - 最新净值/估值 5 分钟（基于现有 getNetValueStaleTime 行为）
 *  - 单股估值指标 24h（与项目内 fetchStockFundamentalsBatched 对齐）
 */
export const TOPK_CACHE_TTL = Object.freeze({
  searchFund: ONE_DAY_MS,
  getFundDetail: ONE_DAY_MS,
  getFundLatestNav: 5 * 60 * 1000,
  getFundNavHistory: ONE_DAY_MS,
  getFundHoldings: ONE_DAY_MS,
  getFundOverview: ONE_DAY_MS,
  getFundManager: ONE_DAY_MS,
  getFundDividend: ONE_DAY_MS,
  getFundRank: 60 * 60 * 1000,
  getEtfSpot: 60 * 1000,
  getStockFundamentals: ONE_DAY_MS,
  // ROE 为季度财务指标，按天缓存即可（与单股估值同粒度）
  getStockRoe: ONE_DAY_MS,
  // 港股财务指标（季度披露）与估值历史（日频，但仅用于分位统计）同样按天缓存
  getStockHkFinancial: ONE_DAY_MS,
  getStockHkValueHistory: ONE_DAY_MS,
  healthCheck: 5 * 60 * 1000
});

export const TOPK_REQUEST_TIMEOUT_MS = 60000;
export const TOPK_REQUEST_RETRIES = 1;
