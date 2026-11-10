'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import lodash from 'lodash';
import {
  AlertCircle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Newspaper,
  RefreshCw
} from 'lucide-react';

import { fetchMarketFlash, fetchFinanceBreakfast, fetchCaixinHighlights, fetchCctvNews } from '../api/fund';
import { AKTOOLS_NEWS_SOURCES, AKTOOLS_NEWS_IMPORTANT_VIEW } from '@/app/providers/aktools';
import {
  formatNewsTime,
  formatRelativeTime,
  formatClock,
  formatTimeOfDay,
  groupFlashByDate,
  shouldCollapseText,
  splitTitleAndBody
} from '../lib/newsFeed';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia } from '@/components/ui/empty';
import { Button } from '@/components/ui/button';

const { isArray } = lodash;

/**
 * 快讯页（一级 tab，与首页/行情同级）。
 *
 * 数据全部来自 AKTools 的三方资讯接口（8 个），三层结构：
 *   快讯 —— 财联社/东财/新浪/同花顺/富途 5 源合并去重后的时间流
 *   精选 —— 财经早餐 + 财新数据通精选（低频长文）
 *   联播 —— 新闻联播文字稿（按日期取单日）
 *
 * 缓存策略：
 *   - 只走 TanStack 内存缓存，**不落 localStorage / IndexedDB** —— 资讯时效性太强，
 *     落盘只会留下一堆过期条目，还白占配额；
 *   - 手动刷新通过 `force` 穿透 Provider 的 60s 内存缓存（见 fund.js 的 fetchMarketFlash），
 *     否则 60 秒内点刷新会「什么都没发生」。
 */

/** 子 tab */
const SUB_TABS = [
  { id: 'flash', label: '快讯' },
  { id: 'pick', label: '精选' },
  { id: 'cctv', label: '联播' }
];

/** 源筛选 chips：「全部」+「重点电报」+ 5 个源 */
const SOURCE_CHIPS = [
  { id: 'all', label: '全部' },
  { id: 'important', label: AKTOOLS_NEWS_IMPORTANT_VIEW.label },
  ...AKTOOLS_NEWS_SOURCES.map((s) => ({ id: s.id, label: s.label }))
];

/** 自动刷新可选间隔（毫秒）；0 = 关闭 */
const AUTO_REFRESH_OPTIONS = [
  { value: 0, label: '关' },
  { value: 30 * 1000, label: '30s' },
  { value: 60 * 1000, label: '60s' }
];

const pad2 = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DD'（本地时区，新闻联播按北京日期取） */
const toDateInputValue = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/** 在给定日期上偏移 n 天 */
const shiftDate = (value, days) => {
  const [y, m, d] = String(value).split('-').map(Number);
  const base = new Date(y, (m || 1) - 1, d || 1);
  base.setDate(base.getDate() + days);
  return toDateInputValue(base);
};

