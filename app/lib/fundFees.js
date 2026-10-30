/**
 * 基金申赎费率的纯计算模块。
 *
 * 输入是 app/providers/aktools/aktools-mappers.js 里 mapFundFeeTiers 的产物：
 *
 *   { buy:  [{ min, minInclusive, max, maxInclusive, unit:'amount', rate, fixedFee, label }...],
 *     sell: [{ min, minInclusive, max, maxInclusive, unit:'days',   rate, fixedFee, label }...],
 *     other: { managementFee, custodianFee, salesServiceFee },
 *     hasTiers: boolean }
 *
 * 约定：
 *   - 金额单位统一为**元**，持有期单位统一为**天**（上游已归一化）；
 *   - rate 为百分数（1.5 表示 1.5%），fixedFee 为每笔固定金额（元），两者互斥；
 *   - 任一档位缺失时返回 null，由调用方决定「按未知处理」还是「按 0 处理」，
 *     本模块不擅自把「不知道」当成「免费」。
 *
 * 这里刻意不依赖 React / DOM / TanStack，可被 node --test 直接覆盖。
 */

// lodash 是 CJS 包，Node 的 ESM 加载器解析不了命名导出，
// 用「默认导入 + 解构」才能让本模块被 node --test 直接加载（同 app/lib/fundMetrics.js）。
import lodash from 'lodash';

const { isArray, isNil, isNumber, isObject } = lodash;

/** 数值兜底：非有限数一律 null，避免 NaN 一路传染到 UI */
const toFinite = (v) => (isNumber(v) && Number.isFinite(v) ? v : null);

/**
 * 判断某个数值是否落在该档位区间内。
 *
 * 区间语义（与上游条件文本一一对应）：
 *   '0.0万<买入金额<100.0万'    → 下界开、上界开
 *   '100.0万<=买入金额<500.0万' → 下界闭、上界开
 *   '1000.0万<=买入金额'        → 只有下界（max = null 表示无上界）
 *
 * @param {object} tier
 * @param {number} value
 * @returns {boolean}
 */
export const isValueInTier = (tier, value) => {
  if (!isObject(tier)) return false;
  const v = toFinite(value);
  if (isNil(v)) return false;
  const min = toFinite(tier.min);
  const max = toFinite(tier.max);
  if (!isNil(min)) {
    if (tier.minInclusive ? v < min : v <= min) return false;
  }
  if (!isNil(max)) {
    if (tier.maxInclusive ? v > max : v >= max) return false;
  }
  return true;
};

/**
 * 从阶梯里挑出适用于给定数值的档位。
 *
 * 优先按区间匹配；全部不匹配时（上游数据有缺口，如金额恰为 0 或超过最高档下界缺失），
 * 退化为「按 min 排序后取第一个 >= value 的档位」，仍找不到则取最后一档。
 * 这个兜底很重要：真实接口里最高档常写成 `1000.0万<=买入金额`，
 * 若用户输入恰好落在未覆盖的缝隙，UI 不应显示「未知费率」。
 *
 * @param {Array<object>} tiers
 * @param {number} value
 * @returns {object|null}
 */
export const pickFeeTier = (tiers, value) => {
  if (!isArray(tiers) || tiers.length === 0) return null;
  const sorted = [...tiers].filter(isObject).sort((a, b) => {
    const ma = toFinite(a.min);
    const mb = toFinite(b.min);
    return (isNil(ma) ? -Infinity : ma) - (isNil(mb) ? -Infinity : mb);
  });
  if (sorted.length === 0) return null;
  const exact = sorted.find((tier) => isValueInTier(tier, value));
  if (exact) return exact;
  const v = toFinite(value);
  if (isNil(v)) return null;
  const next = sorted.find((tier) => {
    const max = toFinite(tier.max);
    return !isNil(max) && v < max;
  });
  return next || sorted[sorted.length - 1];
};

/**
 * 计算某一档费率对应的费用金额。
 *
 * - 固定费用档（上游 `1000.0万<=买入金额` + 费用 1000）→ 直接返回 1000 元；
 * - 比例档 → 金额 × 费率 / 100（费率是百分数）。
 *
 * @param {object|null} tier
 * @param {number} amount - 申赎金额（元）
 * @returns {number|null} 费用（元）；无法计算时 null
 */
export const calcTierFee = (tier, amount) => {
  if (!isObject(tier)) return null;
  const fixed = toFinite(tier.fixedFee);
  if (!isNil(fixed)) return fixed;
  const rate = toFinite(tier.rate);
  const base = toFinite(amount);
  if (isNil(rate) || isNil(base)) return null;
  return (base * rate) / 100;
};

