'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isArray, isNumber, isString } from 'lodash';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { CloseIcon } from './Icons';
import * as qk from '@/app/lib/query-keys';
import {
  fetchFundProfileOverview,
  fetchFundFeeTiers,
  fetchFundDividendDetail,
  fetchFundAchievement,
  fetchFundProfitProbability,
  fetchFundIndustryAllocation,
  fetchFundBondHoldings,
  fetchFundPortfolioChange
} from '@/app/api/fund';
import { buildFeeTierRows, formatFeeRate } from '@/app/lib/fundFees';

/**
 * 基金档案弹框（只读）
 *
 * 数据全部来自 AKShare 单基金接口（经 AKTools 转发），与估值/交易链路完全解耦：
 *   - 概况：fund_overview_em → 费率、规模、成立日、业绩基准
 *   - 费率：fund_individual_detail_info_xq → 申购/赎回阶梯 + 管理费/托管费/销售服务费
 *   - 分红：fund_open_fund_info_em(分红送配详情)
 *   - 同业：fund_individual_achievement_xq + fund_individual_profit_probability_xq
 *   - 组合：fund_portfolio_industry_allocation_em + fund_portfolio_bond_hold_em + fund_portfolio_change_em
 *
 * 每个模块独立 query：某个接口挂了只影响自己那一屏，其余照常展示。
 * 能力开关关闭时 fetcher 直接返回 null（见 app/api/fund.js），此处按 null 显示「暂未开放」，
 * 与「加载失败」区分开，避免误导。
 *
 * ⚠️ 本弹框不修改任何持仓/交易数据，所有数字均为「基金公司披露口径」，
 *    与 App 内的估算收益不是同一口径（估算收益见持仓页）。
 */

const TABS = [
  { key: 'overview', label: '概况' },
  { key: 'fees', label: '费率' },
  { key: 'dividend', label: '分红' },
  { key: 'peer', label: '同业' },
  { key: 'portfolio', label: '组合' }
];

/** 档案数据是季度/年度披露口径，日内不需要重复拉取 */
const PROFILE_STALE_MS = 60 * 60 * 1000;

const fmtPct = (v, digits = 2) => (isNumber(v) && Number.isFinite(v) ? `${v.toFixed(digits)}%` : '—');

const fmtAmount = (v, unit = '') => {
  if (!isNumber(v) || !Number.isFinite(v)) return '—';
  return `${v}${unit}`;
};

const fmtDate = (v) => (isString(v) && v ? v : '—');

/** 小节标题 */
function SectionTitle({ children, extra }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        margin: '14px 0 8px',
        fontSize: '12px',
        fontWeight: 600,
        color: 'var(--muted)'
      }}
    >
      <span>{children}</span>
      {extra ? <span style={{ fontWeight: 400, fontSize: '11px' }}>{extra}</span> : null}
    </div>
  );
}

/** 键值行 */
function InfoRow({ label, value, mono = false }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '5px 0',
        fontSize: '13px',
        borderBottom: '1px dashed rgba(255,255,255,0.06)'
      }}
    >
      <span style={{ color: 'var(--muted)', flexShrink: 0, minWidth: 84 }}>{label}</span>
      <span style={{ flex: 1, textAlign: 'right', fontVariantNumeric: mono ? 'tabular-nums' : undefined }}>
        {value}
      </span>
    </div>
  );
}

/**
 * 披露时效提示：季报最迟披露延迟约 15 个工作日，超过 120 天视为陈旧数据。
 * @param {string|null} reportDate - YYYY-MM-DD
 * @returns {string|null}
 */
const staleNote = (reportDate) => {
  if (!isString(reportDate) || !reportDate) return null;
  const t = Date.parse(reportDate);
  if (Number.isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days < 0) return null;
  if (days > 120) return `披露于 ${reportDate}，已过去 ${days} 天，可能不是最新报告期。`;
  return `披露于 ${reportDate}（${days} 天前）。`;
};

