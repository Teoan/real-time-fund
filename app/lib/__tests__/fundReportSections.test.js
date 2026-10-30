/**
 * 外部档案补充段（AKShare 单基金接口）单测
 *
 * 覆盖 buildProfileSection / buildFeeSection / buildPeerSection / buildFundResearchReport 的
 * profile·feeTiers·achievement·probability 入参：
 *   1. 全部缺失 → 段落返回 null，原有假设不产生空章节
 *   2. 有数据 → 章节结构稳定（key/title/items/notes/external）
 *   3. 补充段不参与指标画像评分（rating.score 与不传时一致）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProfileSection, buildFeeSection, buildPeerSection, buildFundResearchReport } from '../fundReport.js';

/** 构造一份最小可用 metrics（只保证评分链路能跑通） */
const baseMetrics = {
  startDate: '2021-01-04',
  endDate: '2024-01-02',
  sampleCount: 750,
  cagr: 8.2,
  maxDrawdown: -21.5,
  volatility: 18.4,
  riskFreeRate: 2,
  benchmarkName: '沪深300',
  pairedSampleCount: 750,
  insufficient: false
};

const profileSample = {
  fullName: '易方达消费行业股票型证券投资基金',
  shortName: '易方达消费行业股票',
  type: '股票型',
  establishDate: '2010-08-20',
  scale: { value: 101.09, unit: '亿元', asOf: '2025-09-30' },
  shares: { value: 45.2, unit: '亿份', asOf: '2025-09-30' },
  company: '易方达基金管理有限公司',
  custodian: '中国工商银行',
  manager: '萧楠',
  dividendSinceStart: '每份累计 1.25 元',
  managementFee: 1.2,
  custodianFee: 0.2,
  salesServiceFee: null,
  maxSubscriptionFee: 1.5,
  benchmark: '中证内地消费主题指数收益率×80%+中债总指数收益率×20%',
  trackingIndex: null
};

const feeTiersSample = {
  code: '110022',
  hasTiers: true,
  buy: [
    { min: 0, minInclusive: true, max: 1000000, maxInclusive: true, rate: 1.5, fixedFee: null, unit: 'amount' },
    { min: 1000000, minInclusive: false, max: null, maxInclusive: false, rate: null, fixedFee: 1000, unit: 'amount' }
  ],
  sell: [
    { min: 0, minInclusive: true, max: 7, maxInclusive: false, rate: 1.5, fixedFee: null, unit: 'days' },
    { min: 7, minInclusive: true, max: 365, maxInclusive: true, rate: 0.5, fixedFee: null, unit: 'days' }
  ],
  other: { managementFee: 1.2, custodianFee: 0.2, salesServiceFee: null }
};

const achievementSample = {
  windows: [
    {
      periodLabel: '近一年',
      category: '股票型',
      returnPct: 12.4,
      maxDrawdown: -18.2,
      rank: 120,
      total: 900,
      percentile: 13.3
    },
    {
      periodLabel: '近三年',
      category: '股票型',
      returnPct: 30.1,
      maxDrawdown: -35.4,
      rank: 300,
      total: 800,
      percentile: 37.5
    }
  ]
};

const probabilitySample = {
  items: [
    { label: '持有 1 年', months: 12, winRate: 68.4, avgReturn: 9.1 },
    { label: '持有 3 年', months: 36, winRate: 82.2, avgReturn: 28.4 }
  ]
};

test('buildProfileSection：无数据返回 null', () => {
  assert.equal(buildProfileSection(null), null);
  assert.equal(buildProfileSection({}), null);
  // 全部字段为 null 时也不该产出空章节
  assert.equal(buildProfileSection({ type: null, company: null, manager: null }), null);
});

