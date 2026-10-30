/**
 * AKTools 配置与端点集中管理
 *
 * - baseUrl 必须支持环境变量覆盖（生产可能自建 AKTools 实例）
 * - 端点路径集中，未来 AKTools/AKShare 改动只动本文件
 * - 缓存 TTL 与现有 query-keys 保持同粒度
 *
 * 注意：本文件故意不依赖项目内常量，避免 Provider 启动时被打包进不必要的依赖
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 默认 baseUrl：http://100.68.218.28:18081/api/public（自建 AKTools 实例）
 *
 * 注意：
 * - 默认地址为自建 AKTools 实例；换成自建/托管服务请设置 NEXT_PUBLIC_AKTOOLS_BASE_URL
 * - 生产部署前请确认该地址可达且证书有效
 * - 真实联调结果（2026-08-31）：
 *     fund_name_em: 200, ~5MB 全量, 17s
 *     fund_individual_basic_info_xq: 200, <3KB, <1s
 *     fund_open_fund_info_em: 200, ~300KB, ~2.5s
 *     fund_open_fund_daily_em: 200, ~5MB, 慢/有控制字符
 *     fund_portfolio_hold_em: 500（AKTools/AKShare 端异常，与基金代码无关）
 *     fund_fh_em: 500（AKTools/AKShare 端异常）
 *     fund_etf_spot_em: 500（AKTools/AKShare 端异常）
 *     fund_overview_em: 404（AKTools 未暴露该接口）
 * - 真实联调结果（2026-09-19，单股 ROE 兜底）：
 *     stock_value_em: 200, ~700KB, ~0.8s
 *     stock_financial_analysis_indicator: 200, ~30KB（start_year 限制后）, ~2.4s
 *     stock_financial_analysis_indicator_em: 500（AKTools/AKShare 端异常，不可用）
 *     stock_financial_abstract: 200, ~175KB, ~1.6s
 *     stock_zh_dupont_comparison_em: 200, ~4KB, ~0.2s
 * - 真实联调结果（2026-09-19，港股持仓穿透）：
 *     stock_hk_financial_indicator_em: 200, ~0.7KB, ~0.15s（含股东权益回报率/市盈率/市净率/股息率TTM）
 *     stock_hk_spot_em: 500（AKTools/AKShare 端异常）
 * - 真实联调结果（2026-09-20，港股历史估值源选型；2026-09-26 复测后改选）：
 *     stock_hk_indicator_eniu: 200, ~140~190KB, 6~18s（数据止于 2022-07-13，已弃用）
 *     stock_hk_valuation_baidu: 200, ~17~45KB, 数据到当日（已采用，见 AKTOOLS_HK_VALUATION_INDICATORS）
 *       ⚠️ indicator 必须精确：「市盈率」→500，只有「市盈率(TTM)」可用；「市销率」→500（无港股 PS）
 * - 真实联调结果（2026-09-26，美股持仓穿透选型）：
 *     可用：stock_financial_us_analysis_indicator_em 200, 7~38KB, ~0.5s（含 ROE_AVG / 净利同比 / 营收同比 / 毛利率）
 *           stock_us_daily 200, ~1.1MB（仅 OHLCV 价格，无估值比率）
 *           index_us_stock_sina 200, ~1.2MB
 *     上游报错（500，接口存在但不可用，禁止接入）：
 *           stock_us_spot_em / stock_us_famous_spot_em / stock_us_hist / stock_us_hist_min_em
 *           stock_us_valuation_baidu（市盈率(TTM)/市净率/市销率/市盈率(静)/总市值 × 近一年/近五年 全部 500）
 *           stock_financial_us_report_em / stock_individual_basic_info_us_xq
 *     未暴露（404）：stock_us_min / stock_us_fund_flow_em / stock_us_zh_index_daily
 *           stock_us_profile / stock_us_fundamental / stock_us_indicator_lg
 *     ⇒ 结论：美股只有「当前估值倍数（东财 push2，105./106. secid）」+「AKTools 财务指标」，
 *       不存在可用的美股估值历史序列，故美股 PE/PB/PS 历史分位无法计算（详见 README）。
 * - 真实联调结果（2026-10-30，基金档案/费率/分红/同业/行业/债券/调仓，样本 110022；
 *   脚本见 scripts/aktools-probe.mjs，记录见 doc/akshare-基金接口联调记录.md）：
 *     可用（均 <4KB，~0.2~0.5s）：
 *       fund_overview_em 200 ~838B — 管理费率/托管费率/销售服务费率/净资产规模/业绩比较基准/跟踪标的
 *         ⚠️ 返回是「单行中文键对象」[{基金全称…}]，不是 item/value 对，与 fund_individual_basic_info_xq 不同
 *       fund_individual_detail_info_xq 200 ~913B — 买入规则/卖出规则/其他费用三组，含金额与持有天数阶梯
 *         ⚠️ 条件文本混用「万/元/天/年」，顶级档位的「费用」是固定金额（如 1000.0 = 1000 元/笔），不是百分数
 *       fund_open_fund_info_em(indicator='分红送配详情') 200 ~0.5~2KB — 权益登记日/除息日/分红发放日/每10份分红
 *         ⚠️ 无分红的基金返回 []（如 110022），有分红的样本 000001/519066/161725 均正常
 *       fund_individual_achievement_xq 200 ~3.5KB — 本产品区间收益/最大回撤/周期收益同类排名（"93/1138"）
 *       fund_individual_profit_probability_xq 200 ~267B — 满6个月/1年/3年/5年的盈利概率与平均收益
 *       fund_portfolio_industry_allocation_em 200 ~2.2KB — 行业类别/占净值比例/截止时间
 *       fund_portfolio_bond_hold_em 200 ~1.7KB — 债券代码/债券名称/占净值比例/季度
 *       fund_portfolio_change_em 200 ~3.8KB — 本期累计买入金额/占期初基金资产净值比例（indicator=累计买入/累计卖出）
 *     不可用（禁止接入）：
 *       fund_announcement_dividend_em / fund_announcement_report_em / fund_announcement_personnel_em → 500
 *       fund_cf_em（拆分）→ 500
 *       fund_fee_em（申购费率）→ 200 但返回 []（空表，无数据；赎回费率仅 4 行且无金额阶梯）
 *       fund_etf_spot_em → 15s 超时（仍不可用）
 *     全市场表（返回 MB 级，禁止进客户端请求路径）：
 *       fund_info_index_em 200 ~682KB（1791 行）、fund_open_fund_info_em(indicator='同类排名走势') ~418KB
 *         ⇒ 同类位置改用 fund_individual_achievement_xq（单基金 3.5KB），不要拉排名走势
 */
