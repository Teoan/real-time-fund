'use client';

import { Loader2 } from 'lucide-react';
import { CATEGORY_NAMES } from '@/app/lib/fundClassifier';
import FundValuationBadge from './FundValuationBadge';

/**
 * 估值指标行
 */
function MetricRow({ label, rawValue, score, weight, contributed, suffix = '' }) {
  const displayValue =
    rawValue != null ? `${typeof rawValue === 'number' ? rawValue.toFixed(2) : rawValue}${suffix}` : '--';
  const displayScore = score != null ? `${score.toFixed(0)}分` : '--';
  const weightPercent = weight != null ? `${(weight * 100).toFixed(0)}%` : '';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 0',
        borderBottom: '1px solid var(--border)',
        opacity: contributed ? 1 : 0.45
      }}
    >
      <span style={{ fontSize: '13px', color: 'var(--foreground)', flex: 1 }}>{label}</span>
      <span style={{ fontSize: '13px', color: 'var(--muted)', width: 70, textAlign: 'right' }}>{displayValue}</span>
      <span style={{ fontSize: '12px', color: 'var(--muted)', width: 50, textAlign: 'right' }}>{displayScore}</span>
      <span style={{ fontSize: '11px', color: 'var(--muted)', width: 36, textAlign: 'right' }}>{weightPercent}</span>
    </div>
  );
}

/**
 * 评分进度条
 */
function ScoreBar({ score }) {
  if (score == null) return null;
  const pct = Math.max(0, Math.min(100, score));

  // 颜色渐变：绿(低估) → 黄(合理) → 红(高估)
  const color =
    pct < 30
      ? 'var(--emerald-500, #10b981)'
      : pct < 50
        ? 'var(--green-400, #4ade80)'
        : pct < 65
          ? 'var(--gray-400, #9ca3af)'
          : pct < 80
            ? 'var(--orange-400, #fb923c)'
            : 'var(--red-400, #f87171)';

  return (
    <div style={{ width: '100%', height: 8, background: 'var(--secondary)', borderRadius: 4, overflow: 'hidden' }}>
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: color,
          borderRadius: 4,
          transition: 'width 0.3s ease'
        }}
      />
    </div>
  );
}

/**
 * 基金估值分析面板
 *
 * 展示内容：
 *   1. 总评分 + 评级标签 + 置信度
 *   2. 评分进度条
 *   3. 基金分类
 *   4. 各指标明细（原始值 / 评分 / 权重）
 *   5. 持仓覆盖率
 *
 * @param {{ valuation: object|null, isLoading?: boolean }} props
 */
export default function FundValuationPanel({ valuation, isLoading = false }) {
  if (isLoading) {
    return (
      <div
        style={{
          padding: '16px 0',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          color: 'var(--muted)'
        }}
      >
        <Loader2 className="animate-spin" size={20} />
        <span style={{ fontSize: '13px' }}>正基于持仓计算历史分位…</span>
        <span style={{ fontSize: '11px', opacity: 0.7 }}>逐只拉取个股估值历史，约需数秒</span>
      </div>
    );
  }

  if (!valuation || valuation.score == null) {
    return (
      <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--muted)', fontSize: '13px' }}>
        暂无估值数据
      </div>
    );
  }

  const categoryLabel = CATEGORY_NAMES[valuation.categoryName] || valuation.categoryName || '';
  const contributedDetails = (valuation.details || []).filter((d) => d.contributed);
  const skippedDetails = (valuation.details || []).filter((d) => !d.contributed);

  return (
    <div style={{ padding: '4px 0' }}>
      {/* 总评 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: '28px', fontWeight: 700, color: 'var(--foreground)' }}>{valuation.score}</span>
            <FundValuationBadge valuation={valuation} />
          </div>
          <ScoreBar score={valuation.score} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={{ fontSize: '10px', color: 'var(--muted)' }}>低估</span>
            <span style={{ fontSize: '10px', color: 'var(--muted)' }}>合理</span>
            <span style={{ fontSize: '10px', color: 'var(--muted)' }}>高估</span>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: 2 }}>分类：{categoryLabel}</div>
          <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: 2 }}>
            置信度：{valuation.confidence}%
          </div>
          {valuation.holdingsCoverage != null && (
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
              持仓覆盖：{valuation.holdingsCoverage.toFixed(1)}%
            </div>
          )}
        </div>
      </div>

      {/* 指标明细表头 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 0',
          borderBottom: '2px solid var(--border)',
          marginBottom: 2
        }}
      >
        <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 600, flex: 1 }}>指标</span>
        <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 600, width: 70, textAlign: 'right' }}>
          当前值
        </span>
        <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 600, width: 50, textAlign: 'right' }}>
          评分
        </span>
        <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 600, width: 36, textAlign: 'right' }}>
          权重
        </span>
      </div>

      {/* 已参与计算的指标 */}
      {contributedDetails.map((d) => (
        <MetricRow
          key={d.key}
          label={d.label}
          rawValue={d.rawValue}
          score={d.score}
          weight={d.weight}
          contributed={true}
          suffix={
            d.key.endsWith('Percentile') || d.key === 'dividendYield' || d.key === 'epsGrowth' || d.key === 'roe'
              ? '%'
              : ''
          }
        />
      ))}

      {/* 未参与计算的指标（数据缺失） */}
      {skippedDetails.length > 0 && (
        <>
          <div style={{ fontSize: '11px', color: 'var(--muted)', padding: '8px 0 4px', opacity: 0.6 }}>
            以下指标数据缺失，未参与评分：
          </div>
          {skippedDetails.map((d) => (
            <MetricRow
              key={d.key}
              label={d.label}
              rawValue={d.rawValue}
              score={d.score}
              weight={d.weight}
              contributed={false}
            />
          ))}
        </>
      )}

      {/* 更新时间 */}
      {valuation.updatedAt && (
        <div style={{ fontSize: '10px', color: 'var(--muted)', textAlign: 'right', marginTop: 8, opacity: 0.6 }}>
          更新于 {new Date(valuation.updatedAt).toLocaleString('zh-CN')}
        </div>
      )}
    </div>
  );
}
