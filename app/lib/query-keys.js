/** @param {string} normalizedUrl */
export const eastmoneyScript = (normalizedUrl) => ['eastmoneyScript', normalizedUrl];

/** @param {string} fundCode */
export const fundHoldingsArchives = (fundCode) => ['fundHoldingsArchives', String(fundCode).trim()];

/** @param {string} code @param {string} authSegment */
export const relatedSectors = (code, authSegment) => ['relatedSectors', String(code).trim(), String(authSegment)];

/** @param {string} relatedSector */
export const fundSecid = (relatedSector) => ['fundSecid', String(relatedSector).trim()];

/** @param {string} secid */
export const eastSectorQuote = (secid) => ['eastSectorQuote', String(secid).trim()];

/** @param {string} fundCode */
export const pingzhongdata = (fundCode) => ['pingzhongdata', String(fundCode).trim()];

/** @param {string} code @param {string} range @param {string} netValueType */
export const fundHistory = (code, range, netValueType = 'unit') => ['fundHistory', code, range, netValueType];
export const fundValuationTrend = (code, range) => ['fundValuationTrend', code, range];
export const marketStatus = () => ['marketStatus'];

/** @param {string} val */
export const fundSearch = (val) => ['fundSearch', String(val).trim()];

export const eastmoneyFundcodeSearchList = () => ['eastmoneyFundcodeSearchList'];

/** @param {string} fundCode @param {string} dateStr */
export const ocrFundChart = (fundCode, dateStr) => ['ocrFundChart', String(fundCode).trim(), dateStr];

/** @param {string} userId */
export const ocrDailyRemaining = (userId) => ['ocrDailyRemaining', String(userId || '').trim()];

/** @param {string} fundCode */
export const fundConfirmDays = (fundCode) => ['fundConfirmDays', String(fundCode).trim()];

/** @param {string} code @param {string} jzrq @param {number} actualZzl */
export const bestValuationSource = (code, jzrq, actualZzl) => [
  'bestValuationSource',
  String(code).trim(),
  jzrq,
  actualZzl
];

/** @param {string} fundCode */
export const fundBestSource = (fundCode) => ['fundBestSource', String(fundCode).trim()];

/** @param {string} fundCode */
export const isQdiiFund = (fundCode) => ['isQdiiFund', String(fundCode).trim()];

/** @param {string} fundCode - 天天基金 FundValuationLast 批量估值接口缓存键 */
export const fundValuationLast = (fundCode) => ['fundValuationLast', String(fundCode).trim()];

/** @param {string} secid - 东方财富 push2 单股基本面缓存键（"1.600519"） */
export const stockFundamentals = (secid) => ['stockFundamentals', String(secid || '').trim()];

/**
 * 单股 ROE 合并缓存键（A 股：东财 F10 主源 + AKTools 兜底；港股：AKTools 财务指标），值为数值或 null
 * @param {'A'|'HK'} market
 * @param {string} symbol
 */
export const stockRoe = (market, symbol) => ['stockRoe', String(market || 'A'), String(symbol || '').trim()];

/**
 * 美股单股财务指标合并缓存键（ROE / 盈利增速 / 营收增速 / 毛利率），值为对象或 null
 * @param {string} symbol
 */
export const stockUsFinancial = (symbol) => ['stockUsFinancial', String(symbol || '').trim()];

// ============================================================================
// AKTools Provider 查询键
// ============================================================================

/** @param {string} keyword */
export const aktoolsSearchFund = (keyword) => ['aktools', 'searchFund', String(keyword || '').trim()];

/** @param {string} code */
export const aktoolsFundDetail = (code) => ['aktools', 'fundDetail', String(code).trim()];

/** @param {string} code */
export const aktoolsFundLatestNav = (code) => ['aktools', 'fundLatestNav', String(code).trim()];

/** @param {string} code @param {string} sdate @param {string} edate */
export const aktoolsFundNavHistory = (code, sdate, edate) => [
  'aktools',
  'fundNavHistory',
  String(code).trim(),
  String(sdate || ''),
  String(edate || '')
];

/** @param {string} code @param {string} yearOrLatest */
export const aktoolsFundHoldings = (code, yearOrLatest) => [
  'aktools',
  'fundHoldings',
  String(code).trim(),
  String(yearOrLatest || 'latest')
];

