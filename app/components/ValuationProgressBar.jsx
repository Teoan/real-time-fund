'use client';

import { isNumber, isString } from 'lodash';

import { useValuationProgressStore } from '@/app/stores/valuationProgressStore';

/**
 * 估值计算进度条
 *
 * 展示真实进度（由 app/api/fund.js 的取数流程逐只/逐项上报），而不是单纯的转圈：
 * 持仓穿透要逐只拉个股估值、历史分位要逐只拉估值序列，通常需要数秒到数十秒，
 * 用户需要知道「还要多久 / 卡在哪一步」。
 *
 * 进度未知时（percent 为 null）退化为不定量滚动条（复用 globals.css 的 .loading-bar 动画）。
 *
 * @param {object} props
 * @param {string} props.progressKey - 进度键（见 valuationProgressStore 的 key 约定）
 * @param {string} [props.fallbackLabel] - 尚无进度上报时的占位文案
 * @param {boolean} [props.compact] - 紧凑模式（区间走势内嵌用）
 */
export default function ValuationProgressBar({ progressKey, fallbackLabel = '正在加载…', compact = false }) {
  // 只订阅自己的键：其它基金的进度更新不会触发本组件重渲染
  const progress = useValuationProgressStore((s) => (isString(progressKey) ? s.progress[progressKey] : undefined));

  const percent = isNumber(progress?.percent) ? progress.percent : null;
  const label = isString(progress?.label) && progress.label ? progress.label : fallbackLabel;
  const determinate = percent != null;
  const rounded = determinate ? Math.round(percent) : null;

  return (
    <div style={{ width: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: compact ? 4 : 6
        }}
      >
        <span
          style={{
            fontSize: compact ? '11px' : '12px',
            color: 'var(--muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {label}
        </span>
        {determinate && (
          <span
            style={{ fontSize: compact ? '11px' : '12px', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}
          >
            {rounded}%
          </span>
        )}
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? rounded : undefined}
        aria-label={label}
        style={{
          position: 'relative',
          width: '100%',
          height: compact ? 4 : 6,
          background: 'var(--secondary)',
          borderRadius: 999,
          overflow: 'hidden'
        }}
      >
        {determinate ? (
          <div
            style={{
              width: `${percent}%`,
              height: '100%',
              borderRadius: 999,
              background: 'linear-gradient(90deg, var(--primary), var(--primary))',
              opacity: 0.9,
              transition: 'width 0.25s ease'
            }}
          />
        ) : (
          // 不定量：复用全局 .loading-bar 的滚动动画
          <div className="loading-bar" style={{ height: '100%', position: 'absolute', top: 0, borderRadius: 999 }} />
        )}
      </div>
    </div>
  );
}
