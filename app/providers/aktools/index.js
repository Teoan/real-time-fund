/**
 * AKTools Provider 公共入口
 *
 * 业务层 / UI 层只 import 该入口，禁止直接引用内部文件。
 * 这层包装是为了：
 *   1. 给上层一个稳定的导入路径
 *   2. 后续如要切换 AKTools 实例（自建 IP），只改 aktools-config.js
 *   3. 注入单例 provider（保证 defaultAktoolsProvider 与缓存共享 QueryClient）
 */

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

export { createAktoolsClient } from './aktools-client.js';

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
