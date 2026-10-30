/**
 * AKTools (AKShare) → 项目内部 Domain Model 字段映射器
 *
 * 关键原则：
 *   - 任何 AKShare 中文/原始字段名都不得泄漏到业务层
 *   - 所有数字经过 Number.isFinite 校验；非法值归一为 null
 *   - 所有日期归一为 YYYY-MM-DD
 *
 * AKShare 字段引用：
 *   - fund_name_em: 基金代码/拼音缩写/基金简称/基金类型/拼音全称
 *   - fund_open_fund_info_em(indicator='单位净值走势'): 净值日期/单位净值/日增长率
 *   - fund_portfolio_hold_em: 股票代码/股票名称/占净值比例/持股数/持仓市值/季度
 */

const _isNil = (v) => v == null;

const toFiniteNumber = (raw) => {
  if (_isNil(raw)) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const stripped = raw.replace(/[%,亿万元份额只]/g, '').trim();
    if (stripped === '' || stripped.toLowerCase() === 'nan' || stripped.toLowerCase() === 'nat') return null;
    const n = Number(stripped);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const toIsoDate = (raw) => {
  if (_isNil(raw)) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // AKShare 返回值常见格式：'YYYY-MM-DD' 或 'YYYYMMDD' 或 'YYYY-MM-DD HH:mm:ss'
  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }
  return null;
};

const pickString = (raw) => {
  if (_isNil(raw)) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === 'nan') return null;
  return s;
};

/**
 * fund_name_em 单行 → 搜索结果项
 * @param {object} row
 * @returns {{ code: string, name: string, type: string|null }}
 */
export const mapSearchFundRow = (row) => {
  if (!row || typeof row !== 'object') return null;
  const code = pickString(row['基金代码']);
  if (!code) return null;
  return {
    code,
    name: pickString(row['基金简称']),
    type: pickString(row['基金类型'])
  };
};

/**
 * fund_open_fund_info_em(indicator='单位净值走势') 单行 → 历史净值项
 * @param {object} row
 * @returns {{ date: string, unitNav: number|null, accumulatedNav: number|null, dailyReturn: number|null }}
 */
export const mapNavHistoryRow = (row) => {
  if (!row || typeof row !== 'object') return null;
  const date = toIsoDate(row['净值日期']);
  if (!date) return null;
  return {
    date,
    unitNav: toFiniteNumber(row['单位净值']),
    accumulatedNav: null,
    dailyReturn: toFiniteNumber(row['日增长率'])
  };
};

/**
 * fund_portfolio_hold_em 单行 → 持仓项
 * @param {object} row
 * @returns {{ stockCode: string|null, stockName: string|null, weight: number|null, shares: number|null, marketValue: number|null, reportDate: string|null }}
 */
export const mapHoldingRow = (row) => {
  if (!row || typeof row !== 'object') return null;
  const code = pickString(row['股票代码']);
  const name = pickString(row['股票名称']);
  if (!code && !name) return null;
  return {
    stockCode: code,
    stockName: name,
    weight: toFiniteNumber(row['占净值比例']),
    shares: toFiniteNumber(row['持股数']),
    marketValue: toFiniteNumber(row['持仓市值']),
    reportDate: extractReportDate(row['季度'])
  };
};

/**
 * 从 "2024 年1季度股票投资明细" 中提取季度日期 2024-03-31。
 * 仅做粗略映射（Q1=03-31 / Q2=06-30 / Q3=09-30 / Q4=12-31）。
 */
const QUARTER_END_MAP = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' };
const extractReportDate = (raw) => {
  const s = pickString(raw);
  if (!s) return null;
  const m = s.match(/(\d{4})\s*年\s*([1-4])\s*季度/);
  if (!m) return null;
  return `${m[1]}-${QUARTER_END_MAP[m[2]] || ''}`;
};

/**
 * fund_overview_em 单行（DataFrame 转置后是 [{item, value}...]） → 基本概况
 * @param {Array<object>} rows
 */