/** 空态 / 未开放提示 */
function Hint({ text }) {
  return (
    <div style={{ padding: '18px 8px', textAlign: 'center', fontSize: '12px', color: 'var(--muted)' }}>{text}</div>
  );
}

function Loading({ text = '加载中…' }) {
  return (
    <div style={{ padding: '18px 8px', textAlign: 'center', fontSize: '12px', color: 'var(--muted)' }}>{text}</div>
  );
}

/** 简单表格 */
function MiniTable({ head, rows }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: 'left',
                  padding: '4px 6px',
                  color: 'var(--muted)',
                  fontWeight: 500,
                  borderBottom: '1px solid var(--border)',
                  whiteSpace: 'nowrap'
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: '4px 6px',
                    borderBottom: '1px dashed rgba(255,255,255,0.06)',
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverviewTab({ code, query, feesQuery }) {
  if (query.isLoading) return <Loading />;
  const data = query.data;
  if (data == null) return <Hint text="该基金暂无基本概况数据（或功能未开放）" />;

  return (
    <div>
      <SectionTitle>基本信息</SectionTitle>
      <InfoRow label="基金全称" value={fmtDate(data.fullName)} />
      <InfoRow label="基金类型" value={fmtDate(data.type)} />
      <InfoRow label="成立日期" value={fmtDate(data.establishDate)} />
      <InfoRow label="管理人" value={fmtDate(data.company)} />
      <InfoRow label="托管人" value={fmtDate(data.custodian)} />
      <InfoRow label="基金经理" value={fmtDate(data.manager)} />

      <SectionTitle>规模（披露口径）</SectionTitle>
      <InfoRow
        label="净资产"
        value={
          data.scale
            ? `${fmtAmount(data.scale.value, data.scale.unit)}${data.scale.asOf ? `（${data.scale.asOf}）` : ''}`
            : '—'
        }
        mono
      />
      <InfoRow
        label="份额"
        value={
          data.shares
            ? `${fmtAmount(data.shares.value, data.shares.unit)}${data.shares.asOf ? `（${data.shares.asOf}）` : ''}`
            : '—'
        }
        mono
      />
      <InfoRow
        label="成立规模"
        value={data.establishScale ? fmtAmount(data.establishScale.value, data.establishScale.unit) : '—'}
        mono
      />

      <SectionTitle>费率（与「费率」页同源）</SectionTitle>
      <InfoRow label="管理费" value={formatFeeRate(data.managementFee)} mono />
      <InfoRow label="托管费" value={formatFeeRate(data.custodianFee)} mono />
      <InfoRow label="销售服务费" value={formatFeeRate(data.salesServiceFee)} mono />
      <InfoRow label="最高认购费" value={formatFeeRate(data.maxSubscriptionFee)} mono />
      {feesQuery?.data?.hasTiers ? (
        <InfoRow
          label="申购费起"
          value={formatFeeRate(feesQuery.data?.buy?.[0]?.rate, feesQuery.data?.buy?.[0]?.fixedFee)}
          mono
        />
      ) : null}

      <SectionTitle>业绩与分红</SectionTitle>
      <InfoRow label="业绩基准" value={fmtDate(data.benchmark)} />
      <InfoRow label="跟踪标的" value={data.trackingIndex || '无（非指数基金）'} />
      <InfoRow label="成立来分红" value={fmtDate(data.dividendSinceStart)} />
    </div>
  );
}

function FeesTab({ query }) {
  if (query.isLoading) return <Loading />;
  const data = query.data;
  if (data == null) return <Hint text="该基金暂无费率数据（或功能未开放）" />;
  if (!data.hasTiers) return <Hint text="该基金未提供申赎费率阶梯（常见于货币基金/场内基金）" />;

  const buyRows = buildFeeTierRows(data.buy, 'amount');
  const sellRows = buildFeeTierRows(data.sell, 'days');

  return (
    <div>
      <SectionTitle extra={`${buyRows.length} 档`}>申购费率（按买入金额）</SectionTitle>
      {buyRows.length > 0 ? (
        <MiniTable head={['金额区间', '费率']} rows={buyRows.map((r) => [r.rangeText, r.rateText])} />
      ) : (
        <Hint text="无申购费率阶梯" />
      )}

      <SectionTitle extra={`${sellRows.length} 档`}>赎回费率（按持有期限）</SectionTitle>
      {sellRows.length > 0 ? (
        <MiniTable head={['持有期限', '费率']} rows={sellRows.map((r) => [r.rangeText, r.rateText])} />
      ) : (
        <Hint text="无赎回费率阶梯" />
      )}

      <SectionTitle>固定费率</SectionTitle>
      <InfoRow label="管理费" value={formatFeeRate(data.other?.managementFee)} mono />
      <InfoRow label="托管费" value={formatFeeRate(data.other?.custodianFee)} mono />
      <InfoRow label="销售服务费" value={formatFeeRate(data.other?.salesServiceFee)} mono />

      <div style={{ marginTop: 12, fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6 }}>
        费率为基金公司披露口径，实际扣费以确认单为准；持有不满 7 天通常收取 1.5% 惩罚性赎回费。
      </div>
    </div>
  );
}

function DividendTab({ query }) {
  if (query.isLoading) return <Loading />;
  const data = query.data;
  if (data == null) return <Hint text="该基金暂无分红数据（或功能未开放）" />;
  const items = isArray(data.items) ? data.items : [];
  if (items.length === 0) return <Hint text="暂无分红记录" />;

  return (
    <div>
      <SectionTitle extra={`共 ${items.length} 次`}>分红记录（最新在前）</SectionTitle>
      <MiniTable
        head={['除息日', '每份分红', '权益登记日', '发放日']}
        rows={items.map((it) => [
          fmtDate(it.exDate),
          isNumber(it.perShare) ? `¥${it.perShare.toFixed(4)}` : '—',
          fmtDate(it.recordDate),
          fmtDate(it.payDate)
        ])}
      />
      <div style={{ marginTop: 12, fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6 }}>
        「每份分红」由上游「每 10 份派现金」除以 10 折算；分红方式（现金/红利再投）在「持仓操作 → 分红方式」中设置。
      </div>
    </div>
  );
}

function PeerTab({ achievementQuery, probabilityQuery }) {
  const ach = achievementQuery.data;
  const prob = probabilityQuery.data;

  if (achievementQuery.isLoading && probabilityQuery.isLoading) return <Loading />;

  const windows = isArray(ach?.windows) ? ach.windows : [];
  const probs = isArray(prob?.items) ? prob.items : [];

  return (
    <div>
      <SectionTitle extra={ach ? `更新于 ${new Date(ach.fetchedAt).toLocaleDateString('zh-CN')}` : undefined}>
        区间表现与同类排名
      </SectionTitle>
      {ach == null ? (
        <Hint text="暂无同类业绩数据（或功能未开放）" />
      ) : windows.length === 0 ? (
        <Hint text="暂无区间业绩记录" />
      ) : (
        <MiniTable
          head={['周期', '区间收益', '最大回撤', '同类排名']}
          rows={windows.map((w) => [
            w.periodLabel,
            fmtPct(w.returnPct),
            fmtPct(w.maxDrawdown),
            isNumber(w.rank) && isNumber(w.total) ? `${w.rank}/${w.total}（前 ${fmtPct(w.percentile, 1)}）` : '—'
          ])}
        />
      )}

      <SectionTitle>持有盈利概率（历史统计）</SectionTitle>
      {prob == null ? (
        <Hint text="暂无盈利概率数据（或功能未开放）" />
      ) : probs.length === 0 ? (
        <Hint text="暂无持有概率样本" />
      ) : (
        <MiniTable
          head={['持有时长', '盈利概率', '平均收益']}
          rows={probs.map((p) => [p.label, fmtPct(p.winRate, 0), fmtPct(p.avgReturn)])}
        />
      )}

      <div style={{ marginTop: 12, fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6 }}>
        排名与概率均为历史统计，不构成未来收益预测。
      </div>
    </div>
  );
}

function PortfolioTab({ industryQuery, bondQuery, changeQuery, side, onChangeSide }) {
  const industry = isArray(industryQuery.data?.items) ? industryQuery.data.items : [];
  const bonds = isArray(bondQuery.data?.items) ? bondQuery.data.items : [];
  const changes = isArray(changeQuery.data?.items) ? changeQuery.data.items : [];

  return (
    <div>
      <SectionTitle extra={industryQuery.data?.reportDate || undefined}>行业配置（基金季报口径）</SectionTitle>
      {industryQuery.isLoading ? (
        <Loading />
      ) : industry.length === 0 ? (
        <Hint text="暂无行业配置披露" />
      ) : (
        <MiniTable head={['行业', '占净值比']} rows={industry.map((it) => [it.name, fmtPct(it.weight)])} />
      )}

      <SectionTitle extra={bondQuery.data?.reportDate || undefined}>债券持仓</SectionTitle>
      {bondQuery.isLoading ? (
        <Loading />
      ) : bonds.length === 0 ? (
        <Hint text="暂无债券持仓（股票型基金常见）" />
      ) : (
        <MiniTable head={['债券', '占净值比']} rows={bonds.map((b) => [b.name || b.code || '—', fmtPct(b.weight)])} />
      )}

      <SectionTitle
        extra={
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button
              type="button"
              className="button secondary"
              onClick={() => onChangeSide('buy')}
              style={{
                padding: '0 8px',
                height: 22,
                fontSize: 11,
                opacity: side === 'buy' ? 1 : 0.55
              }}
            >
              累计买入
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => onChangeSide('sell')}
              style={{
                padding: '0 8px',
                height: 22,
                fontSize: 11,
                opacity: side === 'sell' ? 1 : 0.55
              }}
            >
              累计卖出
            </button>
          </span>
        }
      >
        本季调仓（{side === 'buy' ? '买入' : '卖出'}）
      </SectionTitle>
      {changeQuery.isLoading ? (
        <Loading />
      ) : changes.length === 0 ? (
        <Hint text="暂无调仓明细" />
      ) : (
        <MiniTable
          head={['股票', '金额（万元）', '占期初净值']}
          rows={changes.map((c) => [
            c.name || c.code || '—',
            isNumber(c.amount) ? c.amount.toFixed(2) : '—',
            fmtPct(c.weightOfNav)
          ])}
        />
      )}

      <div style={{ marginTop: 12, fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6 }}>
        行业与债券数据来自基金定期报告，披露滞后于实时行情；「本季调仓」为累计口径，不是当日操作。
        {[
          ['行业配置', staleNote(industryQuery.data?.reportDate)],
          ['债券持仓', staleNote(bondQuery.data?.reportDate)],
          ['本季调仓', staleNote(changeQuery.data?.reportDate)]
        ]
          .filter(([, text]) => text)
          .map(([label, text]) => (
            <div key={label}>
              {label}：{text}
            </div>
          ))}
      </div>
    </div>
  );
}

