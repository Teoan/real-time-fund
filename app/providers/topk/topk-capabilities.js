/**
 * TopK Provider 能力矩阵
 *
 * 标记当前实现的 Provider 支持哪些业务能力。
 * 「AKShare 有接口」≠「TopK 部署的 AKTools 服务实际可用」≠「返回结构符合项目预期」。
 * 因此所有能力在编写时必须按真实联调结果调整；
 * 已联调开启：getStockFundamentals、getFundDetail；其余待联调，保持关闭。
 *
 * @typedef {object} TopKProviderCapabilities
 * @property {boolean} searchFund          - 基金搜索
 * @property {boolean} getFundDetail       - 基金详情
 * @property {boolean} getFundLatestNav    - 最新净值
 * @property {boolean} getFundNavHistory   - 历史净值
 * @property {boolean} getFundHoldings     - 基金持仓（季度披露）
 * @property {boolean} getFundOverview     - 基本概况
 * @property {boolean} getFundManager      - 基金经理
 * @property {boolean} getFundDividend     - 基金分红
 * @property {boolean} getFundRank         - 基金排行榜
 * @property {boolean} getEtfSpot          - ETF 实时行情
 * @property {boolean} getFundValuation    - 实时估值（与现有数据源 1/2/3 重复，暂不实现）
 * @property {boolean} getStockFundamentals - A 股个股估值指标（PE/PB/PS/PEG/市值），用于持仓穿透估值
 * @property {boolean} getStockRoe - A 股个股 ROE（加权净资产收益率），东财 F10 直连不可用时的兜底数据源
 * @property {boolean} getStockHkFinancial - 港股个股财务指标快照（含股东权益回报率 ROE），用于港股持仓穿透
 * @property {boolean} getStockHkValueHistory - 港股个股估值历史序列（市盈率/市净率），用于港股持仓历史分位
 */

const DEFAULT_CAPABILITIES = {
  searchFund: false,
  // 联调通过（2026-09-13）：fund_individual_basic_info_xq 200 / <3KB / <1s，
  // 返回 item/value 对，含「基金类型」「基金名称」字段，估值评分分类依赖它
  getFundDetail: true,
  getFundLatestNav: false,
  getFundNavHistory: false,
  getFundHoldings: false,
  getFundOverview: false,
  getFundManager: false,
  getFundDividend: false,
  getFundRank: false,
  getEtfSpot: false,
  getFundValuation: false,
  getStockFundamentals: true,
  // 联调通过（2026-09-19）：stock_financial_analysis_indicator 200 / ~30KB（start_year 限制后）/ ~2.4s。
  // 作为东财 F10（主源）不可用时的 ROE 兜底；调用失败会被业务层吞掉并回落 null，不影响主流程。
  // 注意：东财口径的 stock_financial_analysis_indicator_em 在同一实例上返回 500，不可用。
  getStockRoe: true,
  // 联调通过（2026-09-19）：stock_hk_financial_indicator_em 200 / ~0.7KB / ~0.15s，
  // 提供「股东权益回报率(%)」，是港股 ROE 的唯一数据源（东财 F10 不覆盖港股）。
  getStockHkFinancial: true,
  // 联调通过（2026-09-19）：stock_hk_valuation_baidu 200 / ~30KB / ~0.1s。
  // 仅支持市盈率(TTM) / 市净率（市销率、股息率上游 500），用于港股 PE/PB 历史分位。
  getStockHkValueHistory: true
};

export const TOPK_CAPABILITIES = Object.freeze({ ...DEFAULT_CAPABILITIES });

/**
 * 合并用户/测试覆盖的能力集合，生成新对象（不修改默认）。
 */
export const mergeCapabilities = (overrides = {}) => ({ ...DEFAULT_CAPABILITIES, ...overrides });

/**
 * 检查 Provider 实例上是否启用了某项能力。
 * @param {object} cap  Provider 实例上的 capabilities 对象
 * @param {string} name 能力名
 */
export const isCapabilitySupported = (cap, name) =>
  Boolean(cap) && Object.prototype.hasOwnProperty.call(cap, name) && cap[name] === true;