export const mapOverviewRows = (rows) => {
  if (!Array.isArray(rows)) return null;
  const out = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const k = pickString(row['item'] ?? row['项目']);
    const v = pickString(row['value'] ?? row['值']);
    if (k && v) out[k] = v;
  }
  return out;
};

/**
 * 解析 ISO 时间戳（"2018-01-02T00:00:00.000"）为毫秒时间戳。
 */
const parseAkShareTimestamp = (raw) => {
  const s = pickString(raw);
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
};

/**
 * stock_value_em 整行 → 单股估值（保留最近交易日一行）
 *
 * 输入是历史序列（最多约 2100 条），返回结构与项目内 fetchStockFundamentalsBatched
 * 的 StockFundamental 保持一致：
 *   { secid, market, code, name, price, totalMv, freeMv,
 *     pe, pb, ps, dividendYield, peg, epsGrowth, updateTime, fetchedAt }
 *
 * 字段映射（项目字段 ← AKShare 列名）：
 *   pe             ← PE(TTM)
 *   pb             ← 市净率
 *   ps             ← 市销率   （项目沿用 push2 f165 命名）
 *   peg            ← PEG值
 *   dividendYield  ← null     （stock_value_em 无此列；由 fund.js 的 push2 f126 轻量请求补充）
 *   epsGrowth      ← null     （stock_value_em 无此列；由 fund.js 的 push2 f185 轻量请求补充）
 *   price          ← 当日收盘价
 *   totalMv        ← 总市值
 *   freeMv         ← 流通市值
 *   updateTime     ← 数据日期（毫秒时间戳）
 */
export const mapStockFundamentalLatest = (rows, ctx = {}) => {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const ta = parseAkShareTimestamp(a['数据日期']) || 0;
    const tb = parseAkShareTimestamp(b['数据日期']) || 0;
    return tb - ta;
  });
  const row = sorted[0];
  if (!row || typeof row !== 'object') return null;

  return {
    secid: pickString(ctx.secid) || null,
    market: pickString(ctx.market) || 'A',
    code: pickString(ctx.code) || pickString(row['股票代码']) || null,
    name: pickString(ctx.name) || pickString(row['股票名称']) || null,
    price: toFiniteNumber(row['当日收盘价']),
    totalMv: toFiniteNumber(row['总市值']),
    freeMv: toFiniteNumber(row['流通市值']),
    pe: toFiniteNumber(row['PE(TTM)']),
    pb: toFiniteNumber(row['市净率']),
    ps: toFiniteNumber(row['市销率']),
    dividendYield: null,
    peg: toFiniteNumber(row['PEG值']),
    epsGrowth: null,
    updateTime: parseAkShareTimestamp(row['数据日期']),
    fetchedAt: Date.now()
  };
};

/**
 * stock_value_em 单行 → 单日估值点（保留完整历史序列，用于历史分位计算）
 *
 * 与 mapStockFundamentalLatest 的区别：后者只取最新一行，本函数保留逐日序列。
 *
 * 字段映射（项目字段 ← AKShare 列名）：
 *   date ← 数据日期
 *   pe   ← PE(TTM)
 *   pb   ← 市净率
 *   ps   ← 市销率   （项目沿用 push2 f165 命名）
 *   peg  ← PEG值
 *
 * @param {object} row
 * @returns {{ date: string, price: number|null, pe: number|null, pb: number|null, ps: number|null, peg: number|null }|null}
 */
export const mapStockValueRow = (row) => {
  if (!row || typeof row !== 'object') return null;
  const date = toIsoDate(row['数据日期']);
  if (!date) return null;
  return {
    date,
    price: toFiniteNumber(row['当日收盘价']),
    pe: toFiniteNumber(row['PE(TTM)']),
    pb: toFiniteNumber(row['市净率']),
    ps: toFiniteNumber(row['市销率']),
    peg: toFiniteNumber(row['PEG值'])
  };
};

/**
 * stock_value_em 整段历史 → 按数据日期升序的估值序列。
 */
export const mapStockValueHistory = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows
    .map(mapStockValueRow)
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};

