'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchFundValuationScore } from '@/app/api/fund';
import * as qk from '@/app/lib/query-keys';
import { ONE_DAY_MS } from '@/app/constants';

/**
 * 基金估值评分 Hook
 *
 * @param {string|null} fundCode
 * @param {{ enabled?: boolean }} options
 * @returns {{ data: object|null, isLoading: boolean, isError: boolean, refetch: Function }}
 */
export const useFundValuation = (fundCode, { enabled = true } = {}) => {
  const code = fundCode != null ? String(fundCode).trim() : '';
  return useQuery({
    queryKey: qk.fundValuationScore(code),
    queryFn: () => fetchFundValuationScore(code),
    enabled: enabled && Boolean(code),
    staleTime: ONE_DAY_MS,
    gcTime: ONE_DAY_MS,
    refetchOnWindowFocus: false,
    retry: 1
  });
};
