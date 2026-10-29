/**
 * YTD（今年以来）收益率的纯计算模块。
 *
 * 单独成文件的原因：需要被 `node --test` 直接加载，因此不能依赖 `@/...` 路径别名，
 * 也不能间接引入 storageStore / TanStack 等浏览器侧依赖（dailyEarnings.js 里带着这些）。
 *
 * 口径约定（重要）：
 *   某一交易日的收益率 = 「当日有成本口径的基金」的收益之和 ÷ 同一批基金的成本之和。
 *   分子与分母必须是**同一批基金**：旧实现把当天所有基金的收益都算进分子，而分母只累加
 *   带 baseCostAmount 的记录，缺成本快照的老记录只进分子 → 收益率被放大（缺一半成本约 2 倍）。
 *
 * 不再使用「当前持仓总成本」兜底：那属于 look-ahead（今天加仓会改写过去每一天的分母），
 * 会把历史 YTD 拉向 0，因此该降级路径已删除。
 */
// 与 valuationHistory.js 一致：lodash 是 CJS 包，Node 的 ESM 加载器无法解析命名导出。
import lodash from 'lodash';

const { isArray, isNumber, isObject, isPlainObject, isString } = lodash;

/**
 * 归一化单条每日收益记录，非法日期/收益返回 null。
 * @param {unknown} item
 * @returns {{date: string, earnings: number, rate: number|null, baseCostAmount: number|null}|null}
 */
export function normalizeEarningsItem(item) {
  if (!item || !isObject(item)) return null;
  const date = item.date;
  const earnings = item.earnings;
  const rate = item.rate;
  const baseCostAmount = item.baseCostAmount;
  if (!isString(date) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!isNumber(earnings) || !Number.isFinite(earnings)) return null;
  const normalizedRate = isNumber(rate) && Number.isFinite(rate) ? rate : null;
  const normalizedBaseCostAmount =
    isNumber(baseCostAmount) && Number.isFinite(baseCostAmount) && baseCostAmount > 0 ? baseCostAmount : null;
  return { date, earnings, rate: normalizedRate, baseCostAmount: normalizedBaseCostAmount };
}

/**
 * 取单条记录对应的当日成本口径。
 * 优先用当日快照成本；没有快照时用同一条记录自身的收益/收益率反推。
 * @param {{earnings: number, rate: number|null, baseCostAmount: number|null}} item 已归一化的记录
 * @returns {number} 大于 0 的成本；取不到返回 0
 */
export function resolveEarningsItemCost(item) {
  if (!isObject(item)) return 0;
  if (isNumber(item.baseCostAmount) && Number.isFinite(item.baseCostAmount) && item.baseCostAmount > 0) {
    return item.baseCostAmount;
  }
  if (isNumber(item.rate) && Number.isFinite(item.rate) && item.rate !== 0 && isNumber(item.earnings)) {
    const impliedCost = item.earnings / (item.rate / 100);
    if (Number.isFinite(impliedCost) && impliedCost > 0) return impliedCost;
  }
  return 0;
}

/**
 * 估算 YTD (今年以来) 收益率。采用每日收益率累乘法（时间加权收益率近似）。
 *
 * @param {Record<string, Array<{date: string, earnings: number, baseCostAmount?: number|null, rate?: number|null}>>} fundDailyEarningsMap
 *   已合并所有 scope 的收益记录 { [code]: list }
 * @param {{currentYear?: number}} [options] currentYear 仅用于测试固定年份
 * @returns {number|null} YTD 收益率百分比，如 1.23 表示 +1.23%。无有效数据返回 null。
 */
export function calculateYtdReturnRate(fundDailyEarningsMap, options = {}) {
  if (!isPlainObject(fundDailyEarningsMap)) return null;

  const currentYear = isNumber(options.currentYear) ? options.currentYear : new Date().getFullYear();
  const yearStartStr = `${currentYear}-01-01`;

  // 先按 (date, code) 去重（同日同基金以最后一条为准，与存储层 upsert 语义一致），
  // 再按日期汇总：同一天的收益与成本始终来自同一批基金。
  const byDateCode = new Map();

  for (const code of Object.keys(fundDailyEarningsMap)) {
    const list = fundDailyEarningsMap[code];
    if (!isArray(list)) continue;
    for (const raw of list) {
      const item = normalizeEarningsItem(raw);
      if (!item) continue;
      if (item.date < yearStartStr) continue;
      if (`${currentYear + 1}-01-01` <= item.date) continue;

      // 先确定当天的成本口径，取不到就整条跳过（分子分母都不计）
      const cost = resolveEarningsItemCost(item);
      if (!(cost > 0)) continue;

      const perCode = byDateCode.get(item.date) || new Map();
      perCode.set(code, { earnings: item.earnings, cost });
      byDateCode.set(item.date, perCode);
    }
  }

  const dailyStats = new Map();
  for (const [date, perCode] of byDateCode.entries()) {
    const stat = { earnings: 0, cost: 0 };
    for (const v of perCode.values()) {
      stat.earnings += v.earnings;
      stat.cost += v.cost;
    }
    if (stat.cost > 0) dailyStats.set(date, stat);
  }

  if (dailyStats.size === 0) return null;

  // 按日期排序并累乘每日收益率
  const sortedDates = [...dailyStats.keys()].sort();
  let compounded = 1;

  for (const date of sortedDates) {
    const stat = dailyStats.get(date);
    if (stat.cost > 0) {
      compounded *= 1 + stat.earnings / stat.cost;
    }
  }

  return Number(((compounded - 1) * 100).toFixed(2));
}