/**
 * stock_financial_analysis_indicator 整段历史 → 最近一期报告的 ROE（%）
 *
 * 接口返回按报告期排列的二维表（每行一个报告期），每列一个财务指标。
 * 取最近一期报告的「加权净资产收益率(%)」（与东财 F10 ROEJQ 同口径，实测茅台中报均为 16.75），
 * 该列缺失时回退「净资产收益率(%)」。全部缺失返回 null。
 *
 * @param {Array<object>} rows
 * @returns {number|null}
 */
const ROE_COLUMNS = ['加权净资产收益率(%)', '净资产收益率(%)'];

export const mapStockRoe = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // 接口本身按报告期升序返回，这里防御性再排一次，确保取到最新一期
  const sorted = rows
    .filter((r) => r && typeof r === 'object')
    .sort((a, b) => {
      const da = pickString(a['日期']) || '';
      const db = pickString(b['日期']) || '';
      return da < db ? -1 : da > db ? 1 : 0;
    });
  for (let i = sorted.length - 1; i >= 0; i--) {
    for (const col of ROE_COLUMNS) {
      const v = toFiniteNumber(sorted[i][col]);
      if (v != null) return v;
    }
  }
  return null;
};

/**
 * stock_hk_financial_indicator_em 单行快照 → 股东权益回报率（ROE，%）
 *
 * 港股无东财 F10 主要财务指标接口，该接口的「股东权益回报率(%)」是港股 ROE 的唯一来源。
 *
 * @param {Array<object>} rows
 * @returns {number|null}
 */
const HK_ROE_COLUMNS = ['股东权益回报率(%)', '净资产收益率(%)'];

export const mapStockHkRoe = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows.find((r) => r && typeof r === 'object');
  if (!row) return null;
  for (const col of HK_ROE_COLUMNS) {
    const v = toFiniteNumber(row[col]);
    if (v != null) return v;
  }
  return null;
};

/**
 * stock_financial_us_analysis_indicator_em 整段历史 → 最近一期报告的美股财务指标
 *
 * 接口返回按报告期排列的二维表（实测单只 7~35 行，含年报/季报），每行一个报告期。
 * 取 REPORT_DATE 最大的一行，映射为美股持仓穿透所需的成长性与盈利质量指标：
 *   roe           ← ROE_AVG                        （平均净资产收益率，%）
 *   epsGrowth     ← PARENT_HOLDER_NETPROFIT_YOY    （归母净利润同比，%）
 *   revenueGrowth ← OPERATE_INCOME_YOY             （营业收入同比，%）
 *   grossMargin   ← GROSS_PROFIT_RATIO             （毛利率，%；跨行业不可比，仅备用不参与打分）
 *   reportDate    ← REPORT_DATE
 *   currency      ← CURRENCY_ABBR
 *
 * ⚠️ 美股 ROE 受回购影响系统性偏高（实测 AAPL 171% / NVDA 101%），业务层已下调其权重。
 *
 * @param {Array<object>} rows
 * @returns {{ roe: number|null, epsGrowth: number|null, revenueGrowth: number|null,
 *             grossMargin: number|null, reportDate: string|null, currency: string|null }|null}
 */
export const mapStockUsFinancial = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sorted = rows
    .filter((r) => r && typeof r === 'object')
    .sort((a, b) => {
      const da = pickString(a['REPORT_DATE']) || '';
      const db = pickString(b['REPORT_DATE']) || '';
      return da < db ? -1 : da > db ? 1 : 0;
    });
  const row = sorted[sorted.length - 1];
  if (!row) return null;

  const result = {
    roe: toFiniteNumber(row['ROE_AVG']),
    epsGrowth: toFiniteNumber(row['PARENT_HOLDER_NETPROFIT_YOY']),
    revenueGrowth: toFiniteNumber(row['OPERATE_INCOME_YOY']),
    grossMargin: toFiniteNumber(row['GROSS_PROFIT_RATIO']),
    reportDate: toIsoDate(row['REPORT_DATE']),
    currency: pickString(row['CURRENCY_ABBR'])
  };

  // 全部指标缺失视为无效（避免把空报告当成有效结果缓存）
  const hasAny =
    result.roe != null || result.epsGrowth != null || result.revenueGrowth != null || result.grossMargin != null;
  return hasAny ? result : null;
};

