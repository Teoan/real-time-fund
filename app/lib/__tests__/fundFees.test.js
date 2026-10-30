import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isValueInTier,
  pickFeeTier,
  calcTierFee,
  getSubscriptionFee,
  getRedemptionFee,
  calcHoldingDays,
  formatFeeRate,
  formatFeeAmount,
  buildFeeTierRows
} from '../fundFees.js';

/**
 * 真实费率阶梯样本（AKShare fund_individual_detail_info_xq，基金 110022）。
 * 最后一个买入档是固定费用档：1000 元/笔（不是 1000%）。
 */
const FEE_TIERS = {
  buy: [
    {
      min: 0,
      minInclusive: false,
      max: 1000000,
      maxInclusive: false,
      unit: 'amount',
      rate: 1.5,
      fixedFee: null,
      label: '0.0万<买入金额<100.0万'
    },
    {
      min: 1000000,
      minInclusive: true,
      max: 5000000,
      maxInclusive: false,
      unit: 'amount',
      rate: 1.2,
      fixedFee: null,
      label: '100.0万<=买入金额<500.0万'
    },
    {
      min: 5000000,
      minInclusive: true,
      max: 10000000,
      maxInclusive: false,
      unit: 'amount',
      rate: 0.3,
      fixedFee: null,
      label: '500.0万<=买入金额<1000.0万'
    },
    {
      min: 10000000,
      minInclusive: true,
      max: null,
      maxInclusive: false,
      unit: 'amount',
      rate: null,
      fixedFee: 1000,
      label: '1000.0万<=买入金额'
    }
  ],
  sell: [
    {
      min: 0,
      minInclusive: false,
      max: 7,
      maxInclusive: false,
      unit: 'days',
      rate: 1.5,
      fixedFee: null,
      label: '0.0天<持有期限<7.0天'
    },
    {
      min: 7,
      minInclusive: true,
      max: 365,
      maxInclusive: false,
      unit: 'days',
      rate: 0.5,
      fixedFee: null,
      label: '7.0天<=持有期限<365.0天'
    },
    {
      min: 365,
      minInclusive: true,
      max: 730,
      maxInclusive: false,
      unit: 'days',
      rate: 0.25,
      fixedFee: null,
      label: '365.0天<=持有期限<2.0年'
    },
    {
      min: 730,
      minInclusive: true,
      max: null,
      maxInclusive: false,
      unit: 'days',
      rate: 0,
      fixedFee: null,
      label: '2.0年<=持有期限'
    }
  ],
  other: { managementFee: 1.2, custodianFee: 0.2, salesServiceFee: null },
  hasTiers: true
};

test('isValueInTier: 开区间不含边界，闭区间含边界', () => {
  const [tier0, tier1] = FEE_TIERS.buy;
  // 0 万 < x < 100 万（下界开）
  assert.equal(isValueInTier(tier0, 0), false);
  assert.equal(isValueInTier(tier0, 0.01), true);
  assert.equal(isValueInTier(tier0, 999999.99), true);
  assert.equal(isValueInTier(tier0, 1000000), false);
  // 100 万 <= x < 500 万（下界闭）
  assert.equal(isValueInTier(tier1, 1000000), true);
  assert.equal(isValueInTier(tier1, 4999999), true);
  assert.equal(isValueInTier(tier1, 5000000), false);
});

test('isValueInTier: 无上界档位', () => {
  const top = FEE_TIERS.buy[3];
  assert.equal(isValueInTier(top, 10000000), true);
  assert.equal(isValueInTier(top, 999999999), true);
  assert.equal(isValueInTier(top, 9999999), false);
});

test('isValueInTier: 非法输入一律 false', () => {
  assert.equal(isValueInTier(null, 100), false);
  assert.equal(isValueInTier(FEE_TIERS.buy[0], null), false);
  assert.equal(isValueInTier(FEE_TIERS.buy[0], NaN), false);
});

test('pickFeeTier: 按金额命中正确档位', () => {
  assert.equal(pickFeeTier(FEE_TIERS.buy, 1000).rate, 1.5);
  assert.equal(pickFeeTier(FEE_TIERS.buy, 2000000).rate, 1.2);
  assert.equal(pickFeeTier(FEE_TIERS.buy, 6000000).rate, 0.3);
  assert.equal(pickFeeTier(FEE_TIERS.buy, 20000000).fixedFee, 1000);
});

