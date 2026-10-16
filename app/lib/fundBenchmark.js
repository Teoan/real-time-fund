/**
 * 业绩基准（指数）选择表
 *
 * 用途：信息比率 / Alpha / Beta 需要一个市场基准。本文件只做「基金 → 基准」的纯映射，
 * 不取数、不碰 React，因此可以直接单测。
 *
 * 为什么按**基金名称**猜而不是按基金类型：
 *   基金行数据里没有可靠的「基金类型」字段可读（`classifyFund` 走的是关联板块 + 名称关键词，
 *   同样没有类型可用），而名称里最常见的基准线索（美股 / 港股 / 债券）命中率很高。
 *   猜错的代价可控：面板会**明示所用基准**，用户能立刻看出「这只债基怎么拿沪深300当基准」。
 *
 * ⚠️ 规则顺序即优先级，且必须写足「排除」条件：
 *   - 「标普中国A股红利」「标普港股通低波红利」名字带标普但不是美股，故不写裸「标普」；
 *   - 「银华-道琼斯88指数」跟踪的是道琼斯中国88指数（A 股），故排除 88；
 *   - 「美国债券(QDII)」带「美国」但资产是债，故美股规则排除债券关键词。
 *
 * 债券/货币型返回 null 是**有意为之**：东财 push2his 取不到中证全债等债券指数
 * （实测 H11001 / 2.000012 均返回 `rc:100, data:null`），拿沪深300 给债基算 Beta
 * 会得出一个恒接近 0 的假指标——不如明确显示「暂未配置基准」。
 */

// lodash 是 CJS 包：必须「默认导入 + 解构」才能被 node --test 直接加载（同 app/lib/valuationHistory.js）
import lodash from 'lodash';

const { isString } = lodash;

/** 默认基准：沪深300（覆盖绝大多数 A 股主动权益与指数基金） */
export const DEFAULT_BENCHMARK = Object.freeze({
  secid: '1.000300',
  name: '沪深300'
});

/**
 * 基准定义表。
 *
 * ⚠️ 美股基准**不做交易日滞后**（V1 曾按「美股 t 日收盘晚于 A 股」假设滞后 1 天，实测证伪）：
 *    实测 270042（广发纳斯达克100ETF联接 QDII）近 5 年 1285 个净值日与 100.NDX 对比：
 *      同日对齐 → 相关系数 0.958、Beta 0.984（正确）
 *      滞后 1 日 → 相关系数 -0.043、Beta -0.043（纯噪声，但看起来仍像个数字）
 *    原因是 QDII 的净值日期直接采用**标的市场自己的交易日**（美股 t 日收盘 → 净值日期就是 t），
 *    而不是「A 股日历上的 t+1」。因此所有基准一律同日对齐。
 *
 * ⚠️ 已知口径局限：QDII 以人民币计价、基准是美元/港币指数，
 *    汇率变动会被计入 Alpha。本版本不做汇率中性化，面板上明示所用基准供用户判断。
 */
const BENCHMARK_RULES = [
  {
    // 债券 / 货币：无可用基准（见文件头说明）
    pattern: /纯债|债券|信用债|利率债|国债|货币/,
    benchmark: null
  },
  {
    // 纳指产品对纳斯达克100 更贴切（实测 100.NDX 可用）
    pattern: /纳斯达克|纳指/,
    exclude: /债券|纯债|信用债|利率债|国债|货币/,
    benchmark: { secid: '100.NDX', name: '纳斯达克100' }
  },
  {
    pattern: /标普500|标普100|美股|美国|道琼斯(?!.*88)/,
    exclude: /债券|纯债|信用债|利率债|国债|货币/,
    benchmark: { secid: '100.SPX', name: '标普500' }
  },
  {
    pattern: /恒生|港股|H股|香港/,
    exclude: /债券|纯债|信用债|利率债|国债|货币/,
    benchmark: { secid: '100.HSI', name: '恒生指数' }
  }
];

/**
 * 解析某只基金应使用的业绩基准。
 *
 * @param {{ name?: string }} [fund] 基金基本信息（只需要名称）
 * @returns {{ secid: string, name: string }|null}
 *          返回 null 表示该基金暂无合适基准（调用方应把 Alpha/Beta/信息比率显示为 '--'）
 */
export const resolveFundBenchmark = (fund) => {
  const name = isString(fund?.name) ? fund.name.trim() : '';
  if (!name) return { ...DEFAULT_BENCHMARK };

  for (const rule of BENCHMARK_RULES) {
    if (rule.exclude && rule.exclude.test(name)) continue;
    if (rule.pattern.test(name)) {
      return rule.benchmark ? { ...rule.benchmark } : null;
    }
  }

  return { ...DEFAULT_BENCHMARK };
};

export const __test__ = { BENCHMARK_RULES };
