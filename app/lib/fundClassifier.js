/**
 * 基金分类器
 *
 * 将基金按投资方向分为 14 种类型，每种类型对应不同的估值指标和权重。
 * 分类依据（优先级从高到低）：
 *   1. Supabase fund_related 表的 related_sector（关联板块，人工维护）
 *   2. 基金名称中的板块关键词（零额外请求，命中率最高）
 *   3. fund_individual_basic_info_xq 返回的基金类型兜底
 *
 * 分类结果用于 valuationRules.js 查询对应的估值规则。
 */

/**
 * 基金分类枚举
 */
export const FUND_CATEGORIES = {
  BROAD_INDEX: 'broad_index', // 宽基指数
  DIVIDEND: 'dividend', // 高股息/红利
  GROWTH: 'growth', // 成长型
  TECH: 'tech', // 科技/AI/软件
  PHARMA: 'pharma', // 医药
  CONSUMER: 'consumer', // 消费
  FINANCE: 'finance', // 金融（银行/券商/保险）
  CYCLICAL: 'cyclical', // 周期（有色/钢铁/煤炭/化工）
  NEW_ENERGY: 'new_energy', // 新能源
  MILITARY: 'military', // 军工
  REAL_ESTATE: 'real_estate', // 地产
  REITS: 'reits', // REITs
  SECTOR_INDEX: 'sector_index', // 行业指数（非宽基）
  QDII: 'qdii', // QDII
  US_STOCK: 'us_stock', // 美股（含美股 QDII）
  BOND: 'bond', // 债券
  OTHER: 'other' // 其他
};

/**
 * 分类关键词映射
 * 顺序重要：越靠前的规则优先级越高
 *
 * exclude：命中该模式时本条规则跳过。用于避免「美国债券(QDII)」这类
 * 名称含地域关键词、但资产类别完全不同的产品落进股票型规则。
 */
const SECTOR_RULES = [
  {
    pattern: /沪深300|中证500|中证800|中证1000|上证50|创业板指|科创50|中证A100|中证A500/,
    category: FUND_CATEGORIES.BROAD_INDEX
  },
  // 美股：两个刻意的收窄，避免 A 股/港股产品被误判
  //   - 不写裸「标普」：「标普中国A股红利」「标普港股通低波红利」均为非美股
  //   - 「道琼斯」排除 88：「银华-道琼斯88指数」跟踪的是道琼斯中国88指数（A 股）
  {
    pattern: /纳斯达克|标普500|标普100|美股|美国|道琼斯(?!.*88)/,
    exclude: /债券|纯债|信用债|利率债|国债|货币/,
    category: FUND_CATEGORIES.US_STOCK
  },
  { pattern: /红利|高股息|股息/, category: FUND_CATEGORIES.DIVIDEND },
  { pattern: /科技|半导体|芯片|人工智能|AI|软件|计算机|电子|通信|TMT|信息/, category: FUND_CATEGORIES.TECH },
  { pattern: /医药|医疗|创新药|生物|疫苗|CXO|医疗器械/, category: FUND_CATEGORIES.PHARMA },
  { pattern: /消费|白酒|食品|家电|零售|必需消费|可选消费/, category: FUND_CATEGORIES.CONSUMER },
  { pattern: /银行|证券|保险|金融|非银/, category: FUND_CATEGORIES.FINANCE },
  { pattern: /新能源|光伏|锂电|储能|风电|碳中和/, category: FUND_CATEGORIES.NEW_ENERGY },
  { pattern: /有色|钢铁|煤炭|化工|航运|石油|稀土|能源|资源|大宗商品/, category: FUND_CATEGORIES.CYCLICAL },
  { pattern: /军工|国防|航天/, category: FUND_CATEGORIES.MILITARY },
  { pattern: /地产|房地产|基建/, category: FUND_CATEGORIES.REAL_ESTATE },
  { pattern: /REIT|不动产/, category: FUND_CATEGORIES.REITS }
];

/**
 * 基金类型兜底规则（当关联板块无法匹配时使用）
 */
const TYPE_RULES = [
  { pattern: /QDII/, category: FUND_CATEGORIES.QDII },
  { pattern: /指数/, category: FUND_CATEGORIES.SECTOR_INDEX },
  { pattern: /债券|纯债|信用债|利率债/, category: FUND_CATEGORIES.BOND },
  { pattern: /股票|混合|偏股/, category: FUND_CATEGORIES.GROWTH }
];