export const AKTOOLS_DEFAULT_BASE_URL = 'http://100.68.218.28:18081/api/public';

/**
 * 可配置的 baseUrl（构建时内联 / Docker 运行时占位符替换）。
 *
 * ⚠️ 读取方式必须是「静态成员访问」process.env.NEXT_PUBLIC_AKTOOLS_BASE_URL：
 * Next/webpack 只会把这种字面量成员表达式在构建时内联为常量，
 * 写成 process?.env?.NEXT_PUBLIC_AKTOOLS_BASE_URL 或 process.env[key] 都不会被内联
 * —— 此前正是可选链写法，导致构建产物里始终是运行时查表、取不到值，只能回落默认地址。
 *
 * 取值为空串时回落 AKTOOLS_DEFAULT_BASE_URL：
 * Docker 构建阶段该变量是占位符 __NEXT_PUBLIC_AKTOOLS_BASE_URL__，
 * 运行阶段 entrypoint.sh 用真实环境变量替换；未设置时替换为空串，
 * 此时应继续使用默认地址，而不是把 baseUrl 变成空串（会退化成相对路径请求）。
 */
const ENV_AKTOOLS_BASE_URL = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_AKTOOLS_BASE_URL : '';

export const AKTOOLS_BASE_URL = (() => {
  const configured = ENV_AKTOOLS_BASE_URL ? String(ENV_AKTOOLS_BASE_URL).trim().replace(/\/+$/, '') : '';
  return configured || AKTOOLS_DEFAULT_BASE_URL;
})();

