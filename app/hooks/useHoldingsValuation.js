'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchHoldingsValuation } from '@/app/api/fund';
import { getQueryClient } from '@/app/lib/get-query-client';
import * as qk from '@/app/lib/query-keys';
import { ONE_DAY_MS } from '@/app/constants';

/**
 * 基金持仓穿透估值 Hook
 * @param {string|null} fundCode
 * @param {{ enabled?: boolean }} options
 */
export const useHoldingsValuation = (fundCode, { enabled = true } = {}) => {
  const code = fundCode != null ? String(fundCode).trim() : '';
  return useQuery({
    queryKey: qk.holdingsValuation(code),
    queryFn: () => fetchHoldingsValuation(code),
    enabled: enabled && Boolean(code),
    staleTime: ONE_DAY_MS,
    gcTime: ONE_DAY_MS,
    refetchOnWindowFocus: false,
    retry: 1
  });
};

/**
 * 主动让某只基金的穿透估值失效（用于「刷新」按钮）
 * @param {string} fundCode
 */
export const invalidateHoldingsValuation = (fundCode) => {
  const code = fundCode != null ? String(fundCode).trim() : '';
  if (!code) return;
  try {
    getQueryClient().invalidateQueries({ queryKey: qk.holdingsValuation(code) });
  } catch (e) {}
};
