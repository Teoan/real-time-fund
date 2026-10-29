/**
 * 每日收益数据管理（按作用域分桶）：
 * {
 *   [scope]: {
 *     [code]: Array<{ date: string, earnings: number, rate?: number|null, baseCostAmount?: number|null }>
 *   }
 * }
 * - scope: 'all'（全局）或自定义分组 id
 * - date: YYYY-MM-DD
 * - earnings: 当日收益（元）
 * - rate: 当日收益率（百分比数值，如 1.23 表示 +1.23%），基于用户成本价计算，即 (当日收益 / 成本金额) × 100
 * - baseCostAmount: 当日成本快照金额（元），用于冻结当日收益率分母
 */
import { isArray, isNumber, isObject, isPlainObject, isString } from 'lodash';
import { storageStore } from '@/app/stores';
import { DAILY_EARNINGS_SCOPE_ALL } from '@/app/constants';
import { calculateYtdReturnRate, normalizeEarningsItem } from './ytdReturn.js';

// YTD 计算已抽到 ./ytdReturn.js（纯函数，可被 node --test 直接加载），这里保持原有导出路径不变
export { calculateYtdReturnRate };

const STORAGE_KEY = 'fundDailyEarnings';

function getStored() {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = storageStore.getItem(STORAGE_KEY);
    if (!isPlainObject(parsed)) return {};
    // 兼容旧格式：{ [code]: list } -> { all: { [code]: list } }
    const hasScopeBucket = Object.values(parsed).some((v) => isPlainObject(v));
    if (!hasScopeBucket) {
      return { [DAILY_EARNINGS_SCOPE_ALL]: parsed };
    }
    return parsed;
  } catch {
    return {};
  }
}

function setStored(data) {
  if (typeof window === 'undefined') return;
  try {
    storageStore.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('dailyEarnings persist failed', e);
  }
}

