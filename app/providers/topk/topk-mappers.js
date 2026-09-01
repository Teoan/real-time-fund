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

export const __test__ = { toFiniteNumber, toIsoDate, pickString, extractReportDate };