/** 顶部提示条：单源失败时只降级该源 */
function NewsAlert({ failed, onRetry }) {
  if (!isArray(failed) || failed.length === 0) return null;
  const labels = failed.map((f) => f.sourceLabel || f.source).join('、');
  return (
    <div className="news-alert" role="status">
      <AlertCircle size={14} aria-hidden />
      <span className="news-alert-text">{labels} 暂时不可用</span>
      <button type="button" className="news-alert-retry" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

function NewsEmpty({ title, description, onRetry }) {
  return (
    <Empty className="news-empty">
      <EmptyMedia variant="icon">
        <Newspaper />
      </EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      {onRetry ? (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onRetry}>
            重试
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

function NewsSkeleton({ rows = 6 }) {
  return (
    <div className="news-feed news-feed--loading" aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="news-item" key={i}>
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/**
 * 单条快讯。
 *
 * 版式：元信息行（时间 · 来源 · 相对时间 · 原文）→ 标题 → 正文 → 展开。
 * 相比早期「左侧时间轴 + 右侧正文」的写法，这里取消了 44px 的时间列和竖线：
 * 中文正文在窄列里会被挤成很碎的短行，而时间放上行首更容易扫读，也省下 60px 的行宽。
 */
function FlashItem({ item }) {
  const [expanded, setExpanded] = useState(false);
  const { title, body } = splitTitleAndBody(item);
  const collapsible = shouldCollapseText(body, 160);

  return (
    <article className={`news-item ${item.important ? 'is-important' : ''}`}>
      <div className="news-item-meta">
        <time className="news-item-clock" dateTime={item.publishedAt || undefined}>
          {formatTimeOfDay(item.publishedAt)}
        </time>
        <span className="news-source">{item.sourceLabel}</span>
        {item.important ? <span className="news-important">重要</span> : null}
        <span className="news-item-relative">{formatRelativeTime(item.publishedAt)}</span>
        {item.url ? (
          <a className="news-link" href={item.url} target="_blank" rel="noopener noreferrer">
            原文
            <ExternalLink size={11} aria-hidden />
          </a>
        ) : null}
      </div>
      {title ? <h3 className="news-item-title">{title}</h3> : null}
      {body ? <p className={`news-item-text ${expanded || !collapsible ? '' : 'is-clamped'}`}>{body}</p> : null}
      {collapsible ? (
        <button type="button" className="news-expand" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? '收起' : '展开'}
        </button>
      ) : null}
    </article>
  );
}

function FlashList({ data, loading, onRetry }) {
  if (loading) return <NewsSkeleton rows={6} />;

  if (!data || data.allFailed) {
    return (
      <NewsEmpty
        title="资讯源暂时不可用"
        description="AKTools 服务未返回数据，可稍后重试或检查服务地址配置"
        onRetry={onRetry}
      />
    );
  }

  if (!isArray(data.items) || data.items.length === 0) {
    return <NewsEmpty title="暂无快讯" description="当前筛选条件下没有内容，换个源或稍后再看" onRetry={onRetry} />;
  }

  // 按自然日切段：几百条的连续列表没有日期锚点，往回翻时很快就会失去时间概念
  const groups = groupFlashByDate(data.items);
  return (
    <div className="news-feed">
      {groups.map((group) => (
        <section className="news-group" key={group.key} aria-label={group.label}>
          <div className="news-date-divider">
            <span className="news-date-label">{group.label}</span>
          </div>
          {group.items.map((item) => (
            <FlashItem key={item.id} item={item} />
          ))}
        </section>
      ))}
    </div>
  );
}

/** 精选卡片：财经早餐 / 财新精选共用的列表壳（空态由调用方在 children 里给出） */
function PickCard({ icon, title, hint, loading, error, children }) {
  return (
    <section className="news-pick-card glass">
      <header className="news-pick-head">
        <span className="news-pick-icon" aria-hidden>
          {icon}
        </span>
        <h3 className="news-pick-title">{title}</h3>
        {hint ? <span className="news-pick-hint">{hint}</span> : null}
      </header>
      {loading ? (
        <div className="news-pick-list">
          {Array.from({ length: 4 }).map((_, i) => (
            <div className="news-pick-item" key={i}>
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          ))}
        </div>
      ) : error ? (
        <p className="news-pick-empty">{error}</p>
      ) : (
        children
      )}
    </section>
  );
}

export default function NewsTab({ isActive }) {
  const queryClient = useQueryClient();

  const [subTab, setSubTab] = useState('flash');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [cctvDate, setCctvDate] = useState(() => toDateInputValue(new Date()));
  const [breakfastExpanded, setBreakfastExpanded] = useState(false);

  /**
   * 手动刷新的「穿透缓存」标记。
   *
   * 按 key 分开记录而不是一个布尔量：精选 tab 会同时持有早餐 + 财新两个 query，
   * 共用一个标记时只有一个能拿到 force，另一个仍然读缓存。
   * queryFn 取用后立刻复位，避免把后续的自动刷新也变成穿透。
   */
  const forceRef = useRef({ flash: false, breakfast: false, caixin: false, cctv: false });
  const consumeForce = useCallback((key) => {
    const flag = forceRef.current[key] === true;
    forceRef.current[key] = false;
    return flag;
  }, []);

  const flashQuery = useQuery({
    queryKey: ['marketFlash', sourceFilter],
    queryFn: () => fetchMarketFlash({ sources: sourceFilter, force: consumeForce('flash') }),
    enabled: !!isActive && subTab === 'flash',
    staleTime: 60 * 1000,
    // 自动刷新只在快讯 tab 生效；refetchIntervalInBackground 保持默认 false，
    // 标签页不可见时 TanStack 会自行暂停，不必手写 visibilitychange
    refetchInterval: autoRefreshMs > 0 && !!isActive && subTab === 'flash' ? autoRefreshMs : false
  });

  const breakfastQuery = useQuery({
    queryKey: ['financeBreakfast'],
    queryFn: () => fetchFinanceBreakfast({ force: consumeForce('breakfast'), limit: 50 }),
    enabled: !!isActive && subTab === 'pick',
    staleTime: 6 * 60 * 60 * 1000
  });

  const caixinQuery = useQuery({
    queryKey: ['caixinHighlights'],
    queryFn: () => fetchCaixinHighlights({ force: consumeForce('caixin') }),
    enabled: !!isActive && subTab === 'pick',
    staleTime: 60 * 60 * 1000
  });

  const cctvQuery = useQuery({
    queryKey: ['cctvNews', cctvDate],
    queryFn: () => fetchCctvNews(cctvDate, { force: consumeForce('cctv') }),
    enabled: !!isActive && subTab === 'cctv',
    staleTime: 24 * 60 * 60 * 1000
  });

  const handleRefresh = useCallback(() => {
    forceRef.current.flash = true;
    forceRef.current.breakfast = true;
    forceRef.current.caixin = true;
    forceRef.current.cctv = true;
    queryClient.refetchQueries({ queryKey: ['marketFlash'] });
    queryClient.refetchQueries({ queryKey: ['financeBreakfast'] });
    queryClient.refetchQueries({ queryKey: ['caixinHighlights'] });
    queryClient.refetchQueries({ queryKey: ['cctvNews'] });
  }, [queryClient]);

  const flashData = flashQuery.data;
  const failedSources = flashData?.failed || [];

  /** 「更新于」取当前可见 tab 的最近一次成功取数时间 */
  const updatedAt = useMemo(() => {
    const candidates = [
      flashQuery.dataUpdatedAt,
      breakfastQuery.dataUpdatedAt,
      caixinQuery.dataUpdatedAt,
      cctvQuery.dataUpdatedAt
    ]
      .filter((t) => typeof t === 'number' && t > 0)
      .sort((a, b) => b - a);
    return candidates[0] || 0;
  }, [flashQuery.dataUpdatedAt, breakfastQuery.dataUpdatedAt, caixinQuery.dataUpdatedAt, cctvQuery.dataUpdatedAt]);

  const breakfastItems = breakfastQuery.data?.items || [];
  const breakfastVisible = breakfastExpanded ? breakfastItems : breakfastItems.slice(0, 10);
  const caixinItems = caixinQuery.data?.items || [];

  const flashCountText = useMemo(() => {
    // 全部源失败时 total=0，显示「共 0 条」纯属噪音，交给下方的空态说明
    if (!flashData || flashData.total <= 0) return '';
    const parts = [`共 ${flashData.total} 条`];
    if (flashData.removed > 0) parts.push(`去重 ${flashData.removed} 条`);
    return parts.join(' · ');
  }, [flashData]);

  const today = toDateInputValue(new Date());
  const isToday = cctvDate === today;

  return (
    <div className="news-page flex flex-col min-h-[60vh]">
      <header className="news-header">
        <div className="news-header-main">
          <h2 className="news-page-title">市场快讯</h2>
          <span className="news-page-sub">AKTools · 财联社 / 东财 / 新浪 / 同花顺 / 富途</span>
        </div>
        <div className="news-header-actions">
          <span className="news-updated" title="最近一次成功取数时间">
            <Clock size={12} aria-hidden />
            更新于 {updatedAt ? formatClock(updatedAt) : '—'}
          </span>
          <div className="news-auto-refresh" role="group" aria-label="自动刷新间隔">
            {AUTO_REFRESH_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`news-auto-chip ${autoRefreshMs === opt.value ? 'is-active' : ''}`}
                onClick={() => setAutoRefreshMs(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="news-refresh-btn"
            onClick={handleRefresh}
            aria-label="刷新快讯"
            disabled={
              flashQuery.isFetching || breakfastQuery.isFetching || caixinQuery.isFetching || cctvQuery.isFetching
            }
          >
            <RefreshCw
              size={14}
              aria-hidden
              className={
                flashQuery.isFetching || breakfastQuery.isFetching || caixinQuery.isFetching || cctvQuery.isFetching
                  ? 'news-spin'
                  : ''
              }
            />
          </button>
        </div>
      </header>

      <ToggleGroup type="single" value={subTab} onValueChange={(v) => v && setSubTab(v)} className="news-tabs">
        {SUB_TABS.map((tab) => (
          <ToggleGroupItem key={tab.id} value={tab.id} className="news-tab">
            {tab.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {subTab === 'flash' && (
        <>
          <div className="news-chips" role="group" aria-label="快讯来源">
            {SOURCE_CHIPS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className={`news-chip ${sourceFilter === chip.id ? 'is-active' : ''}`}
                onClick={() => setSourceFilter(chip.id)}
                aria-pressed={sourceFilter === chip.id}
              >
                {chip.label}
              </button>
            ))}
            {flashCountText ? <span className="news-count">{flashCountText}</span> : null}
          </div>

          <NewsAlert failed={failedSources} onRetry={handleRefresh} />

          <FlashList data={flashData} loading={flashQuery.isLoading} onRetry={handleRefresh} />
        </>
      )}

      {subTab === 'pick' && (
        <div className="news-pick-grid">
          <PickCard
            icon={<CalendarDays size={15} />}
            title="财经早餐"
            hint="东财 · 每日"
            loading={breakfastQuery.isLoading}
            error={breakfastQuery.isError || breakfastQuery.data === null ? '早餐数据暂不可用' : null}
          >
            {breakfastVisible.length > 0 ? (
              <>
                <ul className="news-pick-list">
                  {breakfastVisible.map((item) => (
                    <li className="news-pick-item" key={item.id}>
                      {item.url ? (
                        <a href={item.url} target="_blank" rel="noopener noreferrer" className="news-pick-link">
                          {item.title}
                          <ExternalLink size={11} aria-hidden className="news-pick-ext" />
                        </a>
                      ) : (
                        <span className="news-pick-link">{item.title}</span>
                      )}
                      <span className="news-pick-meta">
                        {item.publishedAt
                          ? formatNewsTime(item.publishedAt)
                          : `第 ${breakfastItems.indexOf(item) + 1} 期`}
                      </span>
                    </li>
                  ))}
                </ul>
                {breakfastItems.length > 10 ? (
                  <button
                    type="button"
                    className="news-expand news-expand--block"
                    onClick={() => setBreakfastExpanded((v) => !v)}
                  >
                    {breakfastExpanded ? '收起' : `查看全部 ${breakfastItems.length} 期`}
                  </button>
                ) : null}
              </>
            ) : (
              <p className="news-pick-empty">暂无早餐数据</p>
            )}
          </PickCard>

          <PickCard
            icon={<Newspaper size={15} />}
            title="财新精选"
            hint="财新数据通"
            loading={caixinQuery.isLoading}
            error={caixinQuery.isError || caixinQuery.data === null ? '财新数据暂不可用' : null}
          >
            {caixinItems.length > 0 ? (
              <ul className="news-pick-list">
                {caixinItems.slice(0, 20).map((item) => (
                  <li className="news-pick-item" key={item.id}>
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noopener noreferrer" className="news-pick-link">
                        {item.summary || item.title}
                        <ExternalLink size={11} aria-hidden className="news-pick-ext" />
                      </a>
                    ) : (
                      <span className="news-pick-link">{item.summary || item.title}</span>
                    )}
                    {item.tag ? <span className="news-tag">{item.tag}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="news-pick-empty">暂无精选内容</p>
            )}
          </PickCard>
        </div>
      )}

      {subTab === 'cctv' && (
        <>
          <div className="news-cctv-bar">
            <button
              type="button"
              className="news-cctv-nav"
              onClick={() => setCctvDate((d) => shiftDate(d, -1))}
              aria-label="前一天"
            >
              <ChevronLeft size={16} aria-hidden />
            </button>
            <input
              type="date"
              className="news-cctv-date"
              value={cctvDate}
              max={today}
              onChange={(e) => e.target.value && setCctvDate(e.target.value)}
              aria-label="选择日期"
            />
            <button
              type="button"
              className="news-cctv-nav"
              onClick={() => setCctvDate((d) => shiftDate(d, 1))}
              disabled={isToday}
              aria-label="后一天"
            >
              <ChevronRight size={16} aria-hidden />
            </button>
          </div>

          {cctvQuery.isLoading ? (
            <NewsSkeleton rows={3} />
          ) : cctvQuery.isError || cctvQuery.data === null ? (
            <NewsEmpty title="联播文字稿暂不可用" description="可换个日期重试" onRetry={handleRefresh} />
          ) : !isArray(cctvQuery.data?.items) || cctvQuery.data.items.length === 0 ? (
            <NewsEmpty title="当日无新闻联播文字稿" description="周末与节假日可能没有更新" />
          ) : (
            <div className="news-cctv-list">
              {cctvQuery.data.items.map((item) => (
                <article className="news-article" key={item.id}>
                  <h3 className="news-article-title">{item.title}</h3>
                  {item.content ? <p className="news-article-body">{item.content}</p> : null}
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