/**
 * 港股单指标估值序列 → 按日期升序的估值历史
 *
 * 兼容两种上游形态：
 *   - stock_hk_valuation_baidu（当前采用）：[{ date, value }] —— 走 valueKey 回退分支
 *   - stock_hk_indicator_eniu（已弃用）：[{ date, <指标键>, price }]，如市盈率为 pe、市净率为 pb
 *
 * 通过 valueKey 指定取哪个指标列，归一为统一的 { date, value } 结构并过滤非法行。
 *
 * @param {Array<object>} rows
 * @param {string} [valueKey] - 指标列名（如 'pe' / 'pb'）；缺省时回退到 'value'
 * @returns {Array<{ date: string, value: number }>}
 */
export const mapStockHkValueHistory = (rows, valueKey) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const date = toIsoDate(row.date);
      const hasKey = valueKey != null && Object.prototype.hasOwnProperty.call(row, valueKey);
      const value = toFiniteNumber(hasKey ? row[valueKey] : row.value);
      if (!date || value == null) return null;
      return { date, value };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};

export const __test__ = { toFiniteNumber, toIsoDate, pickString, extractReportDate, parseAkShareTimestamp };

// ============================================================================
// 基金档案 / 费率 / 分红 / 同业 / 行业 / 债券 / 调仓
// （AKShare 列名 ↔ 领域字段的唯一映射点；缺列一律返回 null，绝不 0 顶替）
// ============================================================================

/**
 * 中文日期 → YYYY-MM-DD。
 * 兼容「2010年08月20日」「2010年08月20日 / 63.727亿份」「2010-08-20」。
 */
const parseChineseDate = (raw) => {
  const s = pickString(raw);
  if (!s) return null;
  const m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return toIsoDate(s);
};

/**
 * 解析「103.09亿元（截止至：2026年09月30日）」这类带单位与截止日的规模文本。
 * @returns {{ value: number|null, unit: string|null, asOf: string|null }|null}
 */
const parseScaledAmount = (raw) => {
  const s = pickString(raw);
  if (!s) return null;
  const num = s.match(/([\d.]+)\s*(亿元|亿份|万元|万份|元)/);
  if (!num) return null;
  const value = toFiniteNumber(num[1]);
  if (value == null) return null;
  const asOfMatch = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  return {
    value,
    unit: num[2],
    asOf: asOfMatch
      ? `${asOfMatch[1]}-${String(asOfMatch[2]).padStart(2, '0')}-${String(asOfMatch[3]).padStart(2, '0')}`
      : null
  };
};

/**
 * 解析「1.20%（每年）」「0.20%（每年）」「---（每年）」→ 百分数数字或 null。
 */
const parseFeePercent = (raw) => {
  const s = pickString(raw);
  if (!s) return null;
  const m = s.match(/([\d.]+)\s*%/);
  return m ? toFiniteNumber(m[1]) : null;
};

/**
 * fund_overview_em 整段 → 基金档案基本概况。
 *
 * ⚠️ 上游返回是**单行中文键对象**（不是 fund_individual_basic_info_xq 的 item/value 对），
 * 所以不能复用 mapOverviewRows。
 *
 * 字段映射（领域字段 ← 列名）：
 *   fullName           ← 基金全称
 *   shortName          ← 基金简称
 *   type               ← 基金类型
 *   issueDate          ← 发行日期            （"2010年07月26日" → 2010-07-26）
 *   establishDate      ← 成立日期/规模        （只取斜杠前的日期部分）
 *   establishScale     ← 成立日期/规模        （斜杠后的份额，如 63.727亿份）
 *   scale              ← 净资产规模          （{ value, unit, asOf }）
 *   shares             ← 份额规模            （{ value, unit, asOf }）
 *   company            ← 基金管理人
 *   custodian          ← 基金托管人
 *   manager            ← 基金经理人
 *   dividendSinceStart ← 成立来分红          （保留原文，如「每份累计0.00元（0次）」）
 *   managementFee      ← 管理费率            （百分数，1.20% → 1.2）
 *   custodianFee       ← 托管费率
 *   salesServiceFee    ← 销售服务费率        （「---（每年）」→ null）
 *   maxSubscriptionFee ← 最高认购费率        （百分数）
 *   benchmark          ← 业绩比较基准
 *   trackingIndex      ← 跟踪标的            （「该基金无跟踪标的」→ null）
 *
 * @param {Array<object>} rows
 * @returns {object|null} 无有效字段时返回 null
 */
