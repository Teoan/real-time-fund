/**
 * AKTools Provider 能力矩阵
 *
 * 标记当前实现的 Provider 支持哪些业务能力。
 * 「AKShare 有接口」≠「AKTools 服务实际可用」≠「返回结构符合项目预期」。
 * 因此所有能力在编写时必须按真实联调结果调整；
 * 已联调开启（2026-10-30 复核，样本 110022 / 000001）：
 *   getFundDetail、getFundHoldings、getFundOverview、getFundFeeTiers、getFundDividendDetail、
 *   getFundAchievement、getFundProfitProbability、getFundIndustryAllocation、getFundBondHoldings、
 *   getFundPortfolioChange、getStockFundamentals、getStockRoe、getStockHkFinancial、
 *   getStockHkValueHistory、getStockUsFinancial；
 * 明确不可用（联调 500 / 超时，保持关闭）：getFundAnnouncement（公告类 3 个接口全 500）、getEtfSpot（15s 超时）。
 *
 * @typedef {object} AktoolsProviderCapabilities
 * @property {boolean} searchFund          - 基金搜索
 * @property {boolean} getFundDetail       - 基金详情
 * @property {boolean} getFundLatestNav    - 最新净值
 * @property {boolean} getFundNavHistory   - 历史净值
 * @property {boolean} getFundHoldings     - 基金持仓（季度披露）
 * @property {boolean} getFundOverview     - 基本概况（fund_overview_em：管理费/托管费/规模/成立日/业绩基准）
 * @property {boolean} getFundManager      - 基金经理（已由 getFundOverview 的「基金经理人」覆盖，不再单独实现）
 * @property {boolean} getFundDividend     - 基金分红（旧口径，未实现；分红明细请用 getFundDividendDetail）
 * @property {boolean} getFundDividendDetail - 分红送配明细（fund_open_fund_info_em indicator=分红送配详情）
 * @property {boolean} getFundFeeTiers     - 申赎费率阶梯（fund_individual_detail_info_xq）
 * @property {boolean} getFundAchievement  - 同业位置（区间收益/最大回撤/同类排名，fund_individual_achievement_xq）
 * @property {boolean} getFundProfitProbability - 持有盈利概率（fund_individual_profit_probability_xq）
 * @property {boolean} getFundIndustryAllocation - 行业配置（fund_portfolio_industry_allocation_em）
 * @property {boolean} getFundBondHoldings - 债券持仓（fund_portfolio_bond_hold_em）
 * @property {boolean} getFundPortfolioChange - 重大变动/调仓（fund_portfolio_change_em）
 * @property {boolean} getFundAnnouncement - 公告类（dividend/report/personnel 三个接口均 500，不可用）
 * @property {boolean} getFundRank         - 基金排行榜（同类排名由 getFundAchievement 覆盖，不单独实现）
 * @property {boolean} getEtfSpot          - ETF 实时行情（全市场表接口，本实例 15s 超时，不可用）
 * @property {boolean} getFundValuation    - 实时估值（与现有数据源 1/2/3 重复，暂不实现）
 * @property {boolean} getStockFundamentals - A 股个股估值指标（PE/PB/PS/PEG/市值），用于持仓穿透估值
 * @property {boolean} getStockRoe - A 股个股 ROE（加权净资产收益率），东财 F10 直连不可用时的兜底数据源
 * @property {boolean} getStockHkFinancial - 港股个股财务指标快照（含股东权益回报率 ROE），用于港股持仓穿透
 * @property {boolean} getStockHkValueHistory - 港股个股估值历史序列（市盈率/市净率），用于港股持仓历史分位
 * @property {boolean} getStockUsFinancial - 美股个股财务指标（ROE/盈利增速/营收增速/毛利率），用于美股持仓穿透
 */

