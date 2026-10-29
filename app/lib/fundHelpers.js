import { v4 as uuidv4 } from 'uuid';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import { isArray, isFunction, isNumber, isObject, isPlainObject, isString } from 'lodash';
import {
  DEFAULT_TZ,
  TAG_THEME_OPTIONS,
  DCA_SCOPE_GLOBAL,
  SUMMARY_TAB_ID,
  SUMMARY_SOURCE_GLOBAL,
  DEFAULT_FUND_TAG_THEME
} from '@/app/constants';
import { getPrevTradingDay, countTradingDaysBetween } from './tradingCalendar';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrAfter);

export const getBrowserTimeZone = () => {
  if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || DEFAULT_TZ;
  }
  return DEFAULT_TZ;
};

export const TZ = getBrowserTimeZone();
dayjs.tz.setDefault(TZ);
export const nowInTz = () => dayjs().tz(TZ);
export const toTz = (input) => (input ? dayjs.tz(input, TZ) : nowInTz());

/**
 * 市场日期时区：**固定** Asia/Shanghai，不跟随浏览器。
 *
 * A 股的开收盘、净值日期（`jzrq`）、交易日历都按北京时间，若用浏览器时区算「今天」，
 * UTC-5~-8 的用户会在北京时间当天早上仍然拿到昨天的 `todayStr`（今日收益、当日收益记录、
 * 「净值是否已更新」全部差一天），UTC+8 以东的用户则相反。
 *
 * 展示用的本地时间仍走 `TZ`（浏览器时区），只有「哪一天」这类市场语义的日期走这里。
 */
export const MARKET_TZ = DEFAULT_TZ;
export const nowInMarketTz = () => dayjs().tz(MARKET_TZ);
/** 市场日期 YYYY-MM-DD（北京时间的「今天」；传参时按日期解析，不受时区影响） */
export const formatMarketDate = (input) => (input ? dayjs.tz(input, MARKET_TZ) : nowInMarketTz()).format('YYYY-MM-DD');
/** @deprecated 语义已是「市场日期」，请优先用 `formatMarketDate`；保留别名兼容既有调用 */
export const formatDate = (input) => formatMarketDate(input);

export { DCA_SCOPE_GLOBAL, SUMMARY_TAB_ID, SUMMARY_SOURCE_GLOBAL, DEFAULT_FUND_TAG_THEME };
export const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** 与 AddTagDialog TAG_THEME_OPTIONS 的 key 一致（单一数据源，避免漏改） */
const ALLOWED_FUND_TAG_THEMES = new Set(TAG_THEME_OPTIONS.map((o) => o.key));

export function normalizeFundTagTheme(t) {
  const s = String(t ?? '').trim();
  return ALLOWED_FUND_TAG_THEMES.has(s) ? s : DEFAULT_FUND_TAG_THEME;
}

/**
 * 单只基金已选标签实例（允许同名多枚）。
 * @returns {{ id: string, name: string, theme: string }[]}
 */
export function normalizeFundTagInstanceListFromInput(rows) {
  const out = [];
  const usedIds = new Set();
  for (const r of rows || []) {
    if (!r || !isObject(r)) continue;
    const name = String(r.name ?? '').trim();
    if (!name || name.length > 24) continue;
    let id = String(r.id ?? '').trim();
    if (!id || usedIds.has(id)) id = uuidv4();
    usedIds.add(id);
    out.push({
      id,
      name,
      theme: normalizeFundTagTheme(r.theme)
    });
    if (out.length >= 30) break;
  }
  return out;
}

/** 从基金对象中移除旧版内联字段 `tags`（已迁移到独立 `tags` 存储） */
export function stripLegacyTagsFromFundObject(f) {
  if (!f || !isObject(f) || !hasOwn(f, 'tags')) return f;
  const { tags: _removed, ...rest } = f;
  return rest;
}

/** 从标签记录读取基金代码列表（仅 `fundCodes`） */
export function getFundCodesFromTagRecord(r) {
  if (!r || !isObject(r) || !isArray(r.fundCodes)) return [];
  return [...new Set(r.fundCodes.map((c) => String(c).trim()).filter(Boolean))];
}

/** 仅保留 id / name / theme / fundCodes（fundCodes 可为空：仅存在于可选池、尚未挂到任何基金） */
export function sanitizeTagRowForStorage(r) {
  if (!r || !isObject(r)) return null;
  const name = String(r.name ?? '').trim();
  const codes = getFundCodesFromTagRecord(r);
  if (!name) return null;
  return {
    id: String(r.id ?? '').trim() || uuidv4(),
    name,
    theme: String(r.theme ?? '').trim() || DEFAULT_FUND_TAG_THEME,
    fundCodes: codes.sort()
  };
}