/**
 * AKTools Provider metadata
 */
export const AKTOOLS_METADATA = Object.freeze({
  id: 'aktools',
  name: 'AKTools',
  description: '通过 AKTools 服务访问 AKShare 数据',
  baseUrl: AKTOOLS_BASE_URL,
  website: 'https://github.com/akfamily/aktools',
  docsUrl: 'https://aktools.akfamily.xyz/',
  type: 'remote-aktools'
});

/**
 * AKShare 接口端点集中注册。
 * 入参为 AKTools 调用约定（query string）。
 */
export const AKTOOLS_ENDPOINTS = Object.freeze({
  searchFund: 'fund_name_em',
  getFundDetail: 'fund_individual_basic_info_xq',
  getFundLatestNav: 'fund_open_fund_daily_em',
  getFundNavHistory: 'fund_open_fund_info_em',
  getFundHoldings: 'fund_portfolio_hold_em',
  // 基金档案-基本概况（东财）：管理费率/托管费率/销售服务费率/净资产规模/业绩比较基准/跟踪标的
  // ⚠️ 返回单行中文键对象，与 fund_individual_basic_info_xq 的 item/value 对结构不同
  getFundOverview: 'fund_overview_em',
  // 基金档案-交易规则（雪球）：买入规则/卖出规则/其他费用，含金额与持有天数阶梯
  // 替代 fund_fee_em（实测返回空表）：费率阶梯的唯一可用来源
  getFundFeeTiers: 'fund_individual_detail_info_xq',
  // 基金分红明细（东财，复用净值历史端点 + indicator='分红送配详情'）
  // ⚠️ 与 getFundNavHistory 同 URL 不同 indicator，缓存键必须带 indicator 区分
  getFundDividendDetail: 'fund_open_fund_info_em',
  // 基金业绩详情（雪球）：区间收益/最大回撤/同类排名（单基金 ~3.5KB）
  getFundAchievement: 'fund_individual_achievement_xq',
  // 持有盈利概率（雪球）：满 6 月/1 年/3 年/5 年的历史盈利概率（静态历史统计，非预测）
  getFundProfitProbability: 'fund_individual_profit_probability_xq',
  // 基金档案-行业配置（东财）：基金自身披露的行业占净值比例
  getFundIndustryAllocation: 'fund_portfolio_industry_allocation_em',
  // 基金档案-债券持仓（东财）
  getFundBondHoldings: 'fund_portfolio_bond_hold_em',
  // 基金档案-重大变动（东财）：indicator='累计买入' / '累计卖出'
  getFundPortfolioChange: 'fund_portfolio_change_em',
  getFundManager: 'fund_manager_em',
  // ⚠️ fund_fh_em 在 AKTools 实例上返回 500（2026-08-31 与 2026-10-30 两次实测），保持关闭；
  //    分红数据改用 getFundDividendDetail（分红送配详情）
  getFundDividend: 'fund_fh_em',
  getFundRank: 'fund_open_fund_rank_em',
  getEtfSpot: 'fund_etf_spot_em',
  // 单股估值（用于持仓穿透）：AKShare stock_value_em，单只 A 股 6 位代码
  getStockFundamentals: 'stock_value_em',
  // 单股 ROE 兜底（用于持仓穿透）：AKShare stock_financial_analysis_indicator（新浪财经-财务指标）
  // 注意：东财口径的 stock_financial_analysis_indicator_em 在 AKTools 实例上返回 500，故改用新浪口径
  getStockRoe: 'stock_financial_analysis_indicator',
  // 港股个股财务指标（用于持仓穿透 ROE）：AKShare stock_hk_financial_indicator_em，返回单行快照
  getStockHkFinancial: 'stock_hk_financial_indicator_em',
  // 港股个股估值历史（用于持仓穿透历史分位 + 近 1/3 月走势）：AKShare stock_hk_valuation_baidu
  getStockHkValueHistory: 'stock_hk_valuation_baidu',
  // 美股个股财务指标（用于持仓穿透 ROE/盈利增速/营收增速）：AKShare stock_financial_us_analysis_indicator_em
  // 注意：该接口只接受 symbol，附加 indicator/period 等参数会返回 500
  getStockUsFinancial: 'stock_financial_us_analysis_indicator_em',
  healthCheck: 'fund_open_fund_daily_em'
});