export const mapFundOverviewSnapshot = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows.find((r) => r && typeof r === 'object');
  if (!row) return null;

  const establishRaw = pickString(row['成立日期/规模']);
  const establishDate = parseChineseDate(establishRaw);
  const establishScaleRaw = establishRaw && establishRaw.includes('/') ? establishRaw.split('/')[1] : null;
  const trackingRaw = pickString(row['跟踪标的']);

  const result = {
    fullName: pickString(row['基金全称']),
    shortName: pickString(row['基金简称']),
    type: pickString(row['基金类型']),
    issueDate: parseChineseDate(row['发行日期']),
    establishDate,
    establishScale: parseScaledAmount(establishScaleRaw),
    scale: parseScaledAmount(row['净资产规模']),
    shares: parseScaledAmount(row['份额规模']),
    company: pickString(row['基金管理人']),
    custodian: pickString(row['基金托管人']),
    manager: pickString(row['基金经理人']),
    dividendSinceStart: pickString(row['成立来分红']),
    managementFee: parseFeePercent(row['管理费率']),
    custodianFee: parseFeePercent(row['托管费率']),
    salesServiceFee: parseFeePercent(row['销售服务费率']),
    maxSubscriptionFee: parseFeePercent(row['最高认购费率']),
    benchmark: pickString(row['业绩比较基准']),
    trackingIndex: trackingRaw && !trackingRaw.includes('无跟踪标的') ? trackingRaw : null
  };

  const hasAny = Object.values(result).some((v) => v != null);
  return hasAny ? result : null;
};

const UNIT_TO_BASE = { 万: 10000, 元: 1, 天: 1, 年: 365 };

/**
 * 解析费率阶梯的条件文本。
 *
 * 实测形态（fund_individual_detail_info_xq）：
 *   买入规则：'0.0万<买入金额<100.0万' / '100.0万<=买入金额<500.0万' / '1000.0万<=买入金额'
 *   卖出规则：'0.0天<持有期限<7.0天' / '365.0天<=持有期限<2.0年' / '2.0年<=持有期限'
 *
 * 归一化口径：金额 → 元；期限 → 天（1 年 = 365 天）。
 * 比较符语义：`<` 为开区间（不含边界），`<=` 为闭区间（含边界）。
 *
 * @param {string} raw
 * @returns {{ min: number|null, minInclusive: boolean, max: number|null, maxInclusive: boolean,
 *             kind: 'amount'|'days' }|null}
 */
export const parseFeeTierCondition = (raw) => {
  const s = pickString(raw);
  if (!s) return null;
  const m = s.match(
    /^(?:([\d.]+)\s*(万|元|天|年))?\s*(<=|<)\s*(买入金额|持有期限)\s*(?:(<=|<)\s*([\d.]+)\s*(万|元|天|年))?$/
  );
  if (!m) return null;
  const [, lNum, lUnit, lCmp, field, rCmp, rNum, rUnit] = m;
  const kind = field === '持有期限' ? 'days' : 'amount';
  const toBase = (value, unit) => {
    const n = toFiniteNumber(value);
    if (n == null) return null;
    const factor = UNIT_TO_BASE[unit];
    return factor == null ? null : n * factor;
  };
  return {
    min: lNum != null ? toBase(lNum, lUnit) : null,
    // '0.0万<买入金额' → 金额 > 0（不含下界）；'100.0万<=买入金额' → 金额 >= 100万（含下界）
    minInclusive: lCmp === '<=',
    max: rNum != null ? toBase(rNum, rUnit) : null,
    maxInclusive: rCmp === '<=',
    kind
  };
};

