// 与 valuationHistory.js 一致：lodash 是 CJS 包，Node 的 ESM 加载器无法解析命名导出，
// 命名导入会让本模块无法被 `node --test` 直接加载。
import lodash from 'lodash';

const { isNumber } = lodash;

/**
 * TanStack Query 手动缓存 TTL 补丁。
 *
 * 背景（实测 query-core 5.97.0）：
 *   `queryClient.setQueryData(queryKey, data, { staleTime })` 的第三个参数只认 `{ updatedAt }`，
 *   传 `staleTime` 会被**静默丢弃**；而 `getQueryData()` 从不检查时效。
 *   结果：手动写入的条目实际只受 `gcTime`（本项目默认 5 分钟）约束，
 *   表现为「想缓存 10 秒的实时估值被缓存了 5 分钟」「想缓存 1 天的数据 5 分钟就重新拉」。
 *
 * 因此凡是「手动读写、没有 useQuery 观察者」的缓存，都走这里：
 * 数据仍存在 React Query 缓存里（便于调试/扩展读取），但**有效期由本模块自己记**。
 *
 * 用法：
 *   const cache = createManualQueryCache({ getQueryClient });
 *   cache.set(queryKey, value, 10 * 1000);   // 10 秒有效
 *   const v = cache.get(queryKey);           // 过期或未写入 → undefined
 *
 * @param {object} options
 * @param {() => { getQueryData: Function, setQueryData: Function }} options.getQueryClient 惰性取 QueryClient
 * @param {() => number} [options.now] 时间源，便于单测注入
 */
export const createManualQueryCache = ({ getQueryClient, now = () => Date.now() }) => {
  /** keyId -> { at: 写入时刻, ttl: 有效时长(ms) } */
  const meta = new Map();

  const keyId = (queryKey) => {
    try {
      return JSON.stringify(queryKey);
    } catch {
      // queryKey 含不可序列化内容时退化为字符串拼接，保证不会整体抛错
      return String(queryKey);
    }
  };

  const set = (queryKey, value, ttl) => {
    getQueryClient().setQueryData(queryKey, value);
    const lifetime = isNumber(ttl) && ttl > 0 ? ttl : 0;
    meta.set(keyId(queryKey), { at: now(), ttl: lifetime });
  };

  const get = (queryKey) => {
    const id = keyId(queryKey);
    const entry = meta.get(id);
    if (!entry) return undefined;
    if (now() - entry.at > entry.ttl) {
      // 过期即不再返回；条目本身留给 gcTime 回收（不 removeQueries，
      // 避免把同 key 上可能存在的活跃查询一起打断）
      meta.delete(id);
      return undefined;
    }
    return getQueryClient().getQueryData(queryKey);
  };

  const clear = () => {
    meta.clear();
  };

  return { get, set, clear };
};
