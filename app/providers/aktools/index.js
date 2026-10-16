/**
 * AKTools Provider 公共入口
 *
 * 业务层 / UI 层只 import 该入口，禁止直接引用内部文件。
 * 这层包装是为了：
 *   1. 给上层一个稳定的导入路径
 *   2. 后续如要切换 AKTools 实例（自建 IP），只改 aktools-config.js
 *   3. 注入单例 provider（保证 defaultAktoolsProvider 与缓存共享 QueryClient）
 *   4. 注入运行时 baseUrl 覆盖解析器（读 settingsStore.aktoolsBaseUrl，设置页可改）
 */

import { useSettingsStore } from '@/app/stores/settingsStore';
import { getQueryClient } from '@/app/lib/get-query-client';
import { setAktoolBaseUrlResolver } from './aktools-client.js';
import { defaultAktoolsProvider } from './aktools-provider.js';
import { clearAllAktoolsCache } from './aktools-daily-cache.js';

export { AKTOOLS_CAPABILITIES, isCapabilitySupported } from './aktools-capabilities.js';

export {
  AKTOOLS_METADATA,
  AKTOOLS_ENDPOINTS,
  AKTOOLS_CACHE_TTL,
  AKTOOLS_BASE_URL,
  AKTOOLS_HK_VALUATION_INDICATORS,
  AKTOOLS_HK_VALUATION_PERIOD
} from './aktools-config.js';

export {
  AktoolsError,
  AktoolsUnavailableError,
  AktoolsTimeoutError,
  AktoolsRateLimitError,
  AktoolsParseError,
  AktoolsUnsupportedError,
  AktoolsApiError,
  FundNotFoundError
} from './aktools-errors.js';

export { createAktoolsClient, setAktoolBaseUrlResolver } from './aktools-client.js';

export {
  mapSearchFundRow,
  mapNavHistoryRow,
  mapHoldingRow,
  mapOverviewRows,
  mapStockFundamentalLatest,
  mapStockValueRow,
  mapStockValueHistory,
  mapStockRoe,
  mapStockHkRoe,
  mapStockHkValueHistory,
  mapStockUsFinancial
} from './aktools-mappers.js';

export { createAktoolsProvider, defaultAktoolsProvider, AKTOOLS_PROVIDER } from './aktools-provider.js';

export {
  getCachedStockFundamental,
  writeCache as writeStockFundamentalCache,
  cacheStockFundamentalFromRows,
  getCachedStockHkValueHistory,
  writeCachedStockHkValueHistory,
  getCachedStockValueWindow,
  writeCachedStockValueWindow,
  cleanExpiredAktoolsCache,
  clearAllAktoolsCache,
  getAktoolsCacheStats
} from './aktools-daily-cache.js';

/**
 * 注入运行时 baseUrl 覆盖解析器。
 *
 * 业务侧每次 AKTools 请求会经 aktools-client.js 的 resolveEffectiveBaseUrl 读取本回调：
 * 返回 settingsStore.aktoolsBaseUrl（设置页可改）；为空或非 http(s):// 开头时回落构建期 AKTOOLS_BASE_URL。
 *
 * 仅在此 barrel 注入：测试直接 import aktools-client.js / aktools-provider.js，resolver 保持 null，
 * 行为与本次改动前完全一致（始终用 AKTOOLS_BASE_URL）。
 *
 * 注意：useSettingsStore.getState() 在请求时才调用（resolver 闭包内），不在模块求值时执行，
 * 故 SSR / 构建期安全（不触碰 window/localStorage）。
 */
setAktoolBaseUrlResolver(() => useSettingsStore.getState().aktoolsBaseUrl || '');

/**
 * 承载 AKTools 数据的 TanStack Query 键前缀。
 *
 * ⚠️ 注意后三个：stockFundamentals / stockRoe / stockUsFinancial 是业务侧（app/api/fund.js）
 * 实际使用的键（`qk.aktools*` 那批只在从未被调用的 createAktoolsProviderForApp 路径上生效），
 * 它们同时也会承载东财主源的数据，一并清除只是多一次重新取数，不会产生错误数据。
 */
const AKTOOLS_DEPENDENT_QUERY_KEYS = [['aktools'], ['stockFundamentals'], ['stockRoe'], ['stockUsFinancial']];

/**
 * 清空全部 AKTools 相关缓存（三层）。
 *
 * 必须在「AKTools 服务地址变更」后调用：三层缓存中任何一层残留，都会让旧地址的数据继续被返回，
 * 最长可达 24h（provider 内存缓存的 TTL 取 staleTime，如 getStockFundamentals = ONE_DAY_MS；
 * 天级 localStorage 缓存的 CACHE_MAX_AGE_MS 同为 24h）：
 *   1. provider 实例内存缓存（defaultAktoolsProvider.clearCache）
 *   2. TanStack Query 中承载 AKTools 数据的键（见 AKTOOLS_DEPENDENT_QUERY_KEYS）
 *   3. 天级 localStorage 缓存（clearAllAktoolsCache）
 *
 * 任一层失败都不抛：清缓存属于保存流程的附带动作，不应因它失败而阻断保存。
 */
export const resetAktoolsCaches = () => {
  try {
    defaultAktoolsProvider.clearCache?.();
  } catch {
    // 忽略
  }
  try {
    clearAllAktoolsCache();
  } catch {
    // 忽略
  }
  try {
    const qc = getQueryClient();
    AKTOOLS_DEPENDENT_QUERY_KEYS.forEach((queryKey) => {
      try {
        qc.removeQueries({ queryKey });
      } catch {
        // 忽略单个键的失败
      }
    });
  } catch {
    // 忽略
  }
};
