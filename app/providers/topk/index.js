/**
 * TopK Provider 公共入口
 *
 * 业务层 / UI 层只 import 该入口，禁止直接引用内部文件。
 * 这层包装是为了：
 *   1. 给上层一个稳定的导入路径
 *   2. 后续如要切换 AKTools 实例（自建 IP），只改 topk-config.js
 *   3. 注入单例 provider（保证 defaultTopKProvider 与缓存共享 QueryClient）
 */

export { TOPK_CAPABILITIES, isCapabilitySupported } from './topk-capabilities.js';

export { TOPK_METADATA, TOPK_ENDPOINTS, TOPK_CACHE_TTL, TOPK_BASE_URL } from './topk-config.js';

export {
  TopKError,
  TopKUnavailableError,
  TopKTimeoutError,
  TopKRateLimitError,
  TopKParseError,
  TopKUnsupportedError,
  TopKApiError,
  FundNotFoundError
} from './topk-errors.js';

export { createTopKClient } from './topk-client.js';

export {
  mapSearchFundRow,
  mapNavHistoryRow,
  mapHoldingRow,
  mapOverviewRows,
  mapStockFundamentalLatest,
  mapStockValueRow,
  mapStockValueHistory,
  mapStockRoe
} from './topk-mappers.js';

export { createTopKProvider, defaultTopKProvider, TOPK_PROVIDER } from './topk-provider.js';

export {
  getCachedStockFundamental,
  writeCache as writeStockFundamentalCache,
  cacheStockFundamentalFromRows,
  cleanExpiredStockFundamentalsCache,
  getStockFundamentalsCacheStats
} from './topk-daily-cache.js';
