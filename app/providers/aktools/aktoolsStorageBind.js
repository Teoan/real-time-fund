/**
 * 把 `storageStore` 绑定到 AKTools 天级缓存模块。
 *
 * `aktools-daily-cache.js` 不直接 import `@/app/stores`：它是纯 node 可测模块，
 * 绑定集中放在这个「副作用模块」里，由应用入口 import 一次（同 timeseriesStorageBind）。
 *
 * 绑定后 `aktools:` 前缀的缓存跟随 P1 策略存进 IndexedDB，
 * 不再占 localStorage 的 ~5MB 配额。
 */
import { storageStore } from '@/app/stores';

import { bindAktoolsCacheStorage } from './aktools-daily-cache.js';

bindAktoolsCacheStorage(storageStore);
