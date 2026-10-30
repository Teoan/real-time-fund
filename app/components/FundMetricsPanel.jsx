'use client';

import { useState } from 'react';
import { isNumber, isString } from 'lodash';
import dayjs from 'dayjs';
import { FileText } from 'lucide-react';

import { useFundMetrics } from '@/app/hooks/useFundMetrics';
import { MIN_METRIC_SAMPLES } from '@/app/lib/fundMetrics';
import { buildFundResearchReport } from '@/app/lib/fundReport';
import {
  fetchFundProfileOverview,
  fetchFundFeeTiers,
  fetchFundAchievement,
  fetchFundProfitProbability
} from '@/app/api/fund';
import { useModalStore } from '@/app/stores';

/**
 * 基金指标面板（基金详情「指标」页签）
 *
 * 展示 13 项：年化收益率(CAGR)、年化波动率、最大回撤、夏普、索提诺、卡尔玛、
 * 信息比率、Alpha、Beta、VaR、CVaR、胜率、盈亏比。
 *
 * 数据由 useFundMetrics 自己取（同 FundVolatilityPanel / FundValuationHistory 的模式），
 * 不走 page.jsx 的 prop 透传——这是增强信息，不该给主渲染路径再挂一层 state。
 *
 * 右上角「调研初步报告」按钮：用 app/lib/fundReport.js 把**当前已加载的指标**现算成一份
 * 结构化报告（纯函数，无额外请求），再交给 ModalsLayer 里的 FundResearchReportModal 展示。
 * 报告与指标同源，所以不存在「报告里的数字和面板上的数字不一致」的可能。
 *
 * ⚠️ 不需要 `enabled` 开关：本面板只挂在「基金详情」的 TabsContent 里，
 *    Radix Tabs 默认卸载非激活内容，所以切到「指标」页签之前不会有任何取数。
 *    也正因如此这里没有收起/展开逻辑（页面本身已经是一层懒加载）。
 */

/** 指标行展示规格：kind 决定格式，emptyHint 说明「算不出来」的原因（避免只显示一个 --） */
const METRIC_GROUPS = [
  {
    title: '收益',
    items: [
      {
        key: 'cagr',
        label: '年化收益率 (CAGR)',
        definition: '几何平均年化收益率',
        kind: 'percent',
        signed: true
      }
    ]
  },
  {
    title: '风险水平',
    items: [
      { key: 'annualizedVolatility', label: '年化波动率', definition: '收益率年化标准差', kind: 'percent' },
      { key: 'maxDrawdown', label: '最大回撤', definition: '峰值到谷底的最大跌幅', kind: 'percent' },
      {
        key: 'var95',
        label: 'VaR',
        definition: '给定置信水平的最大潜在损失',
        kind: 'percent',
        emptyHint: '样本不足'
      },
      { key: 'cvar95', label: 'CVaR', definition: '尾部损失的期望值', kind: 'percent', emptyHint: '样本不足' }
    ]
  },
  {
    title: '风险调整后收益',
    items: [
      {
        key: 'sharpe',
        label: '夏普比率',
        definition: '(收益 − 无风险) / 总风险',
        kind: 'ratio',
        emptyHint: '波动率过低'
      },
      {
        key: 'sortino',
        label: '索提诺比率',
        definition: '(收益 − 无风险) / 下行风险',
        kind: 'ratio',
        emptyHint: '无下行波动'
      },
      {
        key: 'calmar',
        label: '卡尔玛比率',
        definition: '年化收益 / 最大回撤',
        kind: 'ratio',
        emptyHint: '区间内无回撤'
      },
      {
        key: 'informationRatio',
        label: '信息比率',
        definition: '主动收益 / 跟踪误差',
        kind: 'ratio',
        emptyHint: '需业绩基准'
      }
    ]
  },
  {
    title: '市场关联',
    items: [
      {
        key: 'alpha',
        label: 'Alpha',
        definition: '超额收益 (CAPM)',
        kind: 'percent',
        signed: true,
        emptyHint: '需业绩基准'
      },
      { key: 'beta', label: 'Beta', definition: '市场风险敞口', kind: 'ratio', emptyHint: '需业绩基准' }
    ]
  },
  {
    title: '交易统计',
    items: [
      { key: 'winRate', label: '胜率', definition: '正收益天数占比', kind: 'percent1' },
      { key: 'profitLossRatio', label: '盈亏比', definition: '总盈利 / 总亏损', kind: 'ratio', emptyHint: '无亏损日' }
    ]
  }
];

