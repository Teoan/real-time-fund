import lodash from 'lodash';

/**
 * 自选池横向分位（相对分位）。
 *
 * 绝对分位只回答「这只基金的估值在它自己近 5 年历史里的位置」。问题是：
 * 全市场都在高位时，每只基金都会显示「高估」，用户无从选择；反过来全市场低迷时，
 * 每只基金都是「低估」，同样没有区分度。
 *
 * 这里用**已经算出来的**逐持仓分位（`buildDailyMetrics` 的 `perStockPercents`）
 * 做一个横截面基准：把所有基金看过的个股分位汇成一个池子，取其 PE 分位中位数
 * 作为「当前市场的普遍水位」，再用基金自己的加权分位减去它：
 *
 *   relativePercentile = 基金 PE 分位 − 池内中位 PE 分位
 *
 * 负值 = 比自选池里的普遍标的更便宜（相对低估），正值 = 更贵。
 * 不需要任何新接口，只需要把每次算分位的结果落一份到本地。
 *
 * 存储结构（localStorage: valuationPeerPool）：
 *   { [fundCode]: { updatedAt: '2026-03-21', stocks: [{code, pe, pb, ps}] } }
 */

export const PEER_POOL_KEY = 'valuationPeerPool';
/** 池内最多保留的基金数（超出后按 updatedAt 淘汰最旧） */
export const PEER_POOL_MAX_FUNDS = 200;
/** 超过这个天数的条目不再参与中位数计算（持仓早已换血） */
export const PEER_POOL_MAX_AGE_DAYS = 45;

/**
 * 中位数（偶数个时取中间两个的平均）。
 *
 * @param {number[]} values
 * @returns {number|null}
 */
export const medianOf = (values) => {
  const clean = (lodash.isArray(values) ? values : [])
    .filter((v) => lodash.isNumber(v) && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = clean.length >> 1;
  return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
};

/**
 * 相对分位 = 基金分位 − 池内中位。四舍五入到 0.1（分位本身是 0-100 的量纲）。
 *
 * @param {number|null} fundPercentile
 * @param {number|null} peerMedian
 * @returns {number|null}
 */
export const computeRelativePercentile = (fundPercentile, peerMedian) => {
  if (!lodash.isNumber(fundPercentile) || !lodash.isNumber(peerMedian)) return null;
  if (!Number.isFinite(fundPercentile) || !Number.isFinite(peerMedian)) return null;
  return Math.round((fundPercentile - peerMedian) * 10) / 10;
};

/**
 * 绑定存储的池子控制器。
 *
 * @param {{getItem: Function, setItem: Function, key?: string, now?: () => number}} deps
 */
export const createPeerPool = ({ getItem, setItem, key = PEER_POOL_KEY, now = () => Date.now() }) => {
  const read = () => {
    const raw = getItem(key, {});
    return lodash.isObject(raw) && !lodash.isArray(raw) ? raw : {};
  };

  const fresh = (entry) => {
    if (!entry?.updatedAt) return false;
    const ts = new Date(entry.updatedAt).getTime();
    if (!Number.isFinite(ts)) return false;
    return now() - ts <= PEER_POOL_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  };

  const prune = (pool) => {
    const entries = Object.entries(pool).filter(([, v]) => fresh(v));
    if (entries.length <= PEER_POOL_MAX_FUNDS) return Object.fromEntries(entries);
    // 超出上限：保留最新的 N 个
    entries.sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)));
    return Object.fromEntries(entries.slice(0, PEER_POOL_MAX_FUNDS));
  };

  return {
    /**
     * 记录一只基金本次看到的逐持仓分位。
     *
     * @param {{code: string, perStockPercents: Array<{code: string, pe?: number|null,
     *   pb?: number|null, ps?: number|null}>, updatedAt?: string}} params
     */
    record: ({ code, perStockPercents, updatedAt }) => {
      if (!code || !lodash.isArray(perStockPercents) || perStockPercents.length === 0) return;
      const pool = read();
      pool[code] = {
        updatedAt: updatedAt || new Date(now()).toISOString().slice(0, 10),
        stocks: perStockPercents
          .filter((s) => s && s.code)
          .map((s) => ({
            code: s.code,
            pe: lodash.isNumber(s.pe) ? s.pe : null,
            pb: lodash.isNumber(s.pb) ? s.pb : null,
            ps: lodash.isNumber(s.ps) ? s.ps : null
          }))
      };
      setItem(key, prune(pool));
    },

    /** 池内所有个股某指标分位的中位数（即「市场普遍水位」） */
    getPeerMedian: (metricKey = 'pe') => {
      const pool = prune(read());
      const values = [];
      for (const entry of Object.values(pool)) {
        for (const stock of lodash.isArray(entry?.stocks) ? entry.stocks : []) {
          const v = stock?.[metricKey];
          if (lodash.isNumber(v) && Number.isFinite(v)) values.push(v);
        }
      }
      return medianOf(values);
    },

    /** 参与统计的基金数 / 个股数（用于 UI 说明「基准由 N 只基金的 M 只个股构成」） */
    getPoolStats: () => {
      const pool = prune(read());
      const funds = Object.keys(pool).length;
      let stocks = 0;
      for (const entry of Object.values(pool)) {
        for (const stock of lodash.isArray(entry?.stocks) ? entry.stocks : []) {
          if (lodash.isNumber(stock?.pe)) stocks += 1;
        }
      }
      return { funds, stocks };
    },

    reset: () => setItem(key, {})
  };
};

/** storageStore 的延迟引用（与 valuationAccuracy 同理：纯函数单测不该加载 zustand） */
let storageStoreRef = null;

export const bindPeerPoolStorage = (store) => {
  if (store && lodash.isFunction(store.getItem) && lodash.isFunction(store.setItem)) {
    storageStoreRef = store;
  }
};

/** 默认实例 */
export const valuationPeerPool = createPeerPool({
  getItem: (k, d) => (storageStoreRef ? storageStoreRef.getItem(k, d) : d),
  setItem: (k, v) => {
    if (storageStoreRef) storageStoreRef.setItem(k, v);
  }
});
