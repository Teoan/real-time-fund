'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Star,
  Filter,
  ChevronDown,
  ChevronRight,
  TrendingUp,
  BarChart3,
  Activity,
  ChevronUp,
  CheckCircle,
  PlusCircle
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { isNumber } from 'lodash';
import { columnVisibilityFeature, tableFeatures, useTable, flexRender } from '@tanstack/react-table';
import { fetchFundValuationRanking, fetchFundPeriodReturns, fetchFundRankOpen, fetchHotSectors } from '../api/fund';
import { cn } from '@/lib/utils';
import { useStorageStore, useModalStore } from '../stores';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Empty, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia } from '@/components/ui/empty';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '../hooks/useIsMobile';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import MobileFundCardDrawer from './MobileFundCardDrawer';
import FundCard from './FundCard';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * 业绩排行可选区间：key 与 AKTools mapper（mapFundRankRow）的字段一一对应，
 * 上游口径为「近1周/近1月/近3月/近6月/近1年/今年来/成立来」。
 */
const RANK_PERIODS = [
  { key: 'week1', label: '近1周' },
  { key: 'month1', label: '近1月' },
  { key: 'month3', label: '近3月' },
  { key: 'month6', label: '近6月' },
  { key: 'year1', label: '近1年' },
  { key: 'yearToDate', label: '今年来' },
  { key: 'sinceInception', label: '成立来' }
];

/**
 * 业绩排行分类顺序：按「找基金」的实际使用频率排，默认第一个是股票型。
 * 与 AKTOOLS_FUND_RANK_SYMBOLS 是子集关系（LOF 与「全部」高度重叠，未在 UI 暴露）。
 */
const RANK_SYMBOLS = ['股票型', '混合型', '指数型', '债券型', 'QDII', 'FOF', '全部'];

/** 业绩排行单页码数：与估值榜保持一致，本地分页（全量已在内存） */
const RANK_PAGE_SIZE = 20;

/**
 * TanStack Table v9 是特性化 API：`row.getVisibleCells` 由 columnVisibilityFeature 提供，
 * 空 features 下该方法根本不存在（运行时报 `row.getVisibleCells is not a function`）。
 * 本项目这两个榜单没有列显隐开关，注册该特性只是为了保住「只渲染可见列」的既有语义。
 */
const MARKET_TABLE_FEATURES = tableFeatures({ columnVisibilityFeature });

/** 估值榜单页码数（全量 782 行已在内存，本地分页） */
const RANKING_PAGE_SIZE = 20;

/**
 * 榜单 tab → 数据源指标。
 * 上游（AKTools fund_value_estimation_em）一次给全表，排序全部在本地做，
 * 所以这里只需要决定「按哪个字段排」，不再有服务端排序参数。
 */
const RANKING_TAB_METRIC = Object.freeze({
  increase: 'estimate',
  decrease: 'estimate',
  actual: 'actual',
  deviation: 'deviation'
});

