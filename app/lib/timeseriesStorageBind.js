/**
 * 把 `storageStore` 绑定到分时序列模块。
 *
 * `app/lib/valuationTimeseries.js` 不直接 import `@/app/stores`，
 * 否则 zustand + 常量 + fundHelpers 的依赖链会跟着进纯 node 测试；
 * 因此绑定集中放在这个「副作用模块」里，由应用入口 import 一次。
 */
import { storageStore } from '@/app/stores';

import { bindTimeseriesStorage, notifyPersistError } from './valuationTimeseries.js';

bindTimeseriesStorage(storageStore);

// `storageStore.setItem` 改为「内存镜像 + 延迟落盘」后，配额写满不再同步抛错，
// 分时序列的「已降级为纯内存」标记改由这个回调点亮。
storageStore.setPersistErrorHandler((info) => notifyPersistError(info));
