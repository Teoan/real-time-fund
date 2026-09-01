/**
 * TopK mappers 单元测试
 *
 * 运行：node --test app/providers/topk/__tests__/mappers.test.js
 *
 * 覆盖：
 *   - 中文/AKShare 字段 → Domain Model 映射
 *   - NaN / NaT / 空字符串 → null
 *   - 日期归一为 YYYY-MM-DD
 *   - 季度字符串 → 季度末日期
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapHoldingRow,
  mapNavHistoryRow,
  mapOverviewRows,
  mapSearchFundRow,
  __test__ as mappersInternals
} from '../topk-mappers.js';

describe('mapSearchFundRow', () => {
  it('正常行映射', () => {
    const out = mapSearchFundRow({
      基金代码: '110022',
      基金简称: '易方达消费行业',
      基金类型: '股票型'
    });
    assert.deepEqual(out, { code: '110022', name: '易方达消费行业', type: '股票型' });
  });

  it('空响应返回 null', () => {
    assert.equal(mapSearchFundRow(null), null);
    assert.equal(mapSearchFundRow({}), null);
  });

  it('NaN 字符串归一为 null', () => {
    const out = mapSearchFundRow({
      基金代码: '110022',
      基金简称: 'NaN',
      基金类型: 'NaN'
    });
    assert.deepEqual(out, { code: '110022', name: null, type: null });
  });

  it('格式异常：基金代码非字符串时仍能字符串化', () => {
    // pickString 对非 null 值统一 String() 转换，便于兼容某些 AKShare 字段返回 number 的情况
    const out = mapSearchFundRow({ 基金代码: 110022 });
    assert.equal(out.code, '110022');
  });
});

describe('mapNavHistoryRow', () => {
  it('正常行映射', () => {
    const out = mapNavHistoryRow({
      净值日期: '2024-06-01',
      单位净值: 1.2345,
      日增长率: 0.56
    });
    assert.deepEqual(out, {
      date: '2024-06-01',
      unitNav: 1.2345,
      accumulatedNav: null,
      dailyReturn: 0.56
    });
  });

  it('日期 YYYYMMDD 归一为 YYYY-MM-DD', () => {
    const out = mapNavHistoryRow({ 净值日期: '20240601', 单位净值: 1.0 });
    assert.equal(out.date, '2024-06-01');
  });

  it('日期带时间只取前 10 位', () => {
    const out = mapNavHistoryRow({ 净值日期: '2024-06-01 09:30:00', 单位净值: 1.0 });
    assert.equal(out.date, '2024-06-01');
  });

  it('非法日期返回 null', () => {
    assert.equal(mapNavHistoryRow({ 净值日期: 'bad', 单位净值: 1.0 }), null);
  });

  it('NaN 日增长率归一为 null', () => {
    const out = mapNavHistoryRow({ 净值日期: '2024-06-01', 单位净值: 'NaN', 日增长率: 'nan' });
    assert.equal(out.unitNav, null);
    assert.equal(out.dailyReturn, null);
  });

  it('带百分号的字符串解析', () => {
    const out = mapNavHistoryRow({ 净值日期: '2024-06-01', 单位净值: '1.23%' });
    assert.equal(out.unitNav, 1.23);
  });
});

describe('mapHoldingRow', () => {
  it('正常行映射', () => {
    const out = mapHoldingRow({
      股票代码: '600519',
      股票名称: '贵州茅台',
      占净值比例: 5.23,
      持股数: 12.34,
      持仓市值: 23456.78,
      季度: '2024 年2季度股票投资明细'
    });
    assert.deepEqual(out, {
      stockCode: '600519',
      stockName: '贵州茅台',
      weight: 5.23,
      shares: 12.34,
      marketValue: 23456.78,
      reportDate: '2024-06-30'
    });
  });

  it('空行/无股票信息返回 null', () => {
    assert.equal(mapHoldingRow(null), null);
    assert.equal(mapHoldingRow({}), null);
  });

  it('季度解析：4 季度 = 12-31', () => {
    const out = mapHoldingRow({
      股票代码: 'A',
      股票名称: 'B',
      季度: '2023 年4季度股票投资明细'
    });
    assert.equal(out.reportDate, '2023-12-31');
  });
});

describe('mapOverviewRows', () => {
  it('正常行映射', () => {
    const rows = [
      { item: '基金名称', value: '华夏成长混合' },
      { item: '基金公司', value: '华夏基金管理有限公司' }
    ];
    assert.deepEqual(mapOverviewRows(rows), {
      基金名称: '华夏成长混合',
      基金公司: '华夏基金管理有限公司'
    });
  });

  it('非数组返回 null', () => {
    assert.equal(mapOverviewRows(null), null);
    assert.equal(mapOverviewRows({}), null);
  });
});

describe('mappers internals', () => {
  it('toIsoDate 拒绝非法字符串', () => {
    assert.equal(mappersInternals.toIsoDate('not-a-date'), null);
    assert.equal(mappersInternals.toIsoDate(null), null);
  });
  it('toFiniteNumber 拒绝 NaN/Infinity', () => {
    assert.equal(mappersInternals.toFiniteNumber(NaN), null);
    assert.equal(mappersInternals.toFiniteNumber(Infinity), null);
    assert.equal(mappersInternals.toFiniteNumber('abc'), null);
    assert.equal(mappersInternals.toFiniteNumber('1.23'), 1.23);
  });
});
