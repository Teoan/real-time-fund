'use client';

import { CATEGORY_NAMES } from '@/app/lib/fundClassifier';
import FundValuationBadge from './FundValuationBadge';
import FundValuationHistory from './FundValuationHistory';
import ValuationProgressBar from './ValuationProgressBar';

/**
 * 估值指标行
 */
function MetricRow({ label, rawValue, score, weight, contributed, suffix = '', hint = '' }) {
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
      <span style={{ fontSize: '13px', color: 'var(--foreground)', flex: 1 }}>
        {label}
        {hint ? (
          <span style={{ fontSize: '10px', color: 'var(--muted)', marginLeft: 6, opacity: 0.75 }}>{hint}</span>
        ) : null}
      </span>
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
 * 指标行的小字提示：分位类指标显示参照样本数（60 个样本 vs 1200 个样本，结论强度差很多）。
 */
function metricHint(detail, percentileSamples) {
  // 分位列本身，或「用分位评分」的原始列（如股息率：有历史就打分位，没有就回退阈值）
  const isPercentileKey = Boolean(detail?.key?.endsWith('Percentile'));
  if (!isPercentileKey && detail?.scoredBy !== 'percentile') return '';
  const base = isPercentileKey ? detail.key.slice(0, -'Percentile'.length) : detail.key;
  const n = percentileSamples?.[base];
  return n ? `${n} 个样本分位` : '';
}

/**
 * 置信度折扣说明：解释「为什么置信度只有 45%」。
 *
 * 置信度 = 指标覆盖率 × 持仓覆盖因子 × 季报时效因子（见 app/lib/valuationConfidence.js），
 * 只有把折扣项摆出来，用户才知道结论是「指标少」还是「仓位没看清」还是「季报太旧」。
 */
function ConfidenceNote({ breakdown }) {
  if (!breakdown) return null;
  const notes = [];
  const { coverageFactor, stalenessFactor, holdingsAgeMonths } = breakdown;
  if (coverageFactor != null && coverageFactor < 1) notes.push(`持仓仅覆盖 ${breakdown.holdingsCoverage}%`);
  if (stalenessFactor != null && stalenessFactor < 1) {
    const months = holdingsAgeMonths != null ? `${holdingsAgeMonths.toFixed(1)} 个月` : '较久';
    notes.push(`季报已 ${months}未更新`);
  }
  if (notes.length === 0) return null;
  return (
    <div style={{ fontSize: '10px', color: 'var(--muted)', marginTop: 2, opacity: 0.75, maxWidth: 180 }}>
      {notes.join(' · ')}
    </div>
  );
}

const DISPERSION_LABELS = {
  concentrated: '持仓估值集中',
  mixed: '持仓估值分化',
  split: '持仓估值撕裂'
};

/**
 * 结构提示：解释「分数背后的持仓长什么样」。
 *
 * 加权均值会掩盖两个事实：
 *   1. 哑铃型持仓（一半极便宜、一半极贵）加权后正好 50 分，看起来「合理」；
 *   2. 亏损仓位没有市盈率，只靠剩下的仓位出分，分数看着很稳其实样本很窄。
 * 再叠一个横向参照（相对自选池中位），避免只看自己跟自己比。
 */
function StructureNote({ valuation }) {
  const items = [];

  const level = valuation.dispersionLevel;
  const sigma = valuation.dispersion?.pe;
  if (level) {
    items.push(`${DISPERSION_LABELS[level] || level}${sigma != null ? `（σ=${sigma.toFixed(0)}）` : ''}`);
  }
  if (valuation.lossWeight > 0) {
    items.push(`亏损仓位 ${valuation.lossWeight.toFixed(0)}%（不计分位）`);
  }
  if (valuation.relativePercentile != null) {
    const diff = valuation.relativePercentile;
    const direction = diff >= 8 ? '比自选池贵' : diff <= -8 ? '比自选池便宜' : '与自选池相当';
    items.push(`${direction} ${Math.abs(diff).toFixed(0)}pt`);
  }

  if (items.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        marginBottom: 10
      }}
    >
      {items.map((text) => (
        <span
          key={text}
          style={{
            fontSize: '10px',
            color: 'var(--muted)',
            background: 'var(--secondary)',
            borderRadius: 4,
            padding: '2px 6px',
            opacity: 0.85
          }}
        >
          {text}
        </span>
      ))}
    </div>
  );
}

/**
 * 基金估值分析面板
 *
 * 展示内容：
 *   1. 总评分 + 评级标签 + 置信度
 *   2. 评分进度条
 *   3. 持仓结构提示（离散度 / 亏损仓位 / 相对自选池）
 *   4. 基金分类
 *   4. 各指标明细（原始值 / 评分 / 权重）
 *   5. 持仓覆盖率
 *   6. 区间走势（近 1 月 / 近 3 月，需要有 estimating 历史的持仓市场）
 *
 * @param {{ valuation: object|null, isLoading?: boolean, code?: string, historyDefaultExpanded?: boolean }} props
 */
export default function FundValuationPanel({
  valuation,
  isLoading = false,
  code = '',
  historyDefaultExpanded = false
}) {
  if (isLoading) {
    return (
      <div style={{ padding: '14px 0' }}>
        {/* 进度条由 app/api/fund.js 逐只/逐项上报真实进度，见 ValuationProgressBar */}
        <ValuationProgressBar progressKey={code} fallbackLabel="正基于持仓计算历史分位…" />
        <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: 8, opacity: 0.7 }}>
          逐只拉取个股估值与历史分位，约需数秒
        </div>
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
          <ConfidenceNote breakdown={valuation.confidenceBreakdown} />
          {valuation.holdingsCoverage != null && (
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
              持仓覆盖：{valuation.holdingsCoverage.toFixed(1)}%
            </div>
          )}
          {valuation.holdingsReportDate && (
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>持仓报告期：{valuation.holdingsReportDate}</div>
          )}
        </div>
      </div>

      {/* 持仓结构提示：分数背后的形状（离散度 / 亏损仓位 / 横向参照） */}
      <StructureNote valuation={valuation} />

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
          hint={metricHint(d, valuation.percentileSamples)}
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
              hint={d.lossGuarded ? '亏损股，分位不参与' : ''}
            />
          ))}
        </>
      )}

      {/* 区间走势：近 1 月 / 近 3 月 */}
      {code ? <FundValuationHistory code={code} defaultExpanded={historyDefaultExpanded} /> : null}

      {/* 更新时间 */}
      {valuation.updatedAt && (
        <div style={{ fontSize: '10px', color: 'var(--muted)', textAlign: 'right', marginTop: 8, opacity: 0.6 }}>
          更新于 {new Date(valuation.updatedAt).toLocaleString('zh-CN')}
        </div>
      )}
    </div>
  );
}
