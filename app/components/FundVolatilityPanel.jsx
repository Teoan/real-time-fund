'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { isArray, isNumber } from 'lodash';

import { useFundVolatility } from '@/app/hooks/useFundVolatility';
import { PERCENTILE_WINDOW_YEARS, VOLATILITY_STATES } from '@/app/lib/fundVolatility';

/**
 * 基金波动信号面板（规格 §7）
 *
 * 展示：
 *   基金名称 / 基金代码
 *   当前波动状态 + 风险评分
 *   5 日 / 20 日 / 60 日波动率
 *   20 日波动率历史分位、5日/20日波动率
 *   当前回撤 / 20 日最大回撤 / 60 日最大回撤
 *   当前触发的波动信号
 *
 * 数据由 useFundVolatility 自己取（同 FundValuationHistory 的模式），
 * 不走 page.jsx 的 prop 透传——这个面板是增强信息，不该给主渲染路径再挂一层 state。
 *
 * ⚠️ 默认收起、展开后才取数（`enabled: expanded`）：
 *    card 模式下列表的每只基金都会渲染本组件，无条件取数等于为每只基金拉一次
 *    pingzhongdata 全量历史（单只几百 KB）。这与 useFundValuationHistory 的取舍一致。
 *    drawer 模式由调用方传 defaultExpanded 直接展开（那里一次只聚焦一只基金）。
 */

const LEVEL_COLORS = {
  danger: 'var(--red-400, #f87171)',
  warn: 'var(--orange-400, #fb923c)',
  normal: 'var(--emerald-500, #10b981)',
  muted: 'var(--muted)'
};

/** 数值 → 展示串，缺失一律 '--' */
const fmt = (value, digits = 2, suffix = '') => {
  if (!isNumber(value) || !Number.isFinite(value)) return '--';
  return `${value.toFixed(digits)}${suffix}`;
};

/** 带正负号的百分比（回撤天然是负数，保留符号更直观） */
const fmtSigned = (value, digits = 2) => {
  if (!isNumber(value) || !Number.isFinite(value)) return '--';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
};

const SOURCE_LABELS = { cache: '本地缓存', network: '实时拉取' };

/** 指标行 */
function MetricRow({ label, value, hint }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        padding: '5px 0',
        borderBottom: '1px solid var(--border)'
      }}
    >
      <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        {hint ? <span style={{ fontSize: '10px', color: 'var(--muted)', opacity: 0.7 }}>{hint}</span> : null}
        <span style={{ fontSize: '13px', color: 'var(--foreground)', fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </span>
      </span>
    </div>
  );
}

/** 风险评分条（越高越红） */
function RiskBar({ score }) {
  if (!isNumber(score)) return null;
  const pct = Math.max(0, Math.min(100, score));
  const color =
    pct < 30 ? LEVEL_COLORS.normal : pct < 60 ? '#eab308' : pct < 80 ? LEVEL_COLORS.warn : LEVEL_COLORS.danger;
  return (
    <div style={{ width: '100%', height: 6, background: 'var(--secondary)', borderRadius: 3, overflow: 'hidden' }}>
      <div
        style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.3s ease' }}
      />
    </div>
  );
}

/**
 * @param {{ code: string, name?: string, defaultExpanded?: boolean }} props
 */