const SOURCE_LABELS = { cache: '本地缓存', network: '实时拉取', none: '无' };

/** 报告生成时间（本地时区展示；报告本体把该值当入参，便于单测保持确定性） */
const formatNow = () => dayjs().format('YYYY-MM-DD HH:mm');

/** 数值 → 展示串，缺失一律 '--' */
const fmtValue = (value, kind, signed = false) => {
  if (!isNumber(value) || !Number.isFinite(value)) return '--';
  const sign = signed && value > 0 ? '+' : '';
  if (kind === 'percent1') return `${value.toFixed(1)}%`;
  if (kind === 'percent') return `${sign}${value.toFixed(2)}%`;
  return `${sign}${value.toFixed(2)}`;
};

/** 只有「正负本身有含义」的指标才上色（CAGR / Alpha）；风险指标上红色只是在制造噪音 */
const valueColor = (value, signed) => {
  if (!signed || !isNumber(value) || !Number.isFinite(value) || value === 0) return 'var(--foreground)';
  return value > 0 ? 'var(--success)' : 'var(--danger)';
};

/** 指标行 */
function MetricRow({ label, definition, raw, text, emptyHint, signed }) {
  const missing = text === '--';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 10,
        padding: '5px 0',
        borderBottom: '1px solid var(--border)'
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ fontSize: '12px', color: 'var(--foreground)' }}>{label}</span>
        <span style={{ display: 'block', fontSize: '10px', color: 'var(--muted)', opacity: 0.75 }}>
          {missing && isString(emptyHint) && emptyHint ? `${definition} · ${emptyHint}` : definition}
        </span>
      </span>
      <span
        style={{
          fontSize: '13px',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          color: missing ? 'var(--muted)' : valueColor(raw, signed)
        }}
      >
        {text}
      </span>
    </div>
  );
}

/** 依赖业绩基准的三项：算不出来时要说清是「没配基准」还是「配对样本不足」 */
const BENCHMARK_DEPENDENT_KEYS = new Set(['informationRatio', 'alpha', 'beta']);

/**
 * @param {{ code: string, name?: string, riskFreeRate?: number }} props
 */
