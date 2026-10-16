'use client';

import { useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast as sonnerToast } from 'sonner';
import { isArray, isNumber, isString } from 'lodash';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { CloseIcon } from './Icons';
import { REPORT_LEVELS } from '@/app/lib/fundReport';

/**
 * 调研初步报告弹框
 *
 * 只负责渲染 app/lib/fundReport.js 生成好的报告对象；报告在点击入口按钮时现算
 * （纯函数 + 已有指标，无额外网络请求），因此本组件没有 loading / 取数逻辑。
 *
 * ⚠️ 报告是「基于历史指标的画像」，弹框里必须始终可见免责声明，
 *    不能因为版面紧张把免责文案折叠掉（数据局限列表可以折叠，免责不行）。
 */

const LEVEL_COLORS = {
  [REPORT_LEVELS.POSITIVE]: 'var(--success)',
  [REPORT_LEVELS.CAUTION]: 'var(--orange-400, #fb923c)',
  [REPORT_LEVELS.WARNING]: 'var(--danger)',
  [REPORT_LEVELS.NEUTRAL]: 'var(--muted)',
  [REPORT_LEVELS.UNKNOWN]: 'var(--muted)'
};

const RATING_COLORS = {
  [REPORT_LEVELS.POSITIVE]: 'var(--success)',
  [REPORT_LEVELS.NEUTRAL]: 'var(--accent, #60a5fa)',
  [REPORT_LEVELS.CAUTION]: 'var(--orange-400, #fb923c)',
  [REPORT_LEVELS.WARNING]: 'var(--danger)',
  [REPORT_LEVELS.UNKNOWN]: 'var(--muted)'
};

/** 一行说明（章节口径注） */
function NoteLine({ text }) {
  return (
    <div style={{ display: 'flex', gap: 6, fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6 }}>
      <span style={{ opacity: 0.6 }}>·</span>
      <span>{text}</span>
    </div>
  );
}

/** 指标 chip：标签 + 数值 + 判读 */
function MetricChip({ item }) {
  const color = LEVEL_COLORS[item.grade?.level] || 'var(--muted)';
  const missing = item.valueText == null;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '6px 8px',
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'var(--card, var(--secondary))'
      }}
    >
      <span style={{ fontSize: '10px', color: 'var(--muted)' }}>{item.label}</span>
      <span
        style={{
          fontSize: '13px',
          fontVariantNumeric: 'tabular-nums',
          color: missing ? 'var(--muted)' : 'var(--foreground)'
        }}
      >
        {item.valueText ?? '—'}
      </span>
      <span style={{ fontSize: '10px', color, lineHeight: 1.4 }}>
        {missing ? item.grade?.text || '数据不足' : item.grade?.text || ''}
      </span>
    </div>
  );
}

/**
 * @param {{ report: object, onClose: () => void }} props
 */