/**
 * 分类基金
 *
 * @param {string} fundType - 基金类型（如"股票型-普通"、"指数型-股票"）
 * @param {string[]} relatedSectors - 关联板块数组（如["沪深300指数", "中证主要消费指数"]）
 * @param {string} [fundName] - 基金名称（如"易方达消费行业"，板块关键词通常直接出现在名称中）
 * @returns {{ category: string, confidence: number, matchedBy: string }}
 */
export function classifyFund(fundType, relatedSectors, fundName) {
  const sectors = (relatedSectors || []).filter(Boolean);
  const type = String(fundType || '');
  const name = String(fundName || '');

  // 1. 按关联板块匹配（优先级最高，来自人工维护的 Supabase fund_related 表）
  for (const sector of sectors) {
    const sectorStr = String(sector || '');
    for (const rule of SECTOR_RULES) {
      if (rule.exclude && rule.exclude.test(sectorStr)) continue;
      if (rule.pattern.test(sectorStr)) {
        return {
          category: rule.category,
          confidence: 0.9,
          matchedBy: `sector:${sectorStr}`
        };
      }
    }
  }

  // 2. 按基金名称匹配（板块关键词在名称中命中率远高于类型字段）
  if (name) {
    for (const rule of SECTOR_RULES) {
      if (rule.exclude && rule.exclude.test(name)) continue;
      if (rule.pattern.test(name)) {
        return {
          category: rule.category,
          confidence: 0.7,
          matchedBy: `name:${name}`
        };
      }
    }
  }

  // 3. 兜底按基金类型匹配
  for (const rule of TYPE_RULES) {
    if (rule.pattern.test(type)) {
      return {
        category: rule.category,
        confidence: 0.6,
        matchedBy: `type:${type}`
      };
    }
  }

  // 4. 无法分类
  return {
    category: FUND_CATEGORIES.OTHER,
    confidence: 0.1,
    matchedBy: 'default'
  };
}

/**
 * 按持仓的市场构成修正分类。
 *
 * 名称/类型字段识别不出「名字里没有美股关键词」的美股 QDII
 * （如「华宝海外科技股票(QDII)」实际持有 10 只美股，会被 TECH 规则命中而后无指标可算）。
 * 持仓的 market 字段是确定信号，故当已穿透持仓中美股按权重占比 ≥ 50% 时改用美股规则。
 *
 * @param {{ category: string, confidence: number, matchedBy: string }} classification
 * @param {Array<{ market?: string, weight?: number }>} perStock - 持仓穿透明细
 * @returns {{ category: string, confidence: number, matchedBy: string }} 修正后的分类
 */
export function refineClassificationByHoldings(classification, perStock) {
  const base =
    classification && classification.category
      ? classification
      : { category: FUND_CATEGORIES.OTHER, confidence: 0.1, matchedBy: 'default' };
  if (base.category === FUND_CATEGORIES.US_STOCK) return base;
  if (!Array.isArray(perStock) || perStock.length === 0) return base;

  let total = 0;
  let us = 0;
  for (const s of perStock) {
    const market = s?.market;
    if (market !== 'A' && market !== 'HK' && market !== 'US') continue;
    const weight = Number(s?.weight) || 0;
    if (weight <= 0) continue;
    total += weight;
    if (market === 'US') us += weight;
  }
  if (total <= 0 || us / total < 0.5) return base;

  return {
    category: FUND_CATEGORIES.US_STOCK,
    confidence: 0.75,
    matchedBy: 'holdings:us'
  };
}

/**
 * 获取分类的中文名称
 */
export const CATEGORY_NAMES = {
  [FUND_CATEGORIES.BROAD_INDEX]: '宽基指数',
  [FUND_CATEGORIES.DIVIDEND]: '红利/高股息',
  [FUND_CATEGORIES.GROWTH]: '成长型',
  [FUND_CATEGORIES.TECH]: '科技/AI',
  [FUND_CATEGORIES.PHARMA]: '医药',
  [FUND_CATEGORIES.CONSUMER]: '消费',
  [FUND_CATEGORIES.FINANCE]: '金融',
  [FUND_CATEGORIES.CYCLICAL]: '周期',
  [FUND_CATEGORIES.NEW_ENERGY]: '新能源',
  [FUND_CATEGORIES.MILITARY]: '军工',
  [FUND_CATEGORIES.REAL_ESTATE]: '地产',
  [FUND_CATEGORIES.REITS]: 'REITs',
  [FUND_CATEGORIES.SECTOR_INDEX]: '行业指数',
  [FUND_CATEGORIES.QDII]: 'QDII',
  [FUND_CATEGORIES.US_STOCK]: '美股',
  [FUND_CATEGORIES.BOND]: '债券',
  [FUND_CATEGORIES.OTHER]: '其他'
};

export const __test__ = { SECTOR_RULES, TYPE_RULES };
