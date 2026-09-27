'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { isArray, isNumber } from 'lodash';

import { useFundValuationHistory } from '@/app/hooks/useFundValuationHistory';
import { PERIOD_ORDER, VALUATION_PERIODS } from '@/app/lib/valuationHistory';
import { historyProgressKey } from '@/app/lib/valuationProgressKeys';
import ValuationProgressBar from './ValuationProgressBar';

/** 评分 → 颜色（与面板进度条同一套口径） */
function scoreColor(score) {
  if (!isNumber(score)) return 'var(--muted)';
  if (score < 30) return 'var(--emerald-500, #10b981)';
  if (score < 50) return 'var(--green-400, #4ade80)';
  if (score < 65) return 'var(--gray-400, #9ca3af)';
  if (score < 80) return 'var(--orange-400, #fb923c)';
  return 'var(--red-400, #f87171)';
}

/** 区间统计项 */
function StatItem({ label, value, tone }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: '10px', color: 'var(--muted)' }}>{label}</span>
      <span
        style={{
          fontSize: '13px',
          fontWeight: 600,
          color: tone || 'var(--foreground)',
          whiteSpace: 'nowrap'
        }}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * 评分走势迷你曲线（内联 SVG，避免为一个面板引入图表依赖）
 *
 * y 轴取「区间最小值-4 ~ 区间最大值+4」并收敛到 [0,100]：
 * 若固定 0~100，区间内 3~5 分的波动会被压成一条直线；
 * 端点同时标注实际分数，保留绝对水平的可读性。
 */
