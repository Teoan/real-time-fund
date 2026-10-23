/**
 * 把 `storageStore` 绑定到分时序列模块。
 *
 * `app/lib/valuationTimeseries.js` 不直接 import `@/app/stores`，
 * 否则 zustand + 常量 + fundHelpers 的依赖链会跟着进纯 node 测试；
 * 因此绑定集中放在这个「副作用模块」里，由应用入口 import 一次。
 */
import { storageStore } from '@/app/stores';

import { bindTimeseriesStorage } from './valuationTimeseries.js';

bindTimeseriesStorage(storageStore);
