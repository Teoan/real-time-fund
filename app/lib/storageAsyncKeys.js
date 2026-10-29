/**
 * 大对象存储键登记表（P1）
 *
 * localStorage 是同步 API，首屏那几个 `initXxx()` 必须能同步读到值，所以 **不能全量迁 IndexedDB**。
 * 这里只登记「体积大 / 写入频繁 / 读取都发生在启动之后」的键，它们改走 IndexedDB KV：
 *
 * - 启动时 `hydrateStorage()` 一次性把 kv 里的值灌进 storagePersist 的内存镜像（一次读写代替 N 次）；
 * - 之后 `storageStore.getItem()` 仍然是同步的（读镜像），102 处调用点无感；
 * - 写入进镜像 + 合并，最后批量写 IndexedDB（单事务）；
 * - IndexedDB 不可用 / 水合失败 → 完全退回 localStorage，行为与 P0 之前一致。
 *
 * 加键的判断标准：单条 ≥ 200KB，或写入频率高但读取不在首屏同步路径上。
 */

import { isString } from 'lodash';

import { TIMESERIES_KEY_PREFIX } from './storageKeys.js';

/** 按完整 key 命中 */
export const ASYNC_STORAGE_KEYS = Object.freeze([
  /** 每日收益快照：100 只 × 250 天 ≈ 1.3MB */
  'fundDailyEarnings',
  /** 分红记录 */
  'fundDividends',
  /** 交易流水 */
  'transactions',
  /** 估值校准样本 */
  'valuationAccuracy'
]);

/** 按前缀命中（分时序列已按基金拆键） */
export const ASYNC_STORAGE_KEY_PREFIXES = Object.freeze([
  TIMESERIES_KEY_PREFIX,
  /**
   * AKTools 天级缓存（纯缓存，可重建）：`aktools:stockFundamentals:` /
   * `aktools:hkValueHistory:` / `aktools:stockValueWindow:`。
   * 港股序列 ~45KB/指标、分位窗口 ~22KB/只，时间窗放宽后会明显吃配额。
   * 水合前读不到只会多一次网络请求，不影响用户数据。
   */
  'aktools:'
]);

/**
 * 该 key 是否登记为大对象（走 IndexedDB）
 * @param {string} key
 * @returns {boolean}
 */
export function isAsyncStorageKey(key) {
  if (!isString(key)) return false;
  if (ASYNC_STORAGE_KEYS.includes(key)) return true;
  return ASYNC_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}