/**
 * 港股估值历史（stock_hk_valuation_baidu，百度股市通）支持的指标映射：
 * 领域字段名 → 百度 indicator 参数。
 *
 * ⚠️ 指标名必须精确匹配，实测「市盈率」返回 500，只有「市盈率(TTM)」可用。
 *「市销率」上游 500，故未纳入（港股无 psPercentile）。
 *
 * 选型说明（2026-09-26 重新联调后由 eniu 切换为本源）：
 *   - eniu（stock_hk_indicator_eniu）：亿牛网已下线港股个股页，数据止于 2022-07-13。
 *     用它算「近 5 年分位」实际是拿 2021-09 ~ 2022-07 的区间与今天的值比较，存在系统性偏差。
 *   - baidu：数据到当日（实测最后一点 2026-09-26），近五年 PE 914 行 / PB 约 900 行，
 *     近 3 个月约 45 个点，既够算分位也够画区间走势。
 *   - 因此本源同时服务「当前分位」与「近 1 月/近 3 月估值走势」。
 */
export const AKTOOLS_HK_VALUATION_INDICATORS = Object.freeze({
  pe: '市盈率(TTM)',
  pb: '市净率'
});

/**
 * 港股估值历史取数区间。
 * 「近五年」既覆盖分位所需的 5 年窗口，其尾部又提供近 1~3 月的走势点，单次请求满足两个用途。
 */
export const AKTOOLS_HK_VALUATION_PERIOD = '近五年';

/**
 * 缓存 TTL：与项目内现有查询粒度对齐。
 *  - 基础信息 1 天
 *  - 历史净值 1 天
 *  - 最新净值/估值 5 分钟（基于现有 getNetValueStaleTime 行为）
 *  - 单股估值指标 24h（与项目内 fetchStockFundamentalsBatched 对齐）
 */
export const AKTOOLS_CACHE_TTL = Object.freeze({
  searchFund: ONE_DAY_MS,
  getFundDetail: ONE_DAY_MS,
  getFundLatestNav: 5 * 60 * 1000,
  getFundNavHistory: ONE_DAY_MS,
  getFundHoldings: ONE_DAY_MS,
  getFundOverview: ONE_DAY_MS,
  getFundFeeTiers: ONE_DAY_MS,
  getFundDividendDetail: ONE_DAY_MS,
  // 同类排名按季报/日更均有可能变动，取 6h：既不必每次开弹框重拉，也不会长期错位
  getFundAchievement: 6 * 60 * 60 * 1000,
  getFundProfitProbability: ONE_DAY_MS,
  // 行业/债券持仓与季报同源，按天缓存即可
  getFundIndustryAllocation: ONE_DAY_MS,
  getFundBondHoldings: ONE_DAY_MS,
  getFundPortfolioChange: ONE_DAY_MS,
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
  // 美股财务指标（季度/年度披露，单次 7~38KB）按天缓存
  getStockUsFinancial: ONE_DAY_MS,
  healthCheck: 5 * 60 * 1000
});

export const AKTOOLS_REQUEST_TIMEOUT_MS = 60000;
export const AKTOOLS_REQUEST_RETRIES = 1;