/**
 * 申购费用与费率（金额档）。
 *
 * @param {object|null} feeTiers - mapFundFeeTiers 的产物
 * @param {number} amount - 申购金额（元）
 * @returns {{ rate: number|null, fixedFee: number|null, fee: number|null, tier: object|null }}
 */
export const getSubscriptionFee = (feeTiers, amount) => {
  const tier = pickFeeTier(feeTiers?.buy, amount);
  if (!tier) return { rate: null, fixedFee: null, fee: null, tier: null };
  return {
    rate: toFinite(tier.rate),
    fixedFee: toFinite(tier.fixedFee),
    fee: calcTierFee(tier, amount),
    tier
  };
};

/**
 * 赎回费用与费率（持有天数档）。
 *
 * @param {object|null} feeTiers - mapFundFeeTiers 的产物
 * @param {number} amount - 赎回金额（元）
 * @param {number} holdingDays - 持有天数（自然日）
 * @returns {{ rate: number|null, fixedFee: number|null, fee: number|null, tier: object|null }}
 */
export const getRedemptionFee = (feeTiers, amount, holdingDays) => {
  const tier = pickFeeTier(feeTiers?.sell, holdingDays);
  if (!tier) return { rate: null, fixedFee: null, fee: null, tier: null };
  return {
    rate: toFinite(tier.rate),
    fixedFee: toFinite(tier.fixedFee),
    fee: calcTierFee(tier, amount),
    tier
  };
};

/**
 * 计算持有天数（自然日，含买入当天不计、卖出当天计的常见基金口径）。
 *
 * 口径说明：基金公司通常按「持有期 = 赎回申请日 − 申购确认日」的自然日差计算，
 * 不满 7 天收取 1.5% 惩罚性赎回费是行业惯例，因此差额本身即为持有天数。
 *
 * @param {string|Date} buyDate - 买入（确认）日
 * @param {string|Date} sellDate - 卖出日，缺省为今天
 * @returns {number|null}
 */
export const calcHoldingDays = (buyDate, sellDate) => {
  const start = buyDate instanceof Date ? buyDate : new Date(String(buyDate || ''));
  const end = sellDate instanceof Date ? sellDate : new Date(String(sellDate || ''));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(0, Math.round((endDay - startDay) / 86400000));
};

/**
 * 费率/费用展示文本。
 *
 * @param {number|null} rate - 百分数
 * @param {number|null} fixedFee - 每笔固定金额（元）
 * @param {number} [digits]
 * @returns {string} 如 '1.50%' / '1000 元/笔' / '—'
 */
export const formatFeeRate = (rate, fixedFee = null, digits = 2) => {
  const fixed = toFinite(fixedFee);
  if (!isNil(fixed)) return `${fixed} 元/笔`;
  const r = toFinite(rate);
  if (isNil(r)) return '—';
  return `${r.toFixed(digits)}%`;
};

/**
 * 费用金额展示文本（保留两位小数，四舍五入到分）。
 * @param {number|null} fee
 * @returns {string}
 */
export const formatFeeAmount = (fee) => {
  const v = toFinite(fee);
  if (isNil(v)) return '—';
  return `¥${v.toFixed(2)}`;
};

/**
 * 把阶梯整理成 UI 可直接渲染的表格行（含区间标签与费率文本）。
 *
 * @param {Array<object>} tiers
 * @param {'amount'|'days'} [unit]
 * @returns {Array<{ label: string, rangeText: string, rateText: string, tier: object }>}
 */
export const buildFeeTierRows = (tiers, unit = 'amount') => {
  if (!isArray(tiers)) return [];
  return tiers.filter(isObject).map((tier) => {
    const min = toFinite(tier.min);
    const max = toFinite(tier.max);
    const isDays = (tier.unit || unit) === 'days';
    const fmt = (v) => {
      if (isDays) return `${v} 天`;
      if (v >= 10000) return `${Number((v / 10000).toFixed(4))} 万`;
      return `${v} 元`;
    };
    let rangeText = '—';
    if (!isNil(min) && !isNil(max)) {
      rangeText = isDays
        ? `${fmt(min)}（${tier.minInclusive ? '含' : '不含'}）~ ${fmt(max)}`
        : `${fmt(min)}（${tier.minInclusive ? '含' : '不含'}）~ ${fmt(max)}`;
    } else if (!isNil(min)) {
      rangeText = `≥ ${fmt(min)}`;
    } else if (!isNil(max)) {
      rangeText = `< ${fmt(max)}`;
    }
    return {
      label: tier.label || rangeText,
      rangeText,
      rateText: formatFeeRate(tier.rate, tier.fixedFee),
      tier
    };
  });
};