/** @param {string} code - 基金基本概况（fund_overview_em：费率/规模/成立日） */
export const aktoolsFundOverview = (code) => ['aktools', 'fundOverview', String(code || '').trim()];

/** @param {string} code - 申赎费率阶梯（fund_individual_detail_info_xq） */
export const aktoolsFundFeeTiers = (code) => ['aktools', 'fundFeeTiers', String(code || '').trim()];

/** @param {string} code - 分红送配明细（fund_open_fund_info_em） */
export const aktoolsFundDividendDetail = (code) => ['aktools', 'fundDividendDetail', String(code || '').trim()];

/** @param {string} code - 同业位置/同类排名（fund_individual_achievement_xq） */
export const aktoolsFundAchievement = (code) => ['aktools', 'fundAchievement', String(code || '').trim()];

/** @param {string} code - 持有盈利概率（fund_individual_profit_probability_xq） */
export const aktoolsFundProfitProbability = (code) => ['aktools', 'fundProfitProbability', String(code || '').trim()];

/** @param {string} code - 行业配置（fund_portfolio_industry_allocation_em） */
export const aktoolsFundIndustryAllocation = (code) => ['aktools', 'fundIndustryAllocation', String(code || '').trim()];

/** @param {string} code - 债券持仓（fund_portfolio_bond_hold_em） */
export const aktoolsFundBondHoldings = (code) => ['aktools', 'fundBondHoldings', String(code || '').trim()];

/** @param {string} code @param {string} indicator - 重大变动/调仓（fund_portfolio_change_em） */
export const aktoolsFundPortfolioChange = (code, indicator) => [
  'aktools',
  'fundPortfolioChange',
  String(code || '').trim(),
  String(indicator || '累计买入')
];

/**
 * stock_value_em 原始历史行缓存键（getStockFundamentals 与 getStockValueHistory 共用同一份数据）
 * @param {string} symbol - 6 位 A 股代码
 */
export const aktoolsStockValueEm = (symbol) => ['aktools', 'stockValueEm', String(symbol || '').trim()];

/** @param {string} symbol - AKTools 单股 ROE 缓存键（6 位 A 股代码） */
export const aktoolsStockRoe = (symbol) => ['aktools', 'stockRoe', String(symbol || '').trim()];

/** @param {string} symbol - AKTools 港股单股 ROE 缓存键（4~5 位港股代码） */
export const aktoolsStockHkRoe = (symbol) => ['aktools', 'stockHkRoe', String(symbol || '').trim()];

/** @param {string} symbol - AKTools 美股单股财务指标缓存键（美股代码，如 AAPL） */
export const aktoolsStockUsFinancial = (symbol) => ['aktools', 'aktoolsStockUsFinancial', String(symbol || '').trim()];

/** @param {string} symbol @param {string} indicatorKey - AKTools 港股单股估值历史缓存键 */
export const aktoolsStockHkValueHistory = (symbol, indicatorKey) => [
  'aktools',
  'stockHkValueHistory',
  String(symbol || '').trim(),
  String(indicatorKey || '')
];

/** AKTools 健康检查（短 TTL） */
export const aktoolsHealth = () => ['aktools', 'health'];

/** @param {string} fundCode - 基金估值评分缓存键 */
export const fundValuationScore = (fundCode) => ['fundValuationScore', String(fundCode || '').trim()];

/** @param {string} fundCode @param {'1m'|'3m'} range - 基金估值区间走势缓存键 */
export const fundValuationHistory = (fundCode, range) => [
  'fundValuationHistory',
  String(fundCode || '').trim(),
  String(range || '')
];

/** @param {string} fundCode - 基金波动信号缓存键（指标与信号本体走 IndexedDB，这里只缓存内存态） */
export const fundVolatility = (fundCode) => ['fundVolatility', String(fundCode || '').trim()];

/** @param {string} fundCode - 基金指标（13 项风险收益指标）缓存键；指标本体现算，这里只缓存内存态 */
export const fundMetrics = (fundCode) => ['fundMetrics', String(fundCode || '').trim()];

/** @param {string} secid - 业绩基准指数日线缓存键（东财 push2his kline，如 '1.000300'） */
export const indexKline = (secid) => ['indexKline', String(secid || '').trim()];
