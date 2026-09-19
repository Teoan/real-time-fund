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
  healthCheck: 'fund_open_fund_daily_em'
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
  healthCheck: 5 * 60 * 1000
});

export const TOPK_REQUEST_TIMEOUT_MS = 60000;
export const TOPK_REQUEST_RETRIES = 1;
