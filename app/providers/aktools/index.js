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
import { setAktoolBaseUrlResolver } from './aktools-client.js';

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