export default function FundProfileModal({ fundCode, fundName, onClose }) {
  const [tab, setTab] = useState('overview');
  const [changeSide, setChangeSide] = useState('buy');
  const code = isString(fundCode) ? fundCode.trim() : '';
  const enabled = Boolean(code);

  const overviewQuery = useQuery({
    queryKey: qk.aktoolsFundOverview(code),
    queryFn: () => fetchFundProfileOverview(code),
    staleTime: PROFILE_STALE_MS,
    enabled
  });

  const feesQuery = useQuery({
    queryKey: qk.aktoolsFundFeeTiers(code),
    queryFn: () => fetchFundFeeTiers(code),
    staleTime: PROFILE_STALE_MS,
    enabled
  });

  const dividendQuery = useQuery({
    queryKey: qk.aktoolsFundDividendDetail(code),
    queryFn: () => fetchFundDividendDetail(code),
    staleTime: PROFILE_STALE_MS,
    // 只在切到分红页时才请求
    enabled: enabled && tab === 'dividend'
  });

  const achievementQuery = useQuery({
    queryKey: qk.aktoolsFundAchievement(code),
    queryFn: () => fetchFundAchievement(code),
    staleTime: PROFILE_STALE_MS,
    enabled: enabled && tab === 'peer'
  });

  const probabilityQuery = useQuery({
    queryKey: qk.aktoolsFundProfitProbability(code),
    queryFn: () => fetchFundProfitProbability(code),
    staleTime: PROFILE_STALE_MS,
    enabled: enabled && tab === 'peer'
  });

  const industryQuery = useQuery({
    queryKey: qk.aktoolsFundIndustryAllocation(code),
    queryFn: () => fetchFundIndustryAllocation(code),
    staleTime: PROFILE_STALE_MS,
    enabled: enabled && tab === 'portfolio'
  });

  const bondQuery = useQuery({
    queryKey: qk.aktoolsFundBondHoldings(code),
    queryFn: () => fetchFundBondHoldings(code),
    staleTime: PROFILE_STALE_MS,
    enabled: enabled && tab === 'portfolio'
  });

  const changeQuery = useQuery({
    queryKey: qk.aktoolsFundPortfolioChange(code, changeSide === 'sell' ? '累计卖出' : '累计买入'),
    queryFn: () => fetchFundPortfolioChange(code, changeSide),
    staleTime: PROFILE_STALE_MS,
    enabled: enabled && tab === 'portfolio'
  });

  const title = useMemo(() => {
    const fromOverview = overviewQuery.data?.shortName || overviewQuery.data?.fullName;
    return fundName || fromOverview || code;
  }, [fundName, overviewQuery.data, code]);

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose?.() : null)}>
      <DialogContent
        showCloseButton={false}
        className="glass card modal"
        overlayClassName="modal-overlay"
        style={{
          maxWidth: '560px',
          width: '92vw',
          maxHeight: '86vh',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 99
        }}
      >
        <DialogTitle className="sr-only">基金档案</DialogTitle>

        <div className="title" style={{ marginBottom: 10, justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: '15px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              📁 基金档案
            </span>
            <span
              style={{
                fontSize: '11px',
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {title}
              {code ? ` · #${code}` : ''}
            </span>
          </div>
          <button className="icon-button" onClick={onClose} style={{ border: 'none', background: 'transparent' }}>
            <CloseIcon width="20" height="20" />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexShrink: 0, overflowX: 'auto' }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className="button secondary"
              onClick={() => setTab(t.key)}
              style={{
                padding: '0 10px',
                height: 28,
                fontSize: 12,
                flexShrink: 0,
                opacity: tab === t.key ? 1 : 0.6,
                borderColor: tab === t.key ? 'var(--primary)' : 'var(--border)',
                color: tab === t.key ? 'var(--primary)' : 'var(--text)'
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', paddingRight: 2 }}>
          {tab === 'overview' && <OverviewTab code={code} query={overviewQuery} feesQuery={feesQuery} />}
          {tab === 'fees' && <FeesTab query={feesQuery} />}
          {tab === 'dividend' && <DividendTab query={dividendQuery} />}
          {tab === 'peer' && <PeerTab achievementQuery={achievementQuery} probabilityQuery={probabilityQuery} />}
          {tab === 'portfolio' && (
            <PortfolioTab
              industryQuery={industryQuery}
              bondQuery={bondQuery}
              changeQuery={changeQuery}
              side={changeSide}
              onChangeSide={setChangeSide}
            />
          )}
        </div>

        <div
          style={{
            flexShrink: 0,
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid var(--border)',
            fontSize: '11px',
            color: 'var(--muted)',
            lineHeight: 1.5
          }}
        >
          数据来源：AKShare / 天天基金·雪球公开披露。档案信息按季度更新，与实时估值口径不同。
        </div>
      </DialogContent>
    </Dialog>
  );
}