/**
 * 费用值语义判定。
 *
 * 上游「费用」列在百分之九十九的行里是百分数（1.5 = 1.5%），
 * 但**顶级档位**会用固定金额表达（如「1000.0万<=买入金额」→ 1000.0 意为每笔 1000 元）。
 * 申购/赎回费率不存在 ≥100% 的情形，故以 100 为界区分（阈值刻意取得比任何真实费率都高）。
 */
const toFeeParts = (raw) => {
  const n = toFiniteNumber(raw);
  if (n == null) return { rate: null, fixedFee: null };
  if (n >= 100) return { rate: null, fixedFee: n };
  return { rate: n, fixedFee: null };
};

/**
 * fund_individual_detail_info_xq 整段 → 费率阶梯。
 *
 * @param {Array<object>} rows
 * @returns {{ buy: Array<object>, sell: Array<object>,
 *             other: { managementFee: number|null, custodianFee: number|null, salesServiceFee: number|null },
 *             hasTiers: boolean }}
 */
export const mapFundFeeTiers = (rows, meta = {}) => {
  const empty = {
    buy: [],
    sell: [],
    other: { managementFee: null, custodianFee: null, salesServiceFee: null },
    hasTiers: false,
    source: 'aktools',
    fetchedAt: Date.now()
  };
  if (!Array.isArray(rows) || rows.length === 0) return empty;

  const buy = [];
  const sell = [];
  let managementFee = null;
  let custodianFee = null;
  let salesServiceFee = null;

  const OTHER_FEE_NAME_MAP = {
    基金管理费: 'management',
    基金托管费: 'custodian',
    销售服务费: 'salesService'
  };

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const type = pickString(row['费用类型']);
    const condition = pickString(row['条件或名称']);
    if (!type || !condition) continue;

    if (type === '其他费用') {
      const key = OTHER_FEE_NAME_MAP[condition];
      const fee = toFeeParts(row['费用']);
      const rate = fee.rate;
      if (key === 'management') managementFee = rate;
      else if (key === 'custodian') custodianFee = rate;
      else if (key === 'salesService') salesServiceFee = rate;
      continue;
    }

    if (type !== '买入规则' && type !== '卖出规则') continue;
    const parsed = parseFeeTierCondition(condition);
    if (!parsed) continue;
    const fee = toFeeParts(row['费用']);
    const tier = {
      min: parsed.min,
      minInclusive: parsed.minInclusive,
      max: parsed.max,
      maxInclusive: parsed.maxInclusive,
      unit: parsed.kind,
      rate: fee.rate,
      fixedFee: fee.fixedFee,
      label: condition
    };
    if (type === '买入规则') buy.push(tier);
    else sell.push(tier);
  }

  const byMin = (a, b) => (a.min == null ? -1 : a.min) - (b.min == null ? -1 : b.min);
  buy.sort(byMin);
  sell.sort(byMin);

  return {
    buy,
    sell,
    other: { managementFee, custodianFee, salesServiceFee },
    hasTiers: buy.length > 0 || sell.length > 0,
    source: 'aktools',
    code: pickString(meta.code) || null,
    fetchedAt: Date.now()
  };
};

/**
 * fund_open_fund_info_em(indicator='分红送配详情') 整段 → 分红明细。
 *
 * 上游列：年份 / 权益登记日 / 除息日 / 每10份分红 / 分红发放日
 * 「每10份分红」是文本，如「每10份派现金0.1000元」——统一折算为**每份**金额（0.01）。
 * 无分红的基金返回 []，此时整段为空数组（不是 null），由 UI 显示「无分红记录」。
 *
 * @param {Array<object>} rows
 * @returns {Array<{ year: string|null, recordDate: string|null, exDate: string|null,
 *                   payDate: string|null, perShare: number|null, raw: string|null }>}
 */