function FundDetailDialog({ cardDialogRow, getFundCardProps, setCardDialogRow }) {
  const isAnySubModalOpen = useModalStore(
    (s) =>
      s.dataSourceModal.open ||
      s.tradeModal.open ||
      s.holdingModal.open ||
      s.dcaModal.open ||
      s.dividendMethodModal.open ||
      s.convertModal.open ||
      s.fundTagsEdit.open ||
      s.historyModal.open ||
      s.actionModal.open ||
      s.selectHoldingGroupModal.open ||
      s.addHistoryModal.open ||
      // 调研初步报告从「基金详情」内部打开，必须计入，否则点它会把详情弹框一起关掉
      s.fundReportModal.open ||
      // 基金档案入口就在详情卡片的数据源徽标旁，同理必须计入
      s.fundProfileModal.open
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isAnySubModalOpen) setCardDialogRow(null);
      }}
    >
      <DialogContent
        className="sm:max-w-2xl max-h-[88vh] flex flex-col p-0 overflow-hidden"
        onPointerDownOutside={(e) => {
          if (isAnySubModalOpen) e.preventDefault();
        }}
      >
        <DialogHeader className="flex-shrink-0 flex flex-row items-center justify-between gap-2 space-y-0 px-6 pb-4 pt-6 text-left border-b border-[var(--border)]">
          <DialogTitle className="text-base font-semibold text-[var(--text)]">基金详情</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 scrollbar-y-styled">
          {cardDialogRow && getFundCardProps ? (
            <FundCard {...getFundCardProps(cardDialogRow)} layoutMode="drawer" />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function MarketTab({ onAddFund, getFundCardProps, isActive }) {
  const [detailFund, setDetailFund] = useState(null);
  const [detailFundExtra, setDetailFundExtra] = useState(null);
  const [pageIndex, setPageIndex] = useState(1);

  useEffect(() => {
    if (detailFund) {
      setDetailFundExtra(null);
      fetchFundPeriodReturns(detailFund.bzdm)
        .then((data) => {
          setDetailFundExtra(data);
        })
        .catch(() => {});
    }
  }, [detailFund]);

  // 业绩排行（全市场跨周期榜）：分类 → 区间 → 排序，全部本地切换（上游无分页/排序参数）
  const [rankSymbol, setRankSymbol] = useState('股票型');
  const [rankPeriod, setRankPeriod] = useState('year1');
  const [rankOrder, setRankOrder] = useState('desc');
  const [rankPage, setRankPage] = useState(1);

  // increase 估值涨幅 / decrease 估值跌幅 / deviation 估值偏差 / actual 实际涨幅 / performance 业绩排行
  // 注：原「成交热度」tab 依赖的东财成交量接口已下线，位置改让给同源数据可算的「估值偏差」
  const [activeTab, setActiveTab] = useState('increase');
  const [sectorFilter, setSectorFilter] = useState('industry'); // industry, concept
  const [sectorSort, setSectorSort] = useState('change_pct'); // change_pct, net_inflow
  const [sectorSortOrder, setSectorSortOrder] = useState('desc'); // desc, asc
  const isMobile = useIsMobile();

  // Storage for favorites and funds
  const favorites = useStorageStore((s) => s.favorites);
  const toggleFavorite = useStorageStore((s) => s.toggleFavorite);
  const funds = useStorageStore((s) => s.funds);

  // 热门板块：AKTools 板块行情（行业/概念分取，按 type 分别缓存，切换时只拉一次）
  const { data: sectorEstimates, isLoading: sectorsLoading } = useQuery({
    queryKey: ['hotSectors', sectorFilter],
    queryFn: () => fetchHotSectors({ type: sectorFilter }),
    enabled: !!isActive,
    staleTime: 5 * 60 * 1000
  });

  const filteredAndSortedSectors = useMemo(() => {
    if (!sectorEstimates) return [];

    // 数据已按 sector_type 取回，这里只负责排序与截断
    const result = [...sectorEstimates].sort((a, b) => {
      const valA = a[sectorSort] || 0;
      const valB = b[sectorSort] || 0;
      return sectorSortOrder === 'desc' ? valB - valA : valA - valB;
    });

    return result.slice(0, isMobile ? 4 : 10);
  }, [sectorEstimates, sectorSort, sectorSortOrder, isMobile]);

  const isPerformanceTab = activeTab === 'performance';

  // 估值榜（估值涨幅 / 估值跌幅 / 实际涨幅 / 估值偏差）—— AKTools 整表 + 本地排序分页
  const rankingMetric = RANKING_TAB_METRIC[activeTab] || 'estimate';
  const rankingOrder = activeTab === 'decrease' ? 'asc' : 'desc';

  const {
    data: rankingPage,
    isLoading: rankingLoading,
    error: rankingError
  } = useQuery({
    queryKey: ['valuationRanking', rankingMetric, rankingOrder, pageIndex],
    queryFn: () => fetchFundValuationRanking(rankingMetric, rankingOrder, pageIndex, RANKING_PAGE_SIZE),
    enabled: !!isActive && !isPerformanceTab,
    staleTime: 60 * 1000
  });

  const rankingData = rankingPage?.Data?.list || [];
  const rankingAllRecords = rankingPage?.Data?.allRecords || 0;
  const rankingTotalPages = Math.max(1, Math.ceil(rankingAllRecords / RANKING_PAGE_SIZE));

  // 数据缩水（例如上游当日只回了更少的基金）时把页码拉回有效范围，避免停在空白页
  useEffect(() => {
    if (pageIndex > rankingTotalPages) setPageIndex(rankingTotalPages);
  }, [pageIndex, rankingTotalPages]);

  /**
   * 业绩排行（AKTools fund_open_fund_rank_em）。
   *
   * 按分类取整表（上游无分页），只在该 tab 激活时才请求：
   * 默认「股票型」一次 ~0.7s/413KB，「全部」则 ~8s/7.8MB，所以不做预取、不并发多分类。
   * staleTime 1h 与 AKTOOLS_CACHE_TTL.getFundRank 对齐；跨会话靠 IndexedDB 天级缓存（24h）。
   */
  const {
    data: rankData,
    isLoading: rankLoading,
    error: rankError
  } = useQuery({
    queryKey: ['fundRankOpen', rankSymbol],
    queryFn: () => fetchFundRankOpen({ symbol: rankSymbol }),
    enabled: !!isActive && isPerformanceTab,
    staleTime: 60 * 60 * 1000
  });

  // 分类/区间/排序变化后回到第 1 页（否则会停在一个已不存在的页码上）
  useEffect(() => {
    setRankPage(1);
  }, [rankSymbol, rankPeriod, rankOrder]);

  const rankPeriodLabel = useMemo(
    () => RANK_PERIODS.find((item) => item.key === rankPeriod)?.label || '',
    [rankPeriod]
  );

  /**
   * 本地排序：缺值的行（次新基金近1年/近3年为 NaN）统一排到最后，
   * 不参与数值比较 —— 否则 null 会被当成 0 混进榜尾，看起来像「涨了 0%」。
   */
  const rankSortedRows = useMemo(() => {
    const rows = rankData?.rows || [];
    if (rows.length === 0) return [];
    const direction = rankOrder === 'desc' ? -1 : 1;
    const valued = [];
    const unvalued = [];
    for (const row of rows) {
      if (isNumber(row[rankPeriod])) valued.push(row);
      else unvalued.push(row);
    }
    valued.sort((a, b) => (a[rankPeriod] - b[rankPeriod]) * direction);
    return valued.concat(unvalued);
  }, [rankData, rankPeriod, rankOrder]);

  const rankTotalPages = Math.max(1, Math.ceil(rankSortedRows.length / RANK_PAGE_SIZE));
  const rankSafePage = Math.min(Math.max(1, rankPage), rankTotalPages);

  /**
   * 当前页行 → 兼容既有字段契约（bzdm / jjjc / dwjz / jzzzl / gxrq）：
   * 名称列的「加自选」与点击打开的 FundCard 详情弹框都按这套字段取值，
   * 映射一次即可同时复用两条既有链路，不必为业绩榜另写一套。
   */
  const rankPageRows = useMemo(() => {
    const start = (rankSafePage - 1) * RANK_PAGE_SIZE;
    return rankSortedRows.slice(start, start + RANK_PAGE_SIZE).map((row, index) => ({
      ...row,
      bzdm: row.code,
      jjjc: row.name,
      dwjz: row.unitNav,
      jzzzl: row.dayReturn,
      gxrq: row.date,
      gszzl: null,
      displayRank: start + index + 1,
      periodReturn: isNumber(row[rankPeriod]) ? row[rankPeriod] : null
    }));
  }, [rankSortedRows, rankSafePage, rankPeriod]);

  /** 翻页/切 tab 后把视口拉回榜单区（复用于估值榜与业绩榜） */
  const scrollToRankingSection = () => {
    setTimeout(() => {
      const el = document.getElementById('market-ranking-section');
      if (!el) return;
      const navbar = document.querySelector('.navbar');
      const navHeight = navbar ? navbar.getBoundingClientRect().height : 68;
      const indexAccordion = document.querySelector('.market-index-accordion-root');
      const indexHeight = indexAccordion ? indexAccordion.getBoundingClientRect().height : 0;
      const offset = navHeight + indexHeight + 16;
      const y = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }, 10);
  };

  const formatPercent = (val) => {
    if (val === undefined || val === null || val === '---' || val === '') return '--';
    const num = parseFloat(val);
    if (!Number.isFinite(num)) return '0.00%';
    return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
  };

  const getColorClass = (val) => {
    const num = parseFloat(val);
    if (!Number.isFinite(num) || num === 0) return 'text-[var(--foreground)]';
    return num > 0 ? 'text-[var(--danger)]' : 'text-[var(--success)]';
  };

  const rankingTableColumns = useMemo(() => {
    const columns = [
      {
        accessorKey: 'bzdm',
        header: '基金名称',
        meta: { align: 'text-left', flex: 2 },
        cell: (info) => {
          const fund = info.row.original;
          const isAdded = funds?.some?.((f) => f.code === fund.bzdm);
          return (
            <div className="w-full">
              <div className="flex items-start gap-1.5 mb-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isAdded && onAddFund) {
                          onAddFund({ code: fund.bzdm, name: fund.jjjc });
                        }
                      }}
                      className={cn(
                        'focus:outline-none flex-shrink-0 mt-[2px]',
                        isAdded
                          ? 'text-[var(--success)] cursor-default'
                          : 'text-muted-foreground opacity-50 hover:opacity-100 hover:text-primary transition-colors cursor-pointer'
                      )}
                      disabled={isAdded}
                    >
                      {isAdded ? <CheckCircle size={16} /> : <PlusCircle size={16} />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{isAdded ? '已添加' : '添加'}</p>
                  </TooltipContent>
                </Tooltip>
                <span
                  className="font-medium text-sm whitespace-normal break-all leading-snug cursor-pointer hover:text-primary transition-colors"
                  onClick={() => setDetailFund(fund)}
                >
                  {fund.jjjc}
                </span>
              </div>
              <div className="flex items-center gap-2 pl-5">
                <span className="text-xs opacity-50">#{fund.bzdm}</span>
                {fund.FType && (
                  <span className="fund-tag text-[10px] px-1 rounded-sm opacity-60 border border-current">
                    {fund.FType.split('-')[0]}
                  </span>
                )}
              </div>
            </div>
          );
        }
      },
      {
        accessorKey: 'jzzzl',
        header: '最新涨幅',
        meta: { align: 'text-right', flex: 1 },
        cell: (info) => {
          const fund = info.row.original;
          return (
            <div className="flex flex-col items-end justify-center w-full">
              <span className={cn('text-sm font-medium', getColorClass(fund.jzzzl))}>{formatPercent(fund.jzzzl)}</span>
              <span className="text-xs opacity-50 mt-0.5">{fund.gxrq?.slice(5)}</span>
            </div>
          );
        }
      }
    ];

    columns.push({
      accessorKey: 'gszzl',
      header: '估算涨幅',
      meta: { align: 'text-right', flex: 1 },
      cell: (info) => {
        const fund = info.row.original;
        return (
          <div className="flex flex-col items-end justify-center w-full">
            <span className={cn('text-sm font-bold', getColorClass(fund.gszzl))}>{formatPercent(fund.gszzl)}</span>
            {isNumber(fund.deviation) && (
              <span className="text-[10px] opacity-40 mt-0.5 tabular-nums">偏差 {fund.deviation.toFixed(2)}%</span>
            )}
          </div>
        );
      }
    });

    return columns;
  }, [funds, onAddFund]);

  const rankingTable = useTable({
    data: rankingData || [],
    columns: rankingTableColumns,
    features: MARKET_TABLE_FEATURES
  });

  /**
   * 业绩排行列：基金名称 / 区间收益 / 当日涨幅。
   * 刻意保持 3 列 —— 与估值榜同宽，移动端才不会把基金名挤成两行。
   * 费率作为名称下方的次级标签展示（找基金时费率是第一顺位筛选条件之一）。
   */
  const rankTableColumns = useMemo(
    () => [
      {
        accessorKey: 'bzdm',
        header: '基金名称',
        meta: { align: 'text-left', flex: 2 },
        cell: (info) => {
          const fund = info.row.original;
          const isAdded = funds?.some?.((f) => f.code === fund.bzdm);
          return (
            <div className="w-full">
              <div className="flex items-start gap-1.5 mb-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isAdded && onAddFund) {
                          onAddFund({ code: fund.bzdm, name: fund.jjjc });
                        }
                      }}
                      className={cn(
                        'focus:outline-none flex-shrink-0 mt-[2px]',
                        isAdded
                          ? 'text-[var(--success)] cursor-default'
                          : 'text-muted-foreground opacity-50 hover:opacity-100 hover:text-primary transition-colors cursor-pointer'
                      )}
                      disabled={isAdded}
                    >
                      {isAdded ? <CheckCircle size={16} /> : <PlusCircle size={16} />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{isAdded ? '已添加' : '添加'}</p>
                  </TooltipContent>
                </Tooltip>
                <span
                  className="font-medium text-sm whitespace-normal break-all leading-snug cursor-pointer hover:text-primary transition-colors"
                  onClick={() => setDetailFund(fund)}
                >
                  {fund.jjjc}
                </span>
              </div>
              <div className="flex items-center gap-2 pl-5 flex-wrap">
                <span className="text-xs opacity-50">#{fund.bzdm}</span>
                {isNumber(fund.feeRate) && (
                  <span className="fund-tag text-[10px] px-1 rounded-sm opacity-60 border border-current">
                    费率 {fund.feeRate.toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
          );
        }
      },
      {
        accessorKey: 'periodReturn',
        header: rankPeriodLabel ? `${rankPeriodLabel}收益` : '区间收益',
        meta: { align: 'text-right', flex: 1 },
        cell: (info) => {
          const fund = info.row.original;
          return (
            <div className="flex flex-col items-end justify-center w-full">
              <span className={cn('text-sm font-bold', getColorClass(fund.periodReturn))}>
                {formatPercent(fund.periodReturn)}
              </span>
              <span className="text-[10px] opacity-40 mt-0.5">No.{fund.displayRank}</span>
            </div>
          );
        }
      },
      {
        accessorKey: 'jzzzl',
        header: '当日涨幅',
        meta: { align: 'text-right', flex: 1 },
        cell: (info) => {
          const fund = info.row.original;
          return (
            <div className="flex flex-col items-end justify-center w-full">
              <span className={cn('text-sm font-medium', getColorClass(fund.jzzzl))}>{formatPercent(fund.jzzzl)}</span>
              <span className="text-xs opacity-50 mt-0.5">{fund.gxrq?.slice(5) || '--'}</span>
            </div>
          );
        }
      }
    ],
    [funds, onAddFund, rankPeriodLabel]
  );

  const rankTable = useTable({
    data: rankPageRows,
    columns: rankTableColumns,
    features: MARKET_TABLE_FEATURES
  });

  // 两个榜单共用同一套表格容器/样式：按 tab 切数据源、列与加载态
  const activeTable = isPerformanceTab ? rankTable : rankingTable;
  const tableLoading = isPerformanceTab ? rankLoading : rankingLoading;

  return (
    <div className="market-tab-container flex flex-col min-h-[60vh]">
      {/* 热门板块 */}
      {(sectorsLoading || (sectorEstimates && sectorEstimates.length > 0)) && (
        <div className="market-section">
          <div className="market-section-header">
            <div className="flex items-center gap-2 sm:gap-3">
              <h2 className="market-section-title whitespace-nowrap flex-shrink-0">热门板块</h2>
              <ToggleGroup
                type="single"
                value={sectorFilter}
                onValueChange={(v) => v && setSectorFilter(v)}
                className="bg-black/5 dark:bg-white/10 p-0.5 rounded-md border border-black/5 dark:border-white/5 gap-0 shadow-inner"
              >
                <ToggleGroupItem
                  value="industry"
                  className="h-6 px-2 text-[10px] rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm transition-all cursor-pointer"
                >
                  行业
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="concept"
                  className="h-6 px-2 text-[10px] rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm transition-all cursor-pointer"
                >
                  概念
                </ToggleGroupItem>
              </ToggleGroup>

              <ToggleGroup
                type="single"
                value={sectorSort}
                onValueChange={(v) => {
                  if (!v) {
                    setSectorSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
                  } else {
                    setSectorSort(v);
                    setSectorSortOrder('desc');
                  }
                }}
                className="bg-black/5 dark:bg-white/10 p-0.5 rounded-md border border-black/5 dark:border-white/5 gap-0 shadow-inner"
              >
                <ToggleGroupItem
                  value="change_pct"
                  className="h-6 px-2 text-[10px] flex items-center gap-0.5 rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm transition-all cursor-pointer"
                >
                  按涨幅
                  <span
                    style={{
                      display: 'inline-flex',
                      flexDirection: 'column',
                      lineHeight: 1,
                      fontSize: '8px',
                      transform: 'scale(0.8)',
                      transformOrigin: 'center',
                      opacity: sectorSort === 'change_pct' ? 1 : 0.3
                    }}
                  >
                    <span style={{ opacity: sectorSort === 'change_pct' && sectorSortOrder === 'asc' ? 1 : 0.3 }}>
                      ▲
                    </span>
                    <span style={{ opacity: sectorSort === 'change_pct' && sectorSortOrder === 'desc' ? 1 : 0.3 }}>
                      ▼
                    </span>
                  </span>
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="net_inflow"
                  className="h-6 px-2 text-[10px] flex items-center gap-0.5 rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm transition-all cursor-pointer"
                >
                  按资金流入
                  <span
                    style={{
                      display: 'inline-flex',
                      flexDirection: 'column',
                      lineHeight: 1,
                      fontSize: '8px',
                      transform: 'scale(0.8)',
                      transformOrigin: 'center',
                      opacity: sectorSort === 'net_inflow' ? 1 : 0.3
                    }}
                  >
                    <span style={{ opacity: sectorSort === 'net_inflow' && sectorSortOrder === 'asc' ? 1 : 0.3 }}>
                      ▲
                    </span>
                    <span style={{ opacity: sectorSort === 'net_inflow' && sectorSortOrder === 'desc' ? 1 : 0.3 }}>
                      ▼
                    </span>
                  </span>
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            <button
              className="market-section-more"
              onClick={() =>
                useModalStore.setState({
                  allSectorsModalOpen: true,
                  allSectorsFilter: sectorFilter,
                  allSectorsSort: sectorSort,
                  allSectorsSortOrder: sectorSortOrder
                })
              }
            >
              全部 <ChevronRight size={14} />
            </button>
          </div>

          <motion.div layout className="market-sector-grid">
            <AnimatePresence mode="popLayout">
              {sectorsLoading
                ? Array.from({ length: isMobile ? 4 : 10 }).map((_, i) => (
                    <motion.div
                      key={`skeleton-sector-${i}`}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={{ type: 'spring', stiffness: 250, damping: 25, mass: 1 }}
                      className="market-sector-card glass"
                    >
                      <div className="market-sector-main items-center mt-0.5">
                        <Skeleton className="h-5 w-16" />
                        <Skeleton className="h-4 w-12" />
                      </div>
                      <div className="market-sector-leader flex items-center mt-1 h-[18px]">
                        <Skeleton className="h-3 w-20" />
                      </div>
                    </motion.div>
                  ))
                : filteredAndSortedSectors?.map((sector) => {
                    const pctStr = sector.change_pct != null ? String(sector.change_pct) : '0.00';
                    const pctNum = parseFloat(pctStr);
                    const isUp = pctNum > 0;
                    const isDown = pctNum < 0;

                    return (
                      <motion.div
                        layout
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        transition={{ type: 'spring', stiffness: 250, damping: 25, mass: 1 }}
                        key={sector.id || sector.sector_id}
                        className="market-sector-card glass"
                      >
                        <div className="market-sector-main">
                          <span className="market-sector-name">{sector.sector_name}</span>
                          {sectorSort === 'change_pct' ? (
                            <span className={cn('market-sector-pct', getColorClass(pctStr))}>
                              {formatPercent(pctStr)}
                            </span>
                          ) : (
                            <span className={cn('market-sector-pct', getColorClass(sector.net_inflow))}>
                              {sector.net_inflow ? (sector.net_inflow / 100000000).toFixed(2) + '亿' : '--'}
                            </span>
                          )}
                        </div>
                        <div className="market-sector-leader">
                          {sectorSort === 'change_pct' ? (
                            <>
                              资金流入: {sector.net_inflow ? (sector.net_inflow / 100000000).toFixed(2) + '亿' : '--'}
                            </>
                          ) : (
                            <>
                              涨跌幅: <span className={getColorClass(pctStr)}>{formatPercent(pctStr)}</span>
                            </>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
            </AnimatePresence>
          </motion.div>
        </div>
      )}

      {/* 榜单栏 */}
      <div className="market-ranking-section glass" id="market-ranking-section">
        <div className="market-ranking-tabs" style={{ padding: '8px 12px' }}>
          <div className="tabs-container">
            <div className="tabs-scroll-area">
              <div className="tabs">
                <AnimatePresence mode="popLayout">
                  <motion.button
                    layout
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    key="increase"
                    className={cn('tab', activeTab === 'increase' && 'active')}
                    onClick={() => {
                      setActiveTab('increase');
                      setPageIndex(1);
                    }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30, mass: 1 }}
                  >
                    估值涨幅
                  </motion.button>
                  <motion.button
                    layout
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    key="decrease"
                    className={cn('tab', activeTab === 'decrease' && 'active')}
                    onClick={() => {
                      setActiveTab('decrease');
                      setPageIndex(1);
                    }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30, mass: 1 }}
                  >
                    估值跌幅
                  </motion.button>
                  <motion.button
                    layout
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    key="deviation"
                    className={cn('tab', activeTab === 'deviation' && 'active')}
                    onClick={() => {
                      setActiveTab('deviation');
                      setPageIndex(1);
                    }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30, mass: 1 }}
                  >
                    估值偏差
                  </motion.button>
                  <motion.button
                    layout
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    key="actual"
                    className={cn('tab', activeTab === 'actual' && 'active')}
                    onClick={() => {
                      setActiveTab('actual');
                      setPageIndex(1);
                    }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30, mass: 1 }}
                  >
                    实际涨幅
                  </motion.button>
                  <motion.button
                    layout
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    key="performance"
                    className={cn('tab', activeTab === 'performance' && 'active')}
                    onClick={() => {
                      setActiveTab('performance');
                      setRankPage(1);
                    }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30, mass: 1 }}
                  >
                    业绩排行
                  </motion.button>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>

        {/* 业绩排行：分类 / 区间 / 排序（全部本地切换，上游无排序分页参数） */}
        {isPerformanceTab && (
          <div className="flex flex-col gap-1.5 px-3 pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                type="single"
                value={rankSymbol}
                onValueChange={(v) => v && setRankSymbol(v)}
                className="bg-black/5 dark:bg-white/10 p-0.5 rounded-md border border-black/5 dark:border-white/5 gap-0 shadow-inner flex-shrink-0"
              >
                {RANK_SYMBOLS.map((symbol) => (
                  <ToggleGroupItem
                    key={symbol}
                    value={symbol}
                    className="h-6 px-2 text-[10px] rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm transition-all cursor-pointer whitespace-nowrap"
                  >
                    {symbol}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                type="single"
                value={rankPeriod}
                onValueChange={(v) => v && setRankPeriod(v)}
                className="bg-black/5 dark:bg-white/10 p-0.5 rounded-md border border-black/5 dark:border-white/5 gap-0 shadow-inner flex-shrink-0"
              >
                {RANK_PERIODS.map((period) => (
                  <ToggleGroupItem
                    key={period.key}
                    value={period.key}
                    className="h-6 px-2 text-[10px] rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm transition-all cursor-pointer whitespace-nowrap"
                  >
                    {period.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <button
                onClick={() => setRankOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
                className="flex items-center gap-0.5 h-7 px-2 rounded-md text-[10px] text-muted-foreground hover:text-foreground border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/10 transition-colors flex-shrink-0 cursor-pointer"
              >
                {rankOrder === 'desc' ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                {rankOrder === 'desc' ? '收益从高到低' : '收益从低到高'}
              </button>
            </div>
            <div className="text-[11px] opacity-60 leading-tight">
              {rankLoading
                ? `正在拉取「${rankSymbol}」全市场排行，首次约 1~8 秒（全量接口，无分页参数）…`
                : rankError
                  ? `排行加载失败：${rankError.message}`
                  : rankSortedRows.length > 0
                    ? `共 ${rankSortedRows.length} 只 · 净值日期 ${rankData?.dataDate || '--'}${rankData?.fromCache ? ' · 本地缓存' : ''}`
                    : '暂无数据'}
            </div>
          </div>
        )}

        {!isPerformanceTab && (
          <div className="text-[11px] opacity-60 leading-tight px-3 pb-2">
            {rankingLoading
              ? '正在加载全市场估值表（一次整表，首次约 3~4 秒）…'
              : rankingError
                ? `榜单加载失败：${rankingError.message}`
                : rankingAllRecords > 0
                  ? `共 ${rankingAllRecords} 只 · 净值日期 ${rankingPage?.Data?.dataDate || '--'}${activeTab === 'deviation' ? ' · 按估算偏差排序' : ''}`
                  : '暂无数据'}
          </div>
        )}

        <div className="pc-fund-table" style={{ width: '100%', overflow: 'hidden' }}>
          <style>{`
            .market-ranking-table-row {
              display: flex !important;
              width: 100%;
              gap: 0 !important;
              padding: 12px 16px !important;
              --row-bg: var(--bg);
              background-color: var(--row-bg) !important;
              transition: background-color 0.15s ease;
              cursor: default;
              border-bottom: none !important;
            }
            @media (min-width: 640px) {
              .market-ranking-table-row:hover,
              .market-ranking-table-row.row-even:hover {
                --row-bg: var(--table-row-hover-bg);
                background-color: var(--table-row-hover-bg) !important;
              }
            }
            .market-ranking-table-row:nth-child(even),
            .market-ranking-table-row.row-even {
              background-color: var(--table-row-alt-bg) !important;
            }
            .market-ranking-table-header {
              display: flex !important;
              width: 100%;
              gap: 0 !important;
              padding: 12px 16px !important;
              background: rgba(255, 255, 255, 0.05);
              border-bottom: 1px solid var(--border);
            }
            [data-theme="light"] .market-ranking-table-header {
              background: rgba(0, 0, 0, 0.04) !important;
            }
          `}</style>

          {activeTable.getHeaderGroups().map((hg) => (
            <div key={hg.id} className="table-header-row market-ranking-table-header">
              {hg.headers.map((header) => {
                const align = header.column.columnDef.meta?.align || 'text-center';
                const flex = header.column.columnDef.meta?.flex || 1;
                const isRight = align === 'text-right';

                return (
                  <div
                    key={header.id}
                    className={`table-header-cell ${align}`}
                    style={{
                      flex,
                      padding: '0 8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: isRight ? 'flex-end' : 'flex-start'
                    }}
                  >
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: '0.5px'
                      }}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          <div className="market-ranking-list">
            {tableLoading ? (
              Array.from({ length: 10 }).map((_, index) => (
                <div
                  key={`skeleton-ranking-${index}`}
                  className={`table-row market-ranking-table-row ${index % 2 === 1 ? 'row-even' : ''}`}
                >
                  <div
                    className="table-cell text-left"
                    style={{ flex: 2, padding: '0 8px', display: 'flex', alignItems: 'center' }}
                  >
                    <div className="w-full">
                      <div className="flex items-center gap-1.5 mb-1.5 mt-0.5">
                        <Skeleton className="size-4 rounded-full flex-shrink-0" />
                        <Skeleton className="h-[18px] w-28 sm:w-40" />
                      </div>
                      <div className="flex items-center gap-2 pl-5">
                        <Skeleton className="h-3 w-12" />
                        <Skeleton className="h-[14px] w-8" />
                      </div>
                    </div>
                  </div>
                  <div
                    className="table-cell text-right"
                    style={{
                      flex: 1,
                      padding: '0 8px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-end',
                      justifyContent: 'center',
                      gap: '4px'
                    }}
                  >
                    <Skeleton className="h-[18px] w-14 sm:w-16" />
                    <Skeleton className="h-3 w-10 sm:w-12" />
                  </div>
                  <div
                    className="table-cell text-right"
                    style={{
                      flex: 1,
                      padding: '0 8px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-end',
                      justifyContent: 'center'
                    }}
                  >
                    <Skeleton className="h-[18px] w-14 sm:w-16" />
                  </div>
                </div>
              ))
            ) : activeTable.getRowModel().rows.length > 0 ? (
              activeTable.getRowModel().rows.map((row, index) => (
                <div key={row.id} className={`table-row market-ranking-table-row ${index % 2 === 1 ? 'row-even' : ''}`}>
                  {row.getVisibleCells().map((cell) => {
                    const align = cell.column.columnDef.meta?.align || 'text-center';
                    const flex = cell.column.columnDef.meta?.flex || 1;
                    const isRight = align === 'text-right';

                    return (
                      <div
                        key={cell.id}
                        className={`table-cell ${align}`}
                        style={{
                          flex,
                          padding: '0 8px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: isRight ? 'flex-end' : 'flex-start'
                        }}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    );
                  })}
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-sm opacity-50">暂无数据</div>
            )}
          </div>

          <div className="py-5 flex justify-end border-t border-[var(--border)] pr-4">
            {isPerformanceTab ? (
              <div className="flex items-center gap-2 text-xs">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={rankSafePage <= 1 || rankLoading}
                  onClick={() => {
                    setRankPage(rankSafePage - 1);
                    scrollToRankingSection();
                  }}
                >
                  上一页
                </Button>
                <span className="opacity-60 tabular-nums">
                  {rankSafePage} / {rankTotalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={rankSafePage >= rankTotalPages || rankLoading}
                  onClick={() => {
                    setRankPage(rankSafePage + 1);
                    scrollToRankingSection();
                  }}
                >
                  下一页
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={pageIndex <= 1 || rankingLoading}
                  onClick={() => {
                    const next = Math.max(1, pageIndex - 1);
                    setPageIndex(next);
                    scrollToRankingSection();
                  }}
                >
                  上一页
                </Button>
                <span className="opacity-60 tabular-nums">
                  {pageIndex} / {rankingTotalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={pageIndex >= rankingTotalPages || rankingLoading}
                  onClick={() => {
                    const next = Math.min(rankingTotalPages, pageIndex + 1);
                    setPageIndex(next);
                    scrollToRankingSection();
                  }}
                >
                  下一页
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* 基金详情弹框 */}
      {(() => {
        const mappedFund = detailFund
          ? {
              code: detailFund.bzdm,
              name: detailFund.jjjc,
              dwjz: detailFund.dwjz === '---' || !detailFund.dwjz ? null : detailFund.dwjz,
              gsz: detailFund.gsz === '---' || !detailFund.gsz ? null : detailFund.gsz,
              gszzl: !isNaN(parseFloat(detailFund.gszzl)) ? parseFloat(detailFund.gszzl) : null,
              gztime: detailFund.gztime || null,
              jzrq: detailFund.gxrq || detailFund.jzrq || null,
              zzl: !isNaN(parseFloat(detailFund.jzzzl)) ? parseFloat(detailFund.jzzzl) : null,
              fundExtraData: detailFundExtra
            }
          : null;

        const detailCardProps = mappedFund && getFundCardProps ? getFundCardProps({ rawFund: mappedFund }) : null;

        return (
          detailFund &&
          detailCardProps &&
          (isMobile ? (
            <MobileFundCardDrawer
              open={!!detailFund}
              onOpenChange={(open) => !open && setDetailFund(null)}
              getFundCardProps={() => detailCardProps}
              cardSheetRow={mappedFund}
            />
          ) : (
            <FundDetailDialog
              cardDialogRow={mappedFund}
              getFundCardProps={() => detailCardProps}
              setCardDialogRow={(row) => setDetailFund(row)}
            />
          ))
        );
      })()}
    </div>
  );
}