const DEFAULT_CAPABILITIES = {
  searchFund: false,
  // 联调通过（2026-09-13）：fund_individual_basic_info_xq 200 / <3KB / <1s，
  // 返回 item/value 对，含「基金类型」「基金名称」字段，估值评分分类依赖它
  getFundDetail: true,
  getFundLatestNav: false,
  getFundNavHistory: false,
  // 联调通过（2026-10-16）：fund_portfolio_hold_em 200 / ~20~24KB / ~0.5s，
  // 返回指定年份「全部季度」（Q1/Q3 仅前十大、Q2/Q4 为半年报/年报全量），
  // 用作东财移动端 FundMNInverstPosition「网络繁忙」时的持仓兜底。
  // ⚠️ date 必须显式传空串才取「最新可用年份」；省略参数会落到 AKShare 签名默认值 "2024"（静默陈旧）。
  getFundHoldings: true,
  // 联调通过（2026-10-30）：fund_overview_em 200 / ~0.9KB / ~0.3s / 1 行。
  // 是「管理费率/托管费率/销售服务费率/净资产规模/份额规模/成立日/业绩比较基准/跟踪标的」的唯一来源
  // （fund_individual_basic_info_xq 不含费率）。
  getFundOverview: true,
  // 未单独实现：基金经理已包含在 fund_overview_em 的「基金经理人」字段里。
  getFundManager: false,
  // 未实现旧口径：fund_open_fund_info_em 的「分红送配详情」由 getFundDividendDetail 承接。
  getFundDividend: false,
  // 联调通过（2026-10-30）：fund_open_fund_info_em?indicator=分红送配详情
  // 200 / 0~2KB / 有分红基金返回多行（000001 共 25 行），无分红基金返回 []。
  getFundDividendDetail: true,
  // 联调通过（2026-10-30）：fund_individual_detail_info_xq 200 / ~0.9KB / ~0.25s / 10 行。
  // 覆盖买入阶梯（金额区间）+ 卖出阶梯（持有天数区间）+ 管理费/托管费；
  // 注意 fund_fee_em 的「申购费率」在本实例返回 0 行，只有「赎回费率」可用，故不采用 fund_fee_em。
  getFundFeeTiers: true,
  // 联调通过（2026-10-30）：fund_individual_achievement_xq 200 / 3.5KB / ~0.53s / 24 行，
  // 含「周期收益同类排名」（如 93/1138），是同类排名与区间回撤的唯一来源。
  getFundAchievement: true,
  // 联调通过（2026-10-30）：fund_individual_profit_probability_xq 200 / 267B / ~0.23s / 4 行。
  getFundProfitProbability: true,
  // 联调通过（2026-10-30）：fund_portfolio_industry_allocation_em 200 / 2.2KB / ~0.96s / 18 行。
  // 注意：date 传空串取最新期，与 getFundHoldings 同理。
  getFundIndustryAllocation: true,
  // 联调通过（2026-10-30）：fund_portfolio_bond_hold_em 200 / 1.7KB / ~0.21s / 11 行。
  getFundBondHoldings: true,
  // 联调通过（2026-10-30）：fund_portfolio_change_em 200 / 3.8KB / ~0.23s / 20 行。
  // indicator 取「累计买入」/「累计卖出」，date 传空串取最新季度。
  getFundPortfolioChange: true,
  // 联调不可用（2026-10-30）：fund_announcement_dividend_em / fund_announcement_report_em /
  // fund_announcement_personnel_em 三个接口均返回 500 Internal Server Error，保持关闭。
  getFundAnnouncement: false,
  getFundRank: false,
  // 联调不可用（2026-10-30）：fund_etf_spot_em 全市场表，15s 超时（已超过探针上限），保持关闭。
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
  getStockHkValueHistory: true,
  // 联调通过（2026-09-26）：stock_financial_us_analysis_indicator_em 200 / 7~38KB / ~0.5s，
  // 返回按报告期排列的财务指标，取最新一期的 ROE_AVG / 净利同比 / 营收同比 / 毛利率。
  // 是美股持仓 ROE 与成长性指标的唯一来源（东财 push2 无 ROE，且 f185 对美股恒为 0）。
  getStockUsFinancial: true
};

export const AKTOOLS_CAPABILITIES = Object.freeze({ ...DEFAULT_CAPABILITIES });

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