export default function FundMetricsPanel({ code, name = '', riskFreeRate }) {
  const { data, isLoading, isError, error, refresh, isFetching } = useFundMetrics(code, {
    basic: name ? { code, name } : null,
    riskFreeRate
  });

  const metrics = data?.metrics;
  const insufficient = !metrics || metrics.insufficient;
  /** 生成报告时并发拉档案数据，期间禁用按钮防重复点击 */
  const [reportBusy, setReportBusy] = useState(false);

  /**
   * 生成报告：先并发拉取「档案增强数据」（基金档案/费率阶梯/同业业绩/持有概率），
   * 任一接口失败都降级为 null —— 报告主体只依赖已加载的指标，绝不让外部数据阻塞出报告。
   */
  const openReport = async () => {
    if (!metrics || insufficient || reportBusy) return;
    setReportBusy(true);
    try {
      const safe = (p) => p.catch(() => null);
      const [profile, feeTiers, achievement, probability] = await Promise.all([
        safe(fetchFundProfileOverview(code)),
        safe(fetchFundFeeTiers(code)),
        safe(fetchFundAchievement(code)),
        safe(fetchFundProfitProbability(code))
      ]);
      const report = buildFundResearchReport({
        code,
        name,
        metrics,
        generatedAt: formatNow(),
        profile,
        feeTiers,
        achievement,
        probability
      });
      useModalStore.setState({ fundReportModal: { open: true, report } });
    } finally {
      setReportBusy(false);
    }
  };

  return (
    <div
      style={{
        padding: '8px 12px',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--secondary)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 6
        }}
      >
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--foreground)' }}>基金指标</span>
        <button
          type="button"
          onClick={openReport}
          disabled={insufficient || reportBusy}
          title={insufficient ? '净值样本不足，暂无法生成报告' : '基于当前指标 + 基金档案生成一份调研初步报告'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            flexShrink: 0,
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'transparent',
            color: insufficient ? 'var(--muted)' : 'var(--foreground)',
            fontSize: '11px',
            padding: '3px 8px',
            cursor: insufficient ? 'not-allowed' : 'pointer',
            opacity: insufficient ? 0.6 : 1
          }}
        >
          <FileText size={12} />
          {reportBusy ? '生成中…' : '调研初步报告'}
        </button>
      </div>
      {isLoading ? (
        <div style={{ padding: '10px 0', fontSize: '13px', color: 'var(--muted)' }}>
          正在基于历史净值与业绩基准计算指标…
        </div>
      ) : isError ? (
        <div style={{ padding: '12px 0', textAlign: 'center', color: 'var(--muted)', fontSize: '13px' }}>
          指标加载失败{error?.message ? `：${error.message}` : ''}
        </div>
      ) : insufficient ? (
        <div style={{ padding: '12px 0', textAlign: 'center', color: 'var(--muted)', fontSize: '13px' }}>
          {metrics?.sampleCount > 0
            ? `暂无足够净值数据计算指标（至少需要 ${MIN_METRIC_SAMPLES} 个交易日，当前 ${metrics.sampleCount} 个）`
            : '暂无足够净值数据计算指标'}
          {isString(data?.error) && data.error ? (
            <div style={{ fontSize: '11px', marginTop: 4, opacity: 0.7 }}>{data.error}</div>
          ) : null}
        </div>
      ) : (
        <>
          {METRIC_GROUPS.map((group) => (
            <div key={group.title} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--foreground)', marginBottom: 4 }}>
                {group.title}
              </div>
              {group.items.map((item) => {
                const value = metrics[item.key];
                const missing = !isNumber(value) || !Number.isFinite(value);
                // 基准已配置却仍算不出来 → 原因是配对样本不足（比如基准只有几十个交易日）
                const emptyHint =
                  missing && data.benchmark && BENCHMARK_DEPENDENT_KEYS.has(item.key)
                    ? `配对样本不足（${metrics.pairedSampleCount} 个交易日）`
                    : item.emptyHint;
                return (
                  <MetricRow
                    key={item.key}
                    label={item.label}
                    definition={item.definition}
                    emptyHint={emptyHint}
                    signed={item.signed}
                    raw={value}
                    text={fmtValue(value, item.kind, item.signed)}
                  />
                );
              })}
            </div>
          ))}

          {/* ── 基准缺失/取数失败：只影响信息比率/Alpha/Beta ── */}
          {!data.benchmark ? (
            <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: 2 }}>
              {isString(data.benchmarkError) && data.benchmarkError
                ? `业绩基准不可用（${data.benchmarkError}），信息比率 / Alpha / Beta 暂不展示`
                : '该基金类型暂未配置业绩基准，信息比率 / Alpha / Beta 暂不展示'}
            </div>
          ) : isString(data.benchmarkError) && data.benchmarkError ? (
            <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: 2 }}>
              基准最新数据拉取失败，当前使用本地缓存：{data.benchmarkError}
            </div>
          ) : null}

          {/* ── 口径脚注 ── */}
          <div style={{ fontSize: '10px', color: 'var(--muted)', opacity: 0.75, marginTop: 6, lineHeight: 1.5 }}>
            夏普 / 索提诺 / Alpha 采用算术年化收益，卡尔玛采用几何年化收益 (CAGR)； VaR / CVaR 为单日{' '}
            {Math.round((metrics.varConfidence ?? 0.95) * 100)}% 置信、历史模拟法。
          </div>

          {/* ── 页脚：区间 / 样本 / 基准 / 来源 / 刷新 ── */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginTop: 8,
              fontSize: '10px',
              color: 'var(--muted)',
              opacity: 0.7
            }}
          >
            <span style={{ minWidth: 0 }}>
              区间 {metrics.startDate || '--'} ~ {metrics.endDate || '--'} · {metrics.sampleCount} 个交易日
              {data.benchmark
                ? ` · 基准 ${data.benchmark.name}${metrics.pairedSampleCount ? `（配对 ${metrics.pairedSampleCount} 日）` : ''}`
                : ''}
              {' · '}无风险利率 {isNumber(metrics.riskFreeRate) ? `${metrics.riskFreeRate}%` : '--'}
              {` · 净值${SOURCE_LABELS[data.sources?.nav] || ''}`}
            </span>
            <button
              type="button"
              onClick={() => refresh()}
              disabled={isFetching}
              style={{
                flexShrink: 0,
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

          {isString(data.error) && data.error ? (
            <div style={{ fontSize: '10px', color: 'var(--danger)', marginTop: 4, opacity: 0.85 }}>
              最新净值拉取失败，当前结果基于本地缓存：{data.error}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
