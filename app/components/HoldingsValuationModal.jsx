'use client';

import { useMemo, useState } from 'react';
import { isArray, isNil, isNumber } from 'lodash';
import { ChevronDown, ChevronUp, Loader2, RefreshCw } from 'lucide-react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

import { useHoldingsValuation, invalidateHoldingsValuation } from '@/app/hooks/useHoldingsValuation';

/**
 * 格式化指标数值。null/非数 → '—'
 */
function formatMetric(value, { suffix = '', digits = 2, signed = false } = {}) {
  if (isNil(value)) return '—';
  const n = isNumber(value) ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = signed && n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}${suffix}`;
}

/**
 * 格式化权重百分比（5.23 → "5.23%"）
 */
function formatPercent(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/**
 * 把东财时间戳（秒）转 "YYYY-MM-DD HH:mm"
 */
function formatTimestamp(ts) {
  if (!ts) return '';
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n > 1e12 ? n : n * 1000);
  if (isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const METRIC_CARDS = [
  {
    key: 'pe',
    label: '穿透 PE',
    hint: 'E/P 加权倒数法',
    format: (v) => formatMetric(v, { digits: 2 })
  },
  {
    key: 'pb',
    label: '穿透 PB',
    hint: '持仓加权',
    format: (v) => formatMetric(v, { digits: 2 })
  },
  {
    key: 'ps',
    label: '穿透 PS',
    hint: '持仓加权',
    format: (v) => formatMetric(v, { digits: 2 })
  },
  {
    key: 'peg',
    label: '穿透 PEG',
    hint: '持仓加权',
    format: (v) => formatMetric(v, { digits: 2 })
  },
  {
    key: 'epsGrowth',
    label: '净利润增速',
    hint: '持仓加权 %',
    format: (v) => formatMetric(v, { suffix: '%', digits: 2, signed: true })
  },
  {
    key: 'dividendYield',
    label: '股息率',
    hint: '持仓加权 %',
    format: (v) => formatMetric(v, { suffix: '%', digits: 2 })
  }
];

export default function HoldingsValuationModal({ fundCode, fundName, onClose }) {
  const { data, isLoading, isFetching, isError, error, refetch } = useHoldingsValuation(fundCode);
  const [showDetail, setShowDetail] = useState(false);

  const handleRefresh = async () => {
    invalidateHoldingsValuation(fundCode);
    try {
      await refetch();
    } catch (e) {}
  };

  return (
    <Dialog open={true} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="max-w-2xl max-h-[88vh] flex flex-col p-0">
        <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-between gap-3 pr-8">
            <div className="flex flex-col gap-1 min-w-0">
              <DialogTitle className="text-base font-semibold text-[var(--text)] truncate">持仓穿透估值</DialogTitle>
              <div className="flex items-center gap-2 text-[12px] text-[var(--muted)] truncate">
                <span className="font-medium text-[var(--text)] truncate">{fundName || fundCode}</span>
                {fundCode && <span className="opacity-70">({fundCode})</span>}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              disabled={isLoading || isFetching}
              className="h-8 px-2 text-[var(--muted)] hover:text-[var(--text)]"
              aria-label="刷新"
            >
              <RefreshCw className={isLoading || isFetching ? 'animate-spin' : ''} width="14" height="14" />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 scrollbar-y-styled">
          {isLoading && !data ? (
            <LoadingState />
          ) : isError && !data ? (
            <ErrorState error={error} onRetry={handleRefresh} />
          ) : data ? (
            <ResultBody data={data} showDetail={showDetail} setShowDetail={setShowDetail} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-[var(--muted)]">
      <Loader2 className="animate-spin" width="28" height="28" />
      <span className="text-[13px]">正在拉取单股基本面...</span>
    </div>
  );
}

function ErrorState({ error, onRetry }) {
  const msg = error?.message || '数据加载失败';
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-[var(--muted)]">
      <span className="text-[13px] text-center px-4">{msg}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

function ResultBody({ data, showDetail, setShowDetail }) {
  const {
    holdingsReportDate,
    holdingsIsLastQuarter,
    coveredWeight,
    skippedWeight,
    uncoveredWeight,
    skippedDetails,
    metrics,
    perStock,
    updateTime
  } = data;

  const hasMetrics = metrics != null;
  const hasHoldings = isArray(perStock) && perStock.length > 0;

  if (!hasHoldings && skippedWeight >= 100) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-[var(--muted)]">
        <span className="text-[13px]">该基金无 A 股持仓，无法穿透估值</span>
        {holdingsReportDate && <span className="text-[11px]">最近报告期：{holdingsReportDate}</span>}
      </div>
    );
  }

  const skippedForeign = (skippedDetails || []).filter((x) => x.reason === 'foreign');
  const skippedFailed = (skippedDetails || []).filter((x) => x.reason === 'fetch_failed');

  return (
    <div className="flex flex-col gap-4">
      {!holdingsIsLastQuarter && holdingsReportDate && (
        <div
          style={{
            background: 'color-mix(in srgb, #f59e0b 14%, transparent)',
            border: '1px solid color-mix(in srgb, #f59e0b 40%, transparent)',
            color: '#b45309',
            padding: '8px 12px',
            borderRadius: '8px',
            fontSize: '12px'
          }}
        >
          持仓报告期已过期（{holdingsReportDate}），数据仅供参考
        </div>
      )}

      {/* 穿透覆盖率 */}
      <CoverageBar
        covered={coveredWeight}
        foreign={skippedForeign.reduce((acc, x) => acc + (x.weight || 0), 0)}
        failed={skippedFailed.reduce((acc, x) => acc + (x.weight || 0), 0)}
        uncovered={uncoveredWeight}
      />

      {/* 6 个指标卡片（2x3 网格） */}
      {hasMetrics ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: '10px'
          }}
        >
          {METRIC_CARDS.map((m) => (
            <MetricCard
              key={m.key}
              label={m.label}
              hint={m.hint}
              display={m.format(metrics[m.key])}
              value={metrics[m.key]}
            />
          ))}
        </div>
      ) : (
        <div className="text-center text-[var(--muted)] text-[13px] py-4">暂无可用指标（A 股部分未拿到 PE 数据）</div>
      )}

      {/* 明细折叠区 */}
      {hasHoldings && (
        <div className="border border-[var(--border)] rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => setShowDetail(!showDetail)}
            className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left cursor-pointer hover:bg-[var(--secondary)]/40 transition-colors"
          >
            <span className="text-[13px] font-medium text-[var(--text)]">查看明细（共 {perStock.length} 只 A 股）</span>
            {showDetail ? <ChevronUp width="16" height="16" /> : <ChevronDown width="16" height="16" />}
          </button>
          {showDetail && <DetailTable perStock={perStock} />}
        </div>
      )}

      {/* 数据来源 */}
      <div className="text-[11px] text-[var(--muted)] text-center pt-2 border-t border-[var(--border)]">
        数据来源：东方财富 push2 单股基本面 · PE 用 E/P 加权倒数法 · 其他指标直接加权
        {updateTime && <span className="opacity-70"> · 更新于 {formatTimestamp(updateTime)}</span>}
      </div>
    </div>
  );
}

function MetricCard({ label, hint, display, value }) {
  const isPositive = isNumber(value) && value > 0;
  const isNegative = isNumber(value) && value < 0;
  const color = label.includes('增速')
    ? isPositive
      ? 'var(--up)'
      : isNegative
        ? 'var(--down)'
        : 'var(--text)'
    : 'var(--text)';

  return (
    <div
      style={{
        background: 'color-mix(in srgb, var(--card) 80%, transparent)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px'
      }}
    >
      <span style={{ fontSize: '11px', color: 'var(--muted)', lineHeight: 1.3 }}>{label}</span>
      <span
        style={{
          fontSize: '20px',
          fontWeight: 700,
          color,
          lineHeight: 1.2,
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {display}
      </span>
      {hint && <span style={{ fontSize: '10px', color: 'var(--muted)', opacity: 0.7, lineHeight: 1.2 }}>{hint}</span>}
    </div>
  );
}

function CoverageBar({ covered, foreign, failed, uncovered }) {
  const total = (covered || 0) + (foreign || 0) + (failed || 0) + (uncovered || 0);
  if (total <= 0) return null;
  const segments = [
    { value: covered, color: 'var(--up)', label: 'A 股穿透' },
    { value: foreign, color: 'var(--muted)', label: '港美股' },
    { value: failed, color: '#ef4444', label: '拉取失败' },
    { value: uncovered, color: 'rgba(148, 163, 184, 0.5)', label: '未披露剩余' }
  ].filter((s) => s.value > 0);

  return (
    <div className="flex flex-col gap-2">
      <div
        style={{
          display: 'flex',
          height: '8px',
          borderRadius: '999px',
          overflow: 'hidden',
          background: 'var(--secondary)'
        }}
      >
        {segments.map((s, i) => (
          <div
            key={i}
            style={{
              width: `${(s.value / total) * 100}%`,
              background: s.color,
              transition: 'width 0.3s'
            }}
            title={`${s.label}: ${s.value.toFixed(2)}%`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
        {segments.map((s, i) => (
          <span key={i} className="flex items-center gap-1">
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '2px',
                background: s.color,
                display: 'inline-block'
              }}
            />
            {s.label} {s.value.toFixed(2)}%
          </span>
        ))}
      </div>
    </div>
  );
}

function DetailTable({ perStock }) {
  const sorted = useMemo(() => {
    return [...perStock].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  }, [perStock]);

  return (
    <div className="overflow-x-auto">
      <table
        style={{
          width: '100%',
          fontSize: '12px',
          borderCollapse: 'collapse'
        }}
      >
        <thead>
          <tr style={{ background: 'var(--secondary)', color: 'var(--muted)' }}>
            <th style={cellStyle('left')}>股票</th>
            <th style={cellStyle('right')}>权重</th>
            <th style={cellStyle('right')}>PE</th>
            <th style={cellStyle('right')}>PB</th>
            <th style={cellStyle('right')}>净利同比</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={cellStyle('left')}>
                <div className="flex flex-col">
                  <span style={{ color: 'var(--text)', fontWeight: 500 }}>{row.name || '—'}</span>
                  <span style={{ color: 'var(--muted)', fontSize: '10px' }}>{row.code}</span>
                </div>
              </td>
              <td style={cellStyle('right')}>{formatPercent(row.weight)}</td>
              <td style={cellStyle('right', row.pe)}>{formatMetric(row.pe)}</td>
              <td style={cellStyle('right')}>{formatMetric(row.pb)}</td>
              <td style={cellStyle('right', row.epsGrowth)}>
                {formatMetric(row.epsGrowth, { suffix: '%', signed: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function cellStyle(align, value) {
  const base = {
    padding: '8px 12px',
    textAlign: align,
    fontVariantNumeric: 'tabular-nums'
  };
  if (align === 'right' && isNumber(value)) {
    base.color = value > 0 ? 'var(--up)' : value < 0 ? 'var(--down)' : 'var(--text)';
  }
  return base;
}
