'use client';

import { useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { fetchFundHistory } from '@/app/api/fund';
import * as qk from '@/app/lib/query-keys';
import { NAV_CACHE_TTL_MS } from '@/app/lib/fundVolatilityCache';
import { loadFundVolatility } from '@/app/lib/fundVolatilityService';

/**
 * 基金波动信号 Hook
 *
 * 把「取数」接到 app/api/fund.js 的 fetchFundHistory（天天基金 pingzhongdata）上，
 * 其余编排全部交给 app/lib/fundVolatilityService.js：
 *   IndexedDB 缓存 → 补最新净值 → 算指标 → 判信号 → 归并状态 → 回写缓存
 *
 * 净值历史用 range='all'：pingzhongdata 本来就是整份文件，
 * 拉一次全量再在服务层裁剪到保留窗口，比按区间反复请求更省。
 *
 * ⚠️ staleTime 必须与 IndexedDB 的 NAV_CACHE_TTL_MS 对齐（而非估值面板的 ONE_DAY_MS）：
 *    内存层若比存储层「更新鲜」，服务层的 6 小时新鲜期在同一次会话里永远轮不到，
 *    等于把净值刷新周期悄悄变成 24 小时。
 *
 * @param {string|null} fundCode
 * @param {{ enabled?: boolean, basic?: object|null }} [options]
 * @returns {{
 *   data: object|null, isLoading: boolean, isError: boolean, error: Error|null,
 *   refetch: Function, refresh: () => Promise<object>, isFetching: boolean, isSuccess: boolean
 * }}
 */
export const useFundVolatility = (fundCode, { enabled = true, basic = null } = {}) => {
  const code = fundCode != null ? String(fundCode).trim() : '';

  // 手动刷新时绕过净值缓存新鲜期（一次性），避免为了强制刷新去污染 queryKey
  const forceRefreshRef = useRef(false);

  const query = useQuery({
    queryKey: qk.fundVolatility(code),
    queryFn: () =>
      loadFundVolatility(code, {
        fetchHistory: (c) => fetchFundHistory(c, 'all'),
        basic,
        forceRefresh: forceRefreshRef.current
      }),
    enabled: enabled && Boolean(code),
    staleTime: NAV_CACHE_TTL_MS,
    gcTime: NAV_CACHE_TTL_MS,
    refetchOnWindowFocus: false,
    retry: 1
  });

  const { refetch } = query;

  /** 手动刷新：绕过净值新鲜期强制重取，再与本地历史合并（指标/信号按净值指纹决定是否复用） */
  const refresh = useCallback(async () => {
    forceRefreshRef.current = true;
    try {
      return await refetch();
    } finally {
      forceRefreshRef.current = false;
    }
  }, [refetch]);

  return { ...query, refresh };
};