export function recordDailyEarnings(code, earnings, dateStr) {
  if (!isString(code) || !code) return getDailyEarnings(code);
  if (!isNumber(earnings) || !Number.isFinite(earnings)) return getDailyEarnings(code);
  if (!isString(dateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return getDailyEarnings(code);

  // 兼容老调用：recordDailyEarnings(code, earnings, dateStr, rate)
  const rate = arguments.length >= 4 ? arguments[3] : null;
  const scope =
    arguments.length >= 5 && isString(arguments[4]) && arguments[4] ? arguments[4] : DAILY_EARNINGS_SCOPE_ALL;
  const normalizedRate = isNumber(rate) && Number.isFinite(rate) ? rate : null;

  const all = getStored();
  const scoped = isPlainObject(all[scope]) ? all[scope] : {};
  const list = isArray(scoped[code]) ? scoped[code] : [];
  const existingIndex = list.findIndex((item) => item.date === dateStr);

  const baseCostAmount =
    arguments.length >= 6 && isNumber(arguments[5]) && Number.isFinite(arguments[5]) && arguments[5] > 0
      ? arguments[5]
      : null;

  const nextList =
    existingIndex >= 0
      ? list.map((item, i) =>
          i === existingIndex ? { date: dateStr, earnings, rate: normalizedRate, baseCostAmount } : item
        )
      : [...list, { date: dateStr, earnings, rate: normalizedRate, baseCostAmount }];

  nextList.sort((a, b) => a.date.localeCompare(b.date));

  all[scope] = { ...scoped, [code]: nextList };
  setStored(all);
  return nextList.map(normalizeEarningsItem).filter(Boolean);
}

export function getDailyEarnings(code, scope = DAILY_EARNINGS_SCOPE_ALL) {
  const all = getStored();
  const scoped = isPlainObject(all[scope]) ? all[scope] : {};
  const list = isArray(scoped[code]) ? scoped[code] : [];
  return list.map(normalizeEarningsItem).filter(Boolean);
}

export function clearDailyEarnings(code, scope = null) {
  const all = getStored();
  let changed = false;
  const next = { ...all };
  if (scope && isPlainObject(next[scope]) && code in next[scope]) {
    const bucket = { ...next[scope] };
    delete bucket[code];
    next[scope] = bucket;
    changed = true;
  } else if (!scope) {
    Object.keys(next).forEach((sc) => {
      if (!isPlainObject(next[sc])) return;
      if (!(code in next[sc])) return;
      const bucket = { ...next[sc] };
      delete bucket[code];
      next[sc] = bucket;
      changed = true;
    });
  }
  if (!changed) return;
  setStored(next);
}

export function getAllDailyEarnings(scope = DAILY_EARNINGS_SCOPE_ALL) {
  const all = getStored();
  const scoped = all[scope];
  return isPlainObject(scoped) ? scoped : {};
}

export function getAllDailyEarningsScoped() {
  return getStored();
}

export function setAllDailyEarningsScoped(scopedMap) {
  const next = isPlainObject(scopedMap) ? scopedMap : {};
  setStored(next);
}

/**
 * 合并所有 scope 的收益数据（累加同日收益，同一基金在不同 scope 独立持有）
 * @param {Object} scopedDaily - { [scope]: { [code]: Array<{date, earnings, ...}> } }
 * @returns {Object} - { [code]: Array<{date, earnings, ...}> }
 */
export function mergeAllScopedDailyEarnings(scopedDaily) {
  const merged = {};
  if (!isPlainObject(scopedDaily)) return merged;
  Object.values(scopedDaily).forEach((bucket) => {
    if (!isPlainObject(bucket)) return;
    Object.entries(bucket).forEach(([code, list]) => {
      if (!isArray(list)) return;
      if (!merged[code]) {
        merged[code] = new Map();
      }
      const dateMap = merged[code];
      list.forEach((item) => {
        if (!item?.date) return;
        const existing = dateMap.get(item.date);
        if (existing) {
          // 累加 earnings 和 baseCostAmount
          dateMap.set(item.date, {
            ...existing,
            earnings: (existing.earnings || 0) + (item.earnings || 0),
            baseCostAmount: (existing.baseCostAmount || 0) + (item.baseCostAmount || 0),
            rate: null // 合并不同分组的收益后，重置 rate 为 null 促使消费端重算
          });
        } else {
          dateMap.set(item.date, { ...item });
        }
      });
    });
  });
  // 将 Map 转换回数组
  const result = {};
  Object.entries(merged).forEach(([code, dateMap]) => {
    result[code] = Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  });
  return result;
}

/**
 * 合并全局 holdings 和分组 holdings（累加持仓，计算加权平均成本）
 * @param {Object} globalHoldings - 全局 holdings
 * @param {Object} groupHoldings - 分组 holdings
 * @returns {Object} - 合并后的 holdings
 */
export function mergeAllHoldings(globalHoldings, groupHoldings) {
  const merged = {};
  // 合并全局 holdings
  if (isPlainObject(globalHoldings)) {
    Object.entries(globalHoldings).forEach(([code, holding]) => {
      if (isPlainObject(holding) && isNumber(holding.share) && holding.share > 0) {
        merged[code] = { ...holding };
      }
    });
  }
  // 累加分组 holdings
  if (isPlainObject(groupHoldings)) {
    Object.values(groupHoldings).forEach((group) => {
      if (!isPlainObject(group)) return;
      Object.entries(group).forEach(([code, holding]) => {
        if (!isPlainObject(holding) || !isNumber(holding.share) || holding.share <= 0) return;
        if (merged[code]) {
          // 计算加权平均成本
          const existingTotalCost = (merged[code].share || 0) * (merged[code].cost || 0);
          const newTotalCost = holding.share * (holding.cost || 0);
          const totalShare = (merged[code].share || 0) + holding.share;
          merged[code] = {
            ...merged[code],
            share: totalShare,
            cost: totalShare > 0 ? (existingTotalCost + newTotalCost) / totalShare : 0
          };
        } else {
          merged[code] = { ...holding };
        }
      });
    });
  }
  return merged;
}

/**
 * 将多基金的每日收益按日期合并为组合序列（同日 earnings 求和；组合层面 rate 无统一定义，置为 null）。
 * @param {Record<string, unknown>} fundDailyEarningsMap - 与 localStorage 结构一致：{ [code]: Array<{date, earnings, rate?}> }
 * @returns {Array<{ date: string, earnings: number, rate: null }>}
 */
export function aggregatePortfolioDailyEarnings(fundDailyEarningsMap) {
  if (!isPlainObject(fundDailyEarningsMap)) return [];
  const byDate = new Map();
  for (const code of Object.keys(fundDailyEarningsMap)) {
    const list = fundDailyEarningsMap[code];
    if (!isArray(list)) continue;
    for (const raw of list) {
      const item = normalizeEarningsItem(raw);
      if (!item) continue;
      byDate.set(item.date, (byDate.get(item.date) ?? 0) + item.earnings);
    }
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, earnings]) => ({ date, earnings, rate: null }));
}