export const mapFundDividendDetailRows = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const raw = pickString(row['每10份分红']);
      const exDate = parseChineseDate(row['除息日']);
      const recordDate = parseChineseDate(row['权益登记日']);
      const payDate = parseChineseDate(row['分红发放日']);
      let perShare = null;
      if (raw) {
        const m = raw.match(/派现金\s*([\d.]+)\s*元/);
        const per10 = m ? toFiniteNumber(m[1]) : null;
        // 上游文本就是「每10份」，折算到每份需要除以 10
        if (per10 != null) perShare = Number((per10 / 10).toFixed(6));
      }
      if (!exDate && !recordDate && perShare == null) return null;
      return {
        year: pickString(row['年份']),
        recordDate,
        exDate,
        payDate,
        perShare,
        raw
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const da = a.exDate || a.recordDate || '';
      const db = b.exDate || b.recordDate || '';
      // 最新在前
      return da < db ? 1 : da > db ? -1 : 0;
    });
};

/**
 * 解析「93/1138」这类同类排名文本。
 * @returns {{ rank: number|null, total: number|null, percentile: number|null }}
 */
const parseRankText = (raw) => {
  const s = pickString(raw);
  if (!s) return { rank: null, total: null, percentile: null };
  const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return { rank: null, total: null, percentile: null };
  const rank = toFiniteNumber(m[1]);
  const total = toFiniteNumber(m[2]);
  const percentile = rank != null && total != null && total > 0 ? Number(((rank / total) * 100).toFixed(2)) : null;
  return { rank, total, percentile };
};

/**
 * fund_individual_achievement_xq 整段 → 同业位置（区间收益 / 最大回撤 / 同类排名）。
 *
 * 上游列：业绩类型 / 周期 / 本产品区间收益 / 本产品最大回撒（上游错别字，照抄） / 周期收益同类排名
 * 归一化：percentile = rank / total × 100（越小越靠前）；仅取「年度业绩」行，其余类型保留在 rows 里备用。
 *
 * @param {Array<object>} rows
 * @returns {{ windows: Array<object>, periods: Array<string>, fetchedAt: number }}
 */
export const mapFundAchievementRows = (rows) => {
  const out = { windows: [], periods: [], source: 'aktools', fetchedAt: Date.now() };
  if (!Array.isArray(rows) || rows.length === 0) return out;

  const byPeriod = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const period = pickString(row['周期']);
    if (!period) continue;
    const rank = parseRankText(row['周期收益同类排名']);
    const item = {
      periodLabel: period,
      category: pickString(row['业绩类型']) || null,
      returnPct: toFiniteNumber(row['本产品区间收益']),
      maxDrawdown: toFiniteNumber(row['本产品最大回撒']),
      rank: rank.rank,
      total: rank.total,
      percentile: rank.percentile
    };
    // 同一周期可能有多条（不同业绩类型），保留信息量最大的那条（有排名 > 仅有收益）
    const prev = byPeriod.get(period);
    if (!prev || (prev.rank == null && item.rank != null)) byPeriod.set(period, item);
  }
  out.windows = Array.from(byPeriod.values());
  out.periods = out.windows.map((w) => w.periodLabel);
  return out;
};

/**
 * fund_individual_profit_probability_xq 整段 → 持有盈利概率。
 *
 * 上游列：持有时长（'满6个月' / '满1年'） / 盈利概率（%） / 平均收益（%）
 * @param {Array<object>} rows
 * @returns {Array<{ label: string, months: number|null, winRate: number|null, avgReturn: number|null }>}
 */
export const mapFundProfitProbabilityRows = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const toMonths = (label) => {
    const s = pickString(label);
    if (!s) return null;
    const mYear = s.match(/([\d.]+)\s*年/);
    if (mYear) {
      const n = toFiniteNumber(mYear[1]);
      return n == null ? null : Math.round(n * 12);
    }
    const mMonth = s.match(/([\d.]+)\s*个?月/);
    if (mMonth) return toFiniteNumber(mMonth[1]);
    return null;
  };
  return rows
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const label = pickString(row['持有时长']);
      if (!label) return null;
      return {
        label,
        months: toMonths(label),
        winRate: toFiniteNumber(row['盈利概率']),
        avgReturn: toFiniteNumber(row['平均收益'])
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.months == null ? 1e9 : a.months) - (b.months == null ? 1e9 : b.months));
};

