/**
 * TopK (AKShare) → 项目内部 Domain Model 字段映射器
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

export const __test__ = { toFiniteNumber, toIsoDate, pickString, extractReportDate, parseAkShareTimestamp };
