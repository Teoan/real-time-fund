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
 * 市场资讯联调通过（2026-11-10 12:07，9/9 全 200）：getMarketFlashCls、getMarketFlashEm、
 *   getMarketFlashSina、getMarketFlashThs、getMarketFlashFutu、getFinanceBreakfast、
 *   getCaixinHighlights、getCctvNews —— 详见文件末尾的实测数据与 scripts/aktools-probe.mjs。
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
 * @property {boolean} getFundRank         - 全市场基金业绩排行（fund_open_fund_rank_em：区间收益/手续费，找基金用）
 * @property {boolean} getEtfSpot          - ETF 实时行情（全市场表接口，本实例 15s 超时，不可用）
 * @property {boolean} getFundValuationRank - 全市场盘中估值表（fund_value_estimation_em：估算涨幅/实际涨幅/估算偏差）
 * @property {boolean} getSectorBoard      - 行业/概念板块行情 + 今日主力净流入（热门板块）
 * @property {boolean} getFundValuation    - 单只基金实时估值（与现有数据源 1/2/3 重复，暂不实现）
 * @property {boolean} getStockFundamentals - A 股个股估值指标（PE/PB/PS/PEG/市值），用于持仓穿透估值
 * @property {boolean} getStockRoe - A 股个股 ROE（加权净资产收益率），东财 F10 直连不可用时的兜底数据源
 * @property {boolean} getStockHkFinancial - 港股个股财务指标快照（含股东权益回报率 ROE），用于港股持仓穿透
 * @property {boolean} getStockHkValueHistory - 港股个股估值历史序列（市盈率/市净率），用于港股持仓历史分位
 * @property {boolean} getStockUsFinancial - 美股个股财务指标（ROE/盈利增速/营收增速/毛利率），用于美股持仓穿透
 * @property {boolean} getMarketFlashCls    - 财联社电报（stock_info_global_cls，symbol=全部/重点）
 * @property {boolean} getMarketFlashEm     - 东财全球财经快讯（stock_info_global_em，200 条）
 * @property {boolean} getMarketFlashSina   - 新浪财经 7x24 快讯（stock_info_global_sina，20 条）
 * @property {boolean} getMarketFlashThs    - 同花顺全球财经直播（stock_info_global_ths，20 条）
 * @property {boolean} getMarketFlashFutu   - 富途牛牛快讯（stock_info_global_futu，50 条）
 * @property {boolean} getFinanceBreakfast  - 东财财经早餐（stock_info_cjzc_em，全部历史）
 * @property {boolean} getCaixinHighlights  - 财新数据通精选（stock_news_main_cx，100 条）
 * @property {boolean} getCctvNews          - 新闻联播文字稿（news_cctv，按日期取单日）
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
  // 联调通过（2026-10-31）：fund_open_fund_rank_em 200。
  // 按 symbol 分类拉全量（AKShare 硬编码 pn=30000，不透传排序/分页参数）：
  //   全部 20689 行 / 7.76MB / 8.2s；股票型 1101 / 413KB / 0.7s；QDII 225 / 85KB / 0.3s
  // 返回「近1周/近1月/近3月/近6月/近1年/近2年/近3年/今年来/成立来 + 手续费」，
  // 补的是项目里唯一缺失的「全市场跨周期业绩榜」（单基金维度的同类排名仍由 getFundAchievement 负责）。
  getFundRank: true,
  // 联调不可用（2026-10-30）：fund_etf_spot_em 全市场表，15s 超时（已超过探针上限），保持关闭。
  getEtfSpot: false,
  // 联调通过（2026-11-05）：fund_value_estimation_em 200 / 782 行 / 266KB / ~3.6s。
  // 这是「估值涨幅/估值跌幅/实际涨幅」三个榜单在 Supabase Edge Function 失联后的替代数据源：
  // 旧的 api.fund.eastmoney.com/FundGuZhi/GetFundGZList 已下线（恒返回 ErrCode -1「暂无数据」）。
  // ⚠️ 只支持 symbol=全部（股票型/混合型/债券型/QDII 均返回 0 行，FOF 直接 400）。
  getFundValuationRank: true,
  // 联调通过（2026-11-05）：stock_board_industry_name_em 200 / 86 行 / 126KB / ~5.5s；
  // stock_board_concept_name_em 200 / 440 行 / 136KB / ~5.8s；
  // stock_sector_fund_flow_rank?indicator=今日&sector_type=行业资金流 200 / 255KB / ~1.7s。
  getSectorBoard: true,
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
  getStockUsFinancial: true,
  // ===== 市场资讯（快讯页）=====
  // 联调通过（2026-11-10 12:07，9/9 全 200，样本为真实资讯流）：
  //   cls 全部 12.6KB/217ms/20 行 · cls 重点 2.7KB/191ms/3 行 · em 113KB/240ms/200 行
  //   sina 13.5KB/215ms/20 行 · ths 13.1KB/1877ms/20 行 · futu 25.9KB/258ms/50 行
  //   cjzc 178.5KB/530ms/400 期 · caixin 23.9KB/529ms/100 行 · cctv 22KB/1.7s（当日 19:00 后才有）
  // 说明：
  //   - 同花顺是唯一接近 2s 的源，5 源并发时整页耗时由它决定；
  //   - 单源失败仍由业务层按源降级（见 app/api/fund.js 的 fetchMarketFlash），
  //     任一接口日后挂掉，把对应开关改回 false 即可，UI 会自动隐藏该源。
  //
  // 财联社电报：symbol=全部 / 重点，单次 20 条，无外链。已知上游抖动（AKShare #5732）。
  getMarketFlashCls: true,
  // 东财全球财经快讯：单次 200 条，字段最全（标题/摘要/时间/链接）。
  getMarketFlashEm: true,
  // 新浪 7x24：单次 20 条，只有时间+内容，标题由内容派生。
  getMarketFlashSina: true,
  // 同花顺全球财经直播：单次 20 条（实测最慢，~1.9s）。
  getMarketFlashThs: true,
  // 富途牛牛快讯：单次 50 条。
  getMarketFlashFutu: true,
  // 东财财经早餐：单次返回**全部历史 400 期**（实测，非 343），业务层裁到 50 期才给 UI。
  getFinanceBreakfast: true,
  // 财新数据通最新 100 条：无时间字段，按上游顺序展示。
  getCaixinHighlights: true,
  // 新闻联播文字稿：按日期取单日，2016-03-30 至今。
  getCctvNews: true
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
