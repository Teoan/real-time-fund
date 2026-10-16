'use client';

import { useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { fetchFundHistory, fetchIndexKlineHistory } from '@/app/api/fund';
import * as qk from '@/app/lib/query-keys';
import { NAV_CACHE_TTL_MS } from '@/app/lib/fundVolatilityCache';
import { loadFundMetrics } from '@/app/lib/fundMetricsService';

/**
 * 基金指标（13 项）Hook
 *
 * 把「取数」接到 app/api/fund.js 的 fetchFundHistory（净值）与 fetchIndexKlineHistory（业绩基准），
 * 其余编排全部交给 app/lib/fundMetricsService.js。
 *
 * ⚠️ 与 useFundVolatility 共用同一份 IndexedDB 净值缓存（fundNav）与同一个
 *    `pingzhongdata` React Query 缓存，所以「波动」与「指标」两个页签之间来回切换
 *    不会重复拉全量净值。
 *
 * ⚠️ staleTime 必须与 IndexedDB 的 NAV_CACHE_TTL_MS 对齐（理由同 useFundVolatility）：
 *    内存层若比存储层「更新鲜」，服务层的 6 小时新鲜期在同一次会话里永远轮不到。
 *
 * @param {string|null} fundCode
 * @param {{ enabled?: boolean, basic?: object|null, riskFreeRate?: number }} [options]
 * @returns {{
 *   data: object|null, isLoading: boolean, isError: boolean, error: Error|null,
 *   refetch: Function, refresh: () => Promise<object>, isFetching: boolean, isSuccess: boolean
 * }}
 */
export const useFundMetrics = (fundCode, { enabled = true, basic = null, riskFreeRate } = {}) => {
  const code = fundCode != null ? String(fundCode).trim() : '';

  // 手动刷新时绕过净值与基准的新鲜期（一次性），避免为了强制刷新去污染 queryKey
  const forceRefreshRef = useRef(false);

  const query = useQuery({
    queryKey: qk.fundMetrics(code),
    queryFn: () =>
      loadFundMetrics(code, {
        fetchHistory: (c) => fetchFundHistory(c, 'all'),
        fetchBenchmark: (secid) => fetchIndexKlineHistory(secid),
        basic,
        riskFreeRate,
        forceRefresh: forceRefreshRef.current
      }),
    enabled: enabled && Boolean(code),
    staleTime: NAV_CACHE_TTL_MS,
    gcTime: NAV_CACHE_TTL_MS,
    refetchOnWindowFocus: false,
    retry: 1
  });

  const { refetch } = query;

  /** 手动刷新：绕过新鲜期强制重取净值与基准，再各自与本地历史合并 */
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