function ScoreSparkline({ points }) {
  const W = 300;
  const H = 72;
  const PAD_Y = 8;

  const scores = points.map((p) => p.score);
  const rawMin = Math.min(...scores);
  const rawMax = Math.max(...scores);
  let lo = Math.max(0, rawMin - 4);
  let hi = Math.min(100, rawMax + 4);
  if (hi - lo < 6) {
    // 区间过窄时（评分几乎不动）强制撑开，避免放大噪声
    const mid = (hi + lo) / 2;
    lo = Math.max(0, mid - 3);
    hi = Math.min(100, mid + 3);
  }
  const span = hi - lo || 1;

  const toXY = (p, i) => {
    const x = points.length === 1 ? W / 2 : (i / (points.length - 1)) * W;
    const y = PAD_Y + (1 - (p.score - lo) / span) * (H - PAD_Y * 2);
    return [x, y];
  };

  const coords = points.map(toXY);
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${H} L${coords[0][0].toFixed(1)},${H} Z`;
  const color = scoreColor(points[points.length - 1].score);
  const last = coords[coords.length - 1];

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: H, display: 'block' }}
        role="img"
        aria-label="估值评分区间走势"
      >
        <defs>
          <linearGradient id="valuationHistoryFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#valuationHistoryFill)" />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={last[0]} cy={last[1]} r="2.6" fill={color} vectorEffect="non-scaling-stroke" />
      </svg>
      {/* 端点分数：给出绝对水平（曲线本身是放大的） */}
      <span
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          fontSize: '10px',
          color: 'var(--muted)',
          opacity: 0.75
        }}
      >
        {rawMax.toFixed(0)}
      </span>
      <span
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          fontSize: '10px',
          color: 'var(--muted)',
          opacity: 0.75
        }}
      >
        {rawMin.toFixed(0)}
      </span>
    </div>
  );
}

/**
 * 基金估值区间分析（近 1 月 / 近 3 月）
 *
 * 展示评分随时间的走势与区间统计。数据源覆盖 A 股与港股持仓；
 * 纯美股基金当前无可用估值历史，会提示暂无区间数据。
 *
 * 默认折叠：该组件在列表卡片模式下会随每张卡片渲染，
 * 若不折叠，打开首页就会为每只基金各发一次区间查询（含持仓与历史序列）。
 * 基金详情抽屉（drawer）里只聚焦一只基金，调用方传 defaultExpanded 直接展开。
 *
 * @param {{ code: string, defaultExpanded?: boolean }} props
 */
export default function FundValuationHistory({ code, defaultExpanded = false }) {
  const [range, setRange] = useState('3m');
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { data, isLoading, isError } = useFundValuationHistory(code, range, { enabled: expanded });

  const summary = data?.summary;
  const points = (isArray(data?.series) ? data.series : []).filter((p) => isNumber(p.score));
  const hasCurve = points.length >= 2;

  const directionText = (() => {
    if (!summary || summary.direction == null) return null;
    if (summary.direction === 'flat') return { text: '区间内基本走平', tone: 'var(--muted)' };
    const cheaper = summary.direction === 'cheaper';
    return {
      text: cheaper
        ? `较区间起点便宜 ${Math.abs(summary.change).toFixed(1)} 分`
        : `较区间起点变贵 ${summary.change.toFixed(1)} 分`,
      tone: cheaper ? 'var(--emerald-500, #10b981)' : 'var(--red-400, #f87171)'
    };
  })();

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: expanded ? 8 : 0,
          gap: 8
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--foreground)',
            fontSize: '12px',
            fontWeight: 600
          }}
        >
          <ChevronDown
            size={14}
            style={{
              transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 0.2s ease',
              color: 'var(--muted)'
            }}
          />
          估值区间走势
        </button>
      </div>

      {!expanded && (
        <div style={{ fontSize: '10px', color: 'var(--muted)', marginTop: 2, opacity: 0.6 }}>
          点击展开近 1 月 ~ 成立来的评分变化
        </div>
      )}

      {/* 区间切换：6 档与「业绩走势」一致，独占一行以免挤在标题右侧 */}
      {expanded && (
        <div className="trend-range-bar" style={{ marginTop: 0, marginBottom: 8 }}>
          {PERIOD_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              className={`trend-range-btn ${range === key ? 'active' : ''}`}
              onClick={() => setRange(key)}
            >
              {VALUATION_PERIODS[key].label}
            </button>
          ))}
        </div>
      )}

      {expanded && isLoading && (
        <div style={{ padding: '10px 0' }}>
          <ValuationProgressBar
            progressKey={historyProgressKey(code, range)}
            fallbackLabel="正在回放区间内估值…"
            compact
          />
        </div>
      )}

      {expanded && !isLoading && (isError || !data) && (
        <div style={{ padding: '14px 0', textAlign: 'center', color: 'var(--muted)', fontSize: '12px' }}>
          区间数据加载失败
        </div>
      )}

      {expanded && !isLoading && data && !hasCurve && (
        <div style={{ padding: '12px 0', textAlign: 'center', color: 'var(--muted)', fontSize: '12px' }}>
          {data.historyCoverage > 0
            ? `${VALUATION_PERIODS[range].label}区间内数据点不足，无法绘制走势`
            : '该基金持仓暂无估值历史（美股无可用历史源），暂不支持区间分析'}
        </div>
      )}

      {expanded && !isLoading && data && hasCurve && (
        <>
          <ScoreSparkline points={points} />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 8,
              marginTop: 10
            }}
          >
            <StatItem label="当前" value={summary.current.score.toFixed(1)} tone={scoreColor(summary.current.score)} />
            <StatItem label="区间均值" value={summary.avg.toFixed(1)} />
            <StatItem label="区间最高" value={summary.max.score.toFixed(1)} tone={scoreColor(summary.max.score)} />
            <StatItem label="区间最低" value={summary.min.score.toFixed(1)} tone={scoreColor(summary.min.score)} />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 8,
              gap: 8,
              flexWrap: 'wrap'
            }}
          >
            {directionText && <span style={{ fontSize: '11px', color: directionText.tone }}>{directionText.text}</span>}
            {isNumber(summary.position) && (
              <span style={{ fontSize: '11px', color: 'var(--muted)' }}>当前处于区间第 {summary.position}% 分位</span>
            )}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--muted)', marginTop: 6, opacity: 0.6 }}>
            {/* 显示实际覆盖区间：成立来档位请求下界是极早日期，直接用 data.from 会显示 1900-01-01 */}
            {summary.first.date} ~ {summary.current.date} · {points.length} 个数据点 · 持仓历史覆盖{' '}
            {(data.historyCoverage || 0).toFixed(1)}%
          </div>
          {data.range === 'all' && (
            <div style={{ fontSize: '10px', color: 'var(--muted)', marginTop: 2, opacity: 0.6 }}>
              估值区间受持仓估值历史限制，最多回溯近 5 年（非基金成立日）
            </div>
          )}
        </>
      )}
    </div>
  );
}
