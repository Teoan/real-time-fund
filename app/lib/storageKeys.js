/**
 * localStorage key 常量。
 *
 * 单独成模块是为了让 `app/stores/storageStore.js` 与各持久化模块共用同一份字面量，
 * 避免出现「写入用新 key、读取还认旧 key」这种漂移（分时序列正好跨这两个地方）。
 */

/** 旧版把全部分时序列塞在这一个 key 里（读到时自动迁移为分键并删除） */
export const TIMESERIES_LEGACY_KEY = 'fundValuationTimeseries';

/**
 * 分时序列按基金分键：`fundValuationTimeseries:{code}`，值形如 `{ [dataSource]: point[] }`。
 *
 * 拆键的原因：旧版每记录一只基金都要把「所有基金的所有数据源」整体 stringify 写回，
 * 20 只 × 1200 点（≈2.3MB）时单次写入 ≈ 12ms 的 stringify + 同步落盘，一轮刷新 20 次。
 */
export const TIMESERIES_KEY_PREFIX = `${TIMESERIES_LEGACY_KEY}:`;

/**
 * 分时序列在云端同步里的逻辑键。
 * 分键只是本地存储形态，云端载荷仍是「整块 { code: { ds: points[] } }」，所以同步侧
 * 继续用这一个逻辑键（`storageStore` 会把分键的写入映射回它，见 syncKeyOf）。
 */
export const TIMESERIES_SYNC_KEY = TIMESERIES_LEGACY_KEY;
