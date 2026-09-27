'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchFundValuationHistory } from '@/app/api/fund';
import * as qk from '@/app/lib/query-keys';
import { ONE_DAY_MS } from '@/app/constants';
import { DEFAULT_VALUATION_PERIOD } from '@/app/lib/valuationHistory';

/**
 * 基金估值区间走势（近 1 月 / 近 3 月）
 *
 * 首次计算需要拉取/读取持仓的估值历史（A 股走天级缓存、港股走百度序列），
 * 因此比当前时点评分慢，默认只在用户展开区间分析时才启用。
 *
 * @param {string|null} fundCode
 * @param {'1m'|'3m'} range
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ data: object|null, isLoading: boolean, isError: boolean, refetch: Function }}
 */
export const useFundValuationHistory = (fundCode, range = DEFAULT_VALUATION_PERIOD, { enabled = true } = {}) => {
  const code = fundCode != null ? String(fundCode).trim() : '';
  const period = range || DEFAULT_VALUATION_PERIOD;
  return useQuery({
    queryKey: qk.fundValuationHistory(code, period),
    queryFn: () => fetchFundValuationHistory(code, period),
    enabled: enabled && Boolean(code),
    // 与当前评分同粒度：历史序列基于天级缓存，日内不会变
    staleTime: ONE_DAY_MS,
    gcTime: ONE_DAY_MS,
    refetchOnWindowFocus: false,
    retry: 1
  });
};