export default function FundVolatilityPanel({ code, name = '', defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const { data, isLoading, isError, error, refresh, isFetching } = useFundVolatility(code, {
    enabled: expanded,
    basic: name ? { code, name } : null
  });

  const stateColor = LEVEL_COLORS[data?.stateLevel] || LEVEL_COLORS.muted;
  const toggle = () => setExpanded((v) => !v);

  return (
    <div
      style={{
        padding: '8px 12px',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--secondary)'
      }}
    >
      {/* ── 可点击标题：收起时不取数 ── */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          userSelect: 'none'
        }}
      >
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--foreground)' }}>波动信号</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {!expanded && data ? <span style={{ fontSize: '12px', color: stateColor }}>{data.state}</span> : null}
          <ChevronDown
            size={16}
            className="muted"
            style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.2s ease' }}
          />
        </span>
      </div>

      {expanded ? (
        <div style={{ marginTop: 8 }}>
          {isLoading ? (
            <div style={{ padding: '10px 0', fontSize: '13px', color: 'var(--muted)' }}>
              正在基于历史净值计算波动指标…
            </div>
          ) : isError ? (
            <div style={{ padding: '12px 0', textAlign: 'center', color: 'var(--muted)', fontSize: '13px' }}>
              波动信号加载失败{error?.message ? `：${error.message}` : ''}
            </div>
          ) : !data || data.state === VOLATILITY_STATES.INSUFFICIENT ? (
            <div style={{ padding: '12px 0', textAlign: 'center', color: 'var(--muted)', fontSize: '13px' }}>
              暂无足够净值数据计算波动信号
              {data?.error ? <div style={{ fontSize: '11px', marginTop: 4, opacity: 0.7 }}>{data.error}</div> : null}
            </div>
          ) : (
            <PanelBody
              data={data}
              name={name}
              code={code}
              isFetching={isFetching}
              onRefresh={() => refresh()}
              stateColor={stateColor}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 展开后的正文 */
function PanelBody({ data, name, code, isFetching, onRefresh, stateColor }) {
  const { metrics, primarySignals, state, riskScore, asOfDate, navCount, sources, error: softError } = data;
  const signals = isArray(primarySignals) ? primarySignals : [];

  return (
    <>
      {/* ── 当前状态 + 风险评分 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {name ? (
            <div
              style={{
                fontSize: '12px',
                color: 'var(--muted)',
                marginBottom: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {name} · {code}
            </div>
          ) : null}
          <span
            style={{
              display: 'inline-block',
              fontSize: '15px',
              fontWeight: 700,
              color: stateColor,
              padding: '2px 8px',
              borderRadius: 6,
              border: `1px solid ${stateColor}`
            }}
          >
            {state}
          </span>
        </div>
        <div style={{ textAlign: 'right', minWidth: 96 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, justifyContent: 'flex-end' }}>
            <span style={{ fontSize: '22px', fontWeight: 700, color: 'var(--foreground)' }}>
              {isNumber(riskScore) ? riskScore : '--'}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--muted)' }}>风险评分</span>
          </div>
          <div style={{ marginTop: 4 }}>
            <RiskBar score={riskScore} />
          </div>
        </div>
      </div>

      {/* ── 波动率 ── */}
      <MetricRow label="5 日波动率" value={fmt(metrics.vol5, 2, '%')} />
      <MetricRow label="20 日波动率" value={fmt(metrics.vol20, 2, '%')} />
      <MetricRow label="60 日波动率" value={fmt(metrics.vol60, 2, '%')} />

      {/* ── 相对水平 ── */}
      <MetricRow
        label={`20 日波动率历史分位（近 ${PERCENTILE_WINDOW_YEARS} 年）`}
        value={isNumber(metrics.vol20Percentile) ? `${metrics.vol20Percentile.toFixed(0)}%` : '--'}
        hint={
          isNumber(metrics.percentileSamples) && metrics.percentileSamples > 0
            ? `${metrics.percentileSamples} 样本`
            : ''
        }
      />
      <MetricRow label="5 日 / 20 日波动率" value={fmt(metrics.volRatio, 2)} />

      {/* ── 回撤 ── */}
      <MetricRow label="当前回撤" value={fmtSigned(metrics.currentDrawdown)} />
      <MetricRow label="20 日最大回撤" value={fmtSigned(metrics.maxDrawdown20)} />
      <MetricRow label="60 日最大回撤" value={fmtSigned(metrics.maxDrawdown60)} />

      {/* ── 触发的波动信号 ── */}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--foreground)', marginBottom: 6 }}>
          当前触发的波动信号
        </div>
        {signals.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--muted)', opacity: 0.8 }}>未触发任何波动信号</div>
        ) : (
          signals.map((signal) => (
            <div key={signal.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '3px 0' }}>
              <span
                style={{ color: LEVEL_COLORS[signal.level] || LEVEL_COLORS.warn, fontSize: '12px', lineHeight: '18px' }}
              >
                {signal.level === 'danger' ? '⛔' : '⚠'}
              </span>
              <span style={{ flex: 1 }}>
                <span style={{ fontSize: '12px', color: 'var(--foreground)' }}>{signal.label}</span>
                {signal.detail ? (
                  <span style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: 6 }}>{signal.detail}</span>
                ) : null}
              </span>
            </div>
          ))
        )}
      </div>

      {/* ── 页脚：净值日期 / 数据来源 / 刷新 ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 10,
          fontSize: '10px',
          color: 'var(--muted)',
          opacity: 0.7
        }}
      >
        <span>
          净值日期 {asOfDate || '--'} · {navCount} 个交易日
          {sources?.nav ? ` · 净值${SOURCE_LABELS[sources.nav] || ''}` : ''}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isFetching}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--muted)',
            fontSize: '10px',
            cursor: isFetching ? 'default' : 'pointer',
            padding: 0,
            textDecoration: 'underline'
          }}
        >
          {isFetching ? '刷新中…' : '刷新'}
        </button>
      </div>

      {softError ? (
        <div style={{ fontSize: '10px', color: LEVEL_COLORS.warn, marginTop: 4, opacity: 0.85 }}>
          最新净值拉取失败，当前结果基于本地缓存：{softError}
        </div>
      ) : null}
    </>
  );
}