/**
 * fund_portfolio_industry_allocation_em 整段 → 行业配置。
 *
 * 上游列：序号 / 行业类别 / 占净值比例 / 市值（万元） / 截止时间
 * 占净值比例是百分数数字（88.4 = 88.4%），按权重降序返回。
 *
 * @param {Array<object>} rows
 * @returns {Array<{ name: string, weight: number|null, marketValue: number|null, reportDate: string|null }>}
 */
export const mapFundIndustryRows = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const name = pickString(row['行业类别']);
      if (!name) return null;
      return {
        name,
        weight: toFiniteNumber(row['占净值比例']),
        marketValue: toFiniteNumber(row['市值']),
        reportDate: parseChineseDate(row['截止时间'])
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const wa = a.weight == null ? -1 : a.weight;
      const wb = b.weight == null ? -1 : b.weight;
      return wb - wa;
    });
};

/**
 * fund_portfolio_bond_hold_em 整段 → 债券持仓。
 *
 * 上游列：序号 / 债券代码 / 债券名称 / 占净值比例 / 持仓市值（万元） / 季度（'2026年3季度债券投资明细'）
 *
 * @param {Array<object>} rows
 * @returns {Array<{ code: string|null, name: string|null, weight: number|null,
 *                   marketValue: number|null, quarter: string|null, reportDate: string|null }>}
 */
export const mapFundBondRows = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const code = pickString(row['债券代码']);
      const name = pickString(row['债券名称']);
      if (!code && !name) return null;
      const quarter = pickString(row['季度']);
      return {
        code,
        name,
        weight: toFiniteNumber(row['占净值比例']),
        marketValue: toFiniteNumber(row['持仓市值']),
        quarter,
        reportDate: extractReportDate(quarter)
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const wa = a.weight == null ? -1 : a.weight;
      const wb = b.weight == null ? -1 : b.weight;
      return wb - wa;
    });
};

/**
 * fund_portfolio_change_em 整段 → 重大变动（累计买入 / 累计卖出）。
 *
 * 上游列：序号 / 股票代码 / 股票名称 / 本期累计买入金额（万元） / 占期初基金资产净值比例（%） / 季度
 *
 * @param {Array<object>} rows
 * @param {'buy'|'sell'} [side] - 区分列名口径（累计卖出时上游列名可能含「卖出」二字）
 * @returns {Array<{ code: string|null, name: string|null, amount: number|null,
 *                   weightOfNav: number|null, quarter: string|null, reportDate: string|null }>}
 */
export const mapFundChangeRows = (rows, side = 'buy') => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const amountKeys = side === 'sell' ? ['本期累计卖出金额', '本期累计买入金额'] : ['本期累计买入金额'];
  const weightKeys = ['占期初基金资产净值比例', '占期初基金资产净值比例(%)'];
  return rows
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const code = pickString(row['股票代码']);
      const name = pickString(row['股票名称']);
      if (!code && !name) return null;
      let amount = null;
      for (const k of amountKeys) {
        const v = toFiniteNumber(row[k]);
        if (v != null) {
          amount = v;
          break;
        }
      }
      let weightOfNav = null;
      for (const k of weightKeys) {
        const v = toFiniteNumber(row[k]);
        if (v != null) {
          weightOfNav = v;
          break;
        }
      }
      const quarter = pickString(row['季度']);
      return {
        code,
        name,
        amount,
        weightOfNav,
        quarter,
        reportDate: extractReportDate(quarter)
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aa = a.amount == null ? -1 : a.amount;
      const ab = b.amount == null ? -1 : b.amount;
      return ab - aa;
    });
};

export const __test__extended = {
  parseChineseDate,
  parseScaledAmount,
  parseFeePercent,
  toFeeParts,
  parseRankText
};