test('buildProfileSection：有数据时生成外部章节', () => {
  const section = buildProfileSection(profileSample);
  assert.ok(section);
  assert.equal(section.key, 'profile');
  assert.equal(section.external, true);
  assert.equal(section.unavailable, false);

  const byKey = new Map(section.items.map((item) => [item.key, item]));
  assert.equal(byKey.get('scale').valueText, '101.09亿元');
  assert.equal(byKey.get('managementFee').valueText, '1.20%');
  assert.equal(byKey.get('salesServiceFee').valueText, null);
  assert.equal(byKey.get('manager').valueText, '萧楠');
  // 披露口径提示必须在 notes 里
  assert.ok(section.notes.some((n) => n.includes('披露口径')));
  assert.ok(section.notes.some((n) => n.includes('2025-09-30')));
});

test('buildFeeSection：无阶梯返回 null，有阶梯时汇总档位与首档费率', () => {
  assert.equal(buildFeeSection(null), null);
  assert.equal(buildFeeSection({ hasTiers: false }), null);

  const section = buildFeeSection(feeTiersSample);
  assert.ok(section);
  assert.equal(section.key, 'feeTiers');
  const byKey = new Map(section.items.map((item) => [item.key, item]));
  assert.equal(byKey.get('buyTiers').valueText, '2 档');
  assert.equal(byKey.get('sellTiers').valueText, '2 档');
  assert.equal(byKey.get('buyFirst').valueText, '1.5%');
  assert.equal(byKey.get('sellFirst').valueText, '1.5%');
  // 固定费用档应在备注里以「元/笔」出现
  assert.ok(section.notes.some((n) => n.includes('1000 元/笔')));
});

test('buildPeerSection：无数据返回 null，有数据时给出最长区间与胜率', () => {
  assert.equal(buildPeerSection(null, null), null);
  assert.equal(buildPeerSection({ windows: [] }, { items: [] }), null);

  const section = buildPeerSection(achievementSample, probabilitySample);
  assert.ok(section);
  assert.equal(section.key, 'peerRank');
  const byKey = new Map(section.items.map((item) => [item.key, item]));
  // 概览取第一项（最近区间：近一年）
  assert.equal(byKey.get('latestRank').valueText, '120/900');
  assert.equal(byKey.get('latestReturn').valueText, '12.40%');
  assert.equal(byKey.get('latestDrawdown').valueText, '-18.20%');
  assert.equal(byKey.get('winRate').valueText, '68.40%');
  // 备注里应列出全部（最多 3 个）区间排名
  assert.ok(section.notes.some((n) => n.includes('近三年 30.10%（300/800）')));
  assert.ok(section.notes.some((n) => n.includes('不构成未来收益预测')));
});

test('buildFundResearchReport：不传外部数据时 sections 不含外部章节', () => {
  const report = buildFundResearchReport({ code: '110022', name: '易方达消费行业', metrics: baseMetrics });
  assert.deepEqual(report.externalSections, []);
  assert.equal(
    report.sections.some((s) => s.key === 'profile' || s.key === 'feeTiers' || s.key === 'peerRank'),
    false
  );
});

test('buildFundResearchReport：外部章节追加在末尾且不影响评分', () => {
  const plain = buildFundResearchReport({ code: '110022', metrics: baseMetrics });
  const enriched = buildFundResearchReport({
    code: '110022',
    metrics: baseMetrics,
    profile: profileSample,
    feeTiers: feeTiersSample,
    achievement: achievementSample,
    probability: probabilitySample
  });

  assert.equal(enriched.externalSections.length, 3);
  // 外部段在末尾
  const tailKeys = enriched.sections.slice(-3).map((s) => s.key);
  assert.deepEqual(tailKeys, ['profile', 'feeTiers', 'peerRank']);
  // 评分与结论不受外部数据影响
  assert.equal(enriched.rating.score, plain.rating.score);
  assert.equal(enriched.headline, plain.headline);
  // Markdown 中包含外部章节标题
  assert.ok(enriched.markdown.includes('基金档案（公司披露）'));
  assert.ok(enriched.markdown.includes('申赎费率阶梯'));
  assert.ok(enriched.markdown.includes('同业位置与持有概率'));
});