test('pickFeeTier: 恰好落在边界值上取下界闭的那一档', () => {
  // 100 万整：属于「100万<=x<500万」，不属于「0<x<100万」
  assert.equal(pickFeeTier(FEE_TIERS.buy, 1000000).rate, 1.2);
  // 7 天整：属于「7天<=x<365天」，不再收 1.5% 惩罚性费率
  assert.equal(pickFeeTier(FEE_TIERS.sell, 7).rate, 0.5);
});

test('pickFeeTier: 空阶梯返回 null', () => {
  assert.equal(pickFeeTier([], 100), null);
  assert.equal(pickFeeTier(null, 100), null);
  assert.equal(pickFeeTier(undefined, 100), null);
});

test('pickFeeTier: 区间有缝隙时兜底到覆盖该值的档位', () => {
  // 构造一个「缝隙」：0<x<100 与 200<=x，输入 150 谁都不匹配
  const gapped = [
    { min: 0, minInclusive: false, max: 100, maxInclusive: false, rate: 2 },
    { min: 200, minInclusive: true, max: null, rate: 1 }
  ];
  const picked = pickFeeTier(gapped, 150);
  assert.equal(picked.rate, 1);
});

test('calcTierFee: 比例档与固定档', () => {
  assert.equal(calcTierFee({ rate: 1.5, fixedFee: null }, 10000), 150);
  assert.equal(calcTierFee({ rate: null, fixedFee: 1000 }, 20000000), 1000);
  assert.equal(calcTierFee(null, 10000), null);
  assert.equal(calcTierFee({ rate: null, fixedFee: null }, 10000), null);
});

test('getSubscriptionFee: 小额按比例、大额按每笔固定', () => {
  const small = getSubscriptionFee(FEE_TIERS, 10000);
  assert.equal(small.rate, 1.5);
  assert.equal(small.fee, 150);
  assert.equal(small.tier.label, '0.0万<买入金额<100.0万');

  const large = getSubscriptionFee(FEE_TIERS, 20000000);
  assert.equal(large.rate, null);
  assert.equal(large.fixedFee, 1000);
  assert.equal(large.fee, 1000);
});

test('getSubscriptionFee: 无费率数据时返回全 null（不把未知当免费）', () => {
  const r = getSubscriptionFee(null, 10000);
  assert.deepEqual(r, { rate: null, fixedFee: null, fee: null, tier: null });
});

test('getRedemptionFee: 短期惩罚费率与长期免费', () => {
  assert.equal(getRedemptionFee(FEE_TIERS, 10000, 3).rate, 1.5);
  assert.equal(getRedemptionFee(FEE_TIERS, 10000, 3).fee, 150);
  assert.equal(getRedemptionFee(FEE_TIERS, 10000, 30).rate, 0.5);
  assert.equal(getRedemptionFee(FEE_TIERS, 10000, 400).rate, 0.25);
  const longTerm = getRedemptionFee(FEE_TIERS, 10000, 1000);
  assert.equal(longTerm.rate, 0);
  assert.equal(longTerm.fee, 0);
});

test('calcHoldingDays: 跨月/跨年自然日差', () => {
  assert.equal(calcHoldingDays('2026-01-01', '2026-01-08'), 7);
  assert.equal(calcHoldingDays('2025-12-31', '2026-01-01'), 1);
  assert.equal(calcHoldingDays('2026-01-01', '2026-12-31'), 364);
  // 卖出早于买入 → 0，不返回负数
  assert.equal(calcHoldingDays('2026-02-01', '2026-01-01'), 0);
  assert.equal(calcHoldingDays('', '2026-01-01'), null);
});

test('formatFeeRate / formatFeeAmount', () => {
  assert.equal(formatFeeRate(1.5), '1.50%');
  assert.equal(formatFeeRate(null, 1000), '1000 元/笔');
  assert.equal(formatFeeRate(null, null), '—');
  assert.equal(formatFeeAmount(150), '¥150.00');
  assert.equal(formatFeeAmount(null), '—');
});

test('buildFeeTierRows: 金额档渲染区间文案', () => {
  const rows = buildFeeTierRows(FEE_TIERS.buy, 'amount');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].rateText, '1.50%');
  assert.match(rows[0].rangeText, /万/);
  assert.equal(rows[3].rateText, '1000 元/笔');
});

test('buildFeeTierRows: 天数档渲染区间文案', () => {
  const rows = buildFeeTierRows(FEE_TIERS.sell, 'days');
  assert.equal(rows.length, 4);
  assert.match(rows[0].rangeText, /天/);
  assert.equal(rows[3].rateText, '0.00%');
});