/** 用于判断标签列表是否实质变化（避免无意义的 setItem） */
export function serializeTagRecordsForCompare(rows) {
  return JSON.stringify(
    [...(rows || [])]
      .map((r) => ({
        id: String(r?.id ?? ''),
        name: String(r?.name ?? '').trim(),
        theme: String(r?.theme ?? '').trim(),
        fundCodes: getFundCodesFromTagRecord(r).slice().sort()
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  );
}

/** 同名标签合并为一条，基金代码取并集（用于迁移与保存去重） */
export function mergeTagRowsByName(rows) {
  const byName = new Map();
  for (const row of rows || []) {
    if (!row || !isObject(row)) continue;
    const nm = String(row.name ?? '').trim();
    if (!nm) continue;
    const codes = getFundCodesFromTagRecord(row);
    const ex = byName.get(nm);
    if (ex) {
      ex.fundCodes = [...new Set([...ex.fundCodes, ...codes])].sort();
    } else {
      byName.set(nm, {
        id: String(row.id ?? '').trim(),
        name: nm,
        theme: String(row.theme ?? '').trim() || DEFAULT_FUND_TAG_THEME,
        fundCodes: [...codes].sort()
      });
    }
  }
  return Array.from(byName.values());
}

export function cloneHoldingDeep(src) {
  if (!isPlainObject(src)) return null;
  try {
    return isFunction(structuredClone) ? structuredClone(src) : JSON.parse(JSON.stringify(src));
  } catch {
    return { ...src };
  }
}

/** 规范化单条持仓（与 collectLocalPayload 清洗逻辑对齐） */
export function normalizeHoldingEntryForSeed(value) {
  if (!isPlainObject(value)) return null;
  const parsedShare = isNumber(value.share) ? value.share : isString(value.share) ? Number(value.share) : NaN;
  const parsedCost = isNumber(value.cost) ? value.cost : isString(value.cost) ? Number(value.cost) : NaN;
  const nextShare = Number.isFinite(parsedShare) ? parsedShare : null;
  const nextCost = Number.isFinite(parsedCost) ? parsedCost : null;
  if (nextShare === null && nextCost === null) return null;
  return { ...value, share: nextShare, cost: nextCost };
}

/** 旧版扁平 dcaPlans（code -> plan）→ { __global__: { ... } } */
export function migrateDcaPlansToScoped(raw) {
  if (!isPlainObject(raw)) return { [DCA_SCOPE_GLOBAL]: {} };
  if (raw[DCA_SCOPE_GLOBAL] !== undefined && isPlainObject(raw[DCA_SCOPE_GLOBAL])) {
    return raw;
  }
  return { [DCA_SCOPE_GLOBAL]: { ...raw } };
}

/**
 * 判断基金净值是否"已更新"（结合确认天数与真实交易日历）。
 *
 * - confirmDays <= 1（普通 A 股基金）：净值日期 >= 今天或之前最近的交易日
 *   即视为已更新。例如周六查看周五净值 → 已更新；国庆长假查看节前净值 → 已更新。
 * - confirmDays >= 2（QDII 等跨境基金）：净值日期与今天之间相隔的交易日数
 *   < confirmDays 即视为已更新。使用交易日而非自然日，精确覆盖周末与长假。
 *
 * @param {string} jzrq - 基金净值日期，格式 YYYY-MM-DD
 * @param {string} todayStr - 今天日期，格式 YYYY-MM-DD
 * @param {number} [confirmDays=1] - 申赎确认天数（SSBCFMDATA）
 * @returns {boolean}
 */
export function isNavUpdated(jzrq, todayStr, confirmDays) {
  if (!isString(jzrq) || !jzrq) return false;
  if (jzrq === todayStr) return true;

  const days = Number(confirmDays) || 1;

  if (days <= 1) {
    // A 股基金：净值日期 >= 上一个最近交易日即为已更新
    const prevTD = getPrevTradingDay(toTz(todayStr));
    if (!prevTD) return false;
    return toTz(jzrq).startOf('day').isSameOrAfter(prevTD, 'day');
  }

  // QDII 等延迟基金：净值日期与今天之间的交易日数 < confirmDays
  const tradingDays = countTradingDaysBetween(jzrq, todayStr, toTz);
  return tradingDays >= 0 && tradingDays < days;
}
