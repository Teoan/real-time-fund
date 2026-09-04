/**
 * TopK Provider 能力矩阵
 *
 * 标记当前实现的 Provider 支持哪些业务能力。
 * 「AKShare 有接口」≠「TopK 部署的 AKTools 服务实际可用」≠「返回结构符合项目预期」。
 * 因此所有能力在编写时必须按真实联调结果调整；目前未联调，全部能力按"待联调"标记。
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
 */

const DEFAULT_CAPABILITIES = {
  searchFund: false,
  getFundDetail: false,
  getFundLatestNav: false,
  getFundNavHistory: false,
  getFundHoldings: false,
  getFundOverview: false,
  getFundManager: false,
  getFundDividend: false,
  getFundRank: false,
  getEtfSpot: false,
  getFundValuation: false,
  getStockFundamentals: true
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