export default function FundResearchReportModal({ report, onClose }) {
  const [copied, setCopied] = useState(false);

  const copyMarkdown = useCallback(async () => {
    const markdown = isString(report?.markdown) ? report.markdown : '';
    if (!markdown) return;
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('当前浏览器不支持剪贴板写入');
      }
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      sonnerToast.success('报告已复制为 Markdown');
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      sonnerToast.error(`复制失败：${e?.message || '请手动选择文本复制'}`);
    }
  }, [report]);

  if (!report) return null;

  const rating = report.rating || {};
  const window = report.window || {};
  const ratingColor = RATING_COLORS[rating.level] || 'var(--muted)';
  const highlights = isArray(report.highlights) ? report.highlights : [];
  const concerns = isArray(report.concerns) ? report.concerns : [];
  const limitations = isArray(report.limitations) ? report.limitations : [];
  const sections = isArray(report.sections) ? report.sections : [];

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose?.() : null)}>
      <DialogContent
        showCloseButton={false}
        className="glass card modal"
        overlayClassName="modal-overlay"
        style={{
          maxWidth: '620px',
          width: '92vw',
          zIndex: 99,
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <DialogTitle className="sr-only">调研初步报告</DialogTitle>

        {/* ── 标题 ── */}
        <div className="title" style={{ marginBottom: 12, justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: '18px' }}>📋</span>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontSize: '15px', fontWeight: 600 }}>调研初步报告</span>
              <span
                style={{
                  fontSize: '11px',
                  color: 'var(--muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {report.name || '—'}
                {report.code ? ` · ${report.code}` : ''}
              </span>
            </span>
          </div>
          <button className="icon-button" onClick={onClose} style={{ border: 'none', background: 'transparent' }}>
            <CloseIcon width="20" height="20" />
          </button>
        </div>

        {/* ── 正文（可滚动） ── */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} className="scrollbar-y-styled">
          {report.insufficient ? (
            <div
              style={{
                padding: '16px 12px',
                textAlign: 'center',
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--secondary)',
                fontSize: '13px',
                color: 'var(--muted)'
              }}
            >
              净值样本不足，暂无法生成判读结论
              <div style={{ fontSize: '11px', marginTop: 6, opacity: 0.8 }}>
                {isNumber(window.sampleCount) ? `当前区间仅 ${window.sampleCount} 个交易日。` : ''}
                至少要 60 个交易日才能计算指标。
              </div>
            </div>
          ) : (
            <>
              {/* ── 综合画像评分 ── */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '10px 12px',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--secondary)',
                  marginBottom: 10
                }}
              >
                <div style={{ textAlign: 'center', minWidth: 64 }}>
                  <div
                    style={{
                      fontSize: '26px',
                      fontWeight: 700,
                      lineHeight: 1.1,
                      color: ratingColor,
                      fontVariantNumeric: 'tabular-nums'
                    }}
                  >
                    {isNumber(rating.score) ? rating.score : '—'}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--muted)' }}>画像评分 / 100</div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', color: ratingColor, fontWeight: 600, marginBottom: 4 }}>
                    {rating.label ? `综合判读：${rating.label}` : '综合判读：数据不足'}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--foreground)', lineHeight: 1.5 }}>{report.headline}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                    {(isArray(rating.dimensions) ? rating.dimensions : []).map((dim) => (
                      <span key={dim.key} style={{ fontSize: '10px', color: 'var(--muted)' }}>
                        {dim.title} {isNumber(dim.score) ? dim.score : '—'}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* ── 章节 ── */}
              {sections.map((section, index) => (
                <div
                  key={section.key}
                  style={{
                    padding: '10px 12px',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    marginBottom: 10,
                    background: 'var(--card, transparent)'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--foreground)' }}>
                      {index + 1}. {section.title}
                    </span>
                    <span style={{ fontSize: '11px', color: LEVEL_COLORS[section.level] || 'var(--muted)' }}>
                      {section.verdict}
                      {section.unavailable ? '（本节无可用指标，未做判读）' : ''}
                    </span>
                  </div>

                  {(isArray(section.items) ? section.items : []).some((item) => item.valueText != null) ? (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
                        gap: 6,
                        marginBottom: 8
                      }}
                    >
                      {(isArray(section.items) ? section.items : [])
                        .filter((item) => item.valueText != null)
                        .map((item) => (
                          <MetricChip key={item.key} item={item} />
                        ))}
                    </div>
                  ) : null}

                  {(isArray(section.notes) ? section.notes : []).map((note) => (
                    <NoteLine key={note} text={note} />
                  ))}
                </div>
              ))}

              {/* ── 优势 / 关注点 ── */}
              {highlights.length > 0 ? (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--success)', marginBottom: 6 }}>
                    值得关注的优势
                  </div>
                  {highlights.map((item, i) => (
                    <div
                      key={i}
                      style={{ display: 'flex', gap: 6, fontSize: '12px', lineHeight: 1.6, marginBottom: 4 }}
                    >
                      <span style={{ color: LEVEL_COLORS[item.level] || 'var(--muted)' }}>＋</span>
                      <span style={{ color: 'var(--foreground)' }}>{item.text}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {concerns.length > 0 ? (
                <div style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: 'var(--orange-400, #fb923c)',
                      marginBottom: 6
                    }}
                  >
                    需要留意的风险与限制
                  </div>
                  {concerns.map((item, i) => (
                    <div
                      key={i}
                      style={{ display: 'flex', gap: 6, fontSize: '12px', lineHeight: 1.6, marginBottom: 4 }}
                    >
                      <span style={{ color: LEVEL_COLORS[item.level] || 'var(--muted)' }}>！</span>
                      <span style={{ color: 'var(--foreground)' }}>{item.text}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}

          {/* ── 数据局限（可折叠） ── */}
          <details
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '8px 12px',
              background: 'var(--secondary)',
              marginBottom: 8
            }}
          >
            <summary style={{ fontSize: '12px', color: 'var(--foreground)', cursor: 'pointer' }}>
              数据局限（{limitations.length} 条）
            </summary>
            <div style={{ marginTop: 8 }}>
              {limitations.map((text) => (
                <NoteLine key={text} text={text} />
              ))}
            </div>
          </details>

          {/* ── 免责声明：始终可见，不折叠 ── */}
          <div style={{ fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6, marginBottom: 8 }}>
            {report.disclaimer}
          </div>
        </div>

        {/* ── 页脚 ── */}
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            paddingTop: 10,
            marginTop: 4,
            borderTop: '1px solid var(--border)',
            fontSize: '10px',
            color: 'var(--muted)'
          }}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isString(report.generatedAt) && report.generatedAt ? `生成于 ${report.generatedAt} · ` : ''}
            区间 {window.startDate || '—'} ~ {window.endDate || '—'}
            {isNumber(window.sampleCount) ? ` · ${window.sampleCount} 个交易日` : ''}
            {report.benchmark?.name ? ` · 基准 ${report.benchmark.name}` : ''}
          </span>
          <button
            type="button"
            onClick={copyMarkdown}
            style={{
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--foreground)',
              fontSize: '11px',
              padding: '4px 8px',
              cursor: 'pointer'
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制 Markdown'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
