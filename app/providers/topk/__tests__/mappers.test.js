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
  mapStockFundamentalLatest,
  mapStockValueRow,
  mapStockValueHistory,
  mapStockRoe,
  mapStockHkRoe,
  mapStockHkValueHistory,
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

describe('mapStockFundamentalLatest', () => {
  it('取最新交易日（按数据日期降序）', () => {
    const rows = [
      {
        数据日期: '2024-06-03T00:00:00.000',
        当日收盘价: 100,
        总市值: 1000000000,
        流通市值: 800000000,
        'PE(TTM)': 15.5,
        市净率: 2.3,
        市销率: 1.8,
        PEG值: 1.2
      },
      {
        数据日期: '2024-06-04T00:00:00.000',
        当日收盘价: 102,
        总市值: 1020000000,
        流通市值: 820000000,
        'PE(TTM)': 15.8,
        市净率: 2.35,
        市销率: 1.84,
        PEG值: 1.22
      }
    ];
    const out = mapStockFundamentalLatest(rows, { secid: '1.600519', market: 'A', code: '600519' });
    assert.equal(out.secid, '1.600519');
    assert.equal(out.market, 'A');
    assert.equal(out.code, '600519');
    assert.equal(out.price, 102);
    assert.equal(out.pe, 15.8);
    assert.equal(out.pb, 2.35);
    assert.equal(out.ps, 1.84);
    assert.equal(out.peg, 1.22);
    assert.equal(out.dividendYield, null);
    assert.equal(out.epsGrowth, null);
    assert.equal(typeof out.fetchedAt, 'number');
    assert.equal(typeof out.updateTime, 'number');
    assert.ok(out.updateTime > Date.parse('2024-06-03'));
  });

  it('空数组返回 null', () => {
    assert.equal(mapStockFundamentalLatest([], {}), null);
    assert.equal(mapStockFundamentalLatest(null, {}), null);
  });

  it('无效日期行被忽略（取有效行最新一条）', () => {
    const rows = [
      { 数据日期: 'bad', 'PE(TTM)': 99 },
      { 数据日期: '2024-06-01T00:00:00.000', 'PE(TTM)': 10 }
    ];
    const out = mapStockFundamentalLatest(rows, {});
    assert.equal(out.pe, 10);
  });

  it('NaN/NaT 数字字段归一为 null', () => {
    const rows = [
      {
        数据日期: '2024-06-01T00:00:00.000',
        当日收盘价: NaN,
        总市值: 'NaN',
        'PE(TTM)': 'NaT'
      }
    ];
    const out = mapStockFundamentalLatest(rows, {});
    assert.equal(out.price, null);
    assert.equal(out.totalMv, null);
    assert.equal(out.pe, null);
  });

  it('不传 ctx 时 market 默认为 A', () => {
    const out = mapStockFundamentalLatest([{ 数据日期: '2024-06-01T00:00:00.000', 'PE(TTM)': 12 }], {});
    assert.equal(out.market, 'A');
    assert.equal(out.secid, null);
  });
});

describe('mapStockValueRow', () => {
  it('中文列名 → 领域字段，日期归一', () => {
    const out = mapStockValueRow({
      数据日期: '2024-06-03T00:00:00.000',
      当日收盘价: 100,
      'PE(TTM)': 15.5,
      市净率: 2.3,
      市销率: 1.8,
      PEG值: 1.2
    });
    assert.deepEqual(out, {
      date: '2024-06-03',
      price: 100,
      pe: 15.5,
      pb: 2.3,
      ps: 1.8,
      peg: 1.2
    });
  });

  it('非法日期返回 null', () => {
    assert.equal(mapStockValueRow({ 数据日期: 'bad', 'PE(TTM)': 10 }), null);
    assert.equal(mapStockValueRow(null), null);
  });

  it('NaN/NaT 数字字段归一为 null', () => {
    const out = mapStockValueRow({
      数据日期: '2024-06-01T00:00:00.000',
      当日收盘价: NaN,
      'PE(TTM)': 'NaN',
      市净率: 'NaT'
    });
    assert.equal(out.price, null);
    assert.equal(out.pe, null);
    assert.equal(out.pb, null);
  });
});

describe('mapStockValueHistory', () => {
  it('按数据日期升序排序', () => {
    const out = mapStockValueHistory([
      { 数据日期: '2024-06-05T00:00:00.000', 'PE(TTM)': 17 },
      { 数据日期: '2024-06-03T00:00:00.000', 'PE(TTM)': 15 },
      { 数据日期: '2024-06-04T00:00:00.000', 'PE(TTM)': 16 }
    ]);
    assert.deepEqual(
      out.map((r) => r.date),
      ['2024-06-03', '2024-06-04', '2024-06-05']
    );
    assert.deepEqual(
      out.map((r) => r.pe),
      [15, 16, 17]
    );
  });

  it('非法行被丢弃', () => {
    const out = mapStockValueHistory([{ 数据日期: 'bad' }, { 数据日期: '2024-06-03T00:00:00.000', 'PE(TTM)': 15 }]);
    assert.equal(out.length, 1);
  });

  it('空/非数组 → 空数组', () => {
    assert.deepEqual(mapStockValueHistory([]), []);
    assert.deepEqual(mapStockValueHistory(null), []);
  });
});

describe('mapStockRoe', () => {
  it('取最近一期报告的加权净资产收益率', () => {
    const out = mapStockRoe([
      { 日期: '2025-06-30T00:00:00.000', '净资产收益率(%)': 15.1, '加权净资产收益率(%)': 14.2 },
      { 日期: '2026-06-30T00:00:00.000', '净资产收益率(%)': 17.72, '加权净资产收益率(%)': 16.75 }
    ]);
    assert.equal(out, 16.75);
  });

  it('乱序输入按报告期取最新', () => {
    const out = mapStockRoe([
      { 日期: '2026-06-30T00:00:00.000', '加权净资产收益率(%)': 16.75 },
      { 日期: '2025-06-30T00:00:00.000', '加权净资产收益率(%)': 14.2 }
    ]);
    assert.equal(out, 16.75);
  });

  it('加权列缺失时回退摊薄列', () => {
    const out = mapStockRoe([{ 日期: '2026-06-30T00:00:00.000', '净资产收益率(%)': 17.72 }]);
    assert.equal(out, 17.72);
  });

  it('最新一期为 NaN/NaT 时回退到上一期', () => {
    const out = mapStockRoe([
      { 日期: '2025-06-30T00:00:00.000', '加权净资产收益率(%)': 14.2 },
      { 日期: '2026-06-30T00:00:00.000', '加权净资产收益率(%)': 'NaN' }
    ]);
    assert.equal(out, 14.2);
  });

  it('空/非数组 → null', () => {
    assert.equal(mapStockRoe([]), null);
    assert.equal(mapStockRoe(null), null);
    assert.equal(mapStockRoe(undefined), null);
  });

  it('全部缺失 → null', () => {
    assert.equal(mapStockRoe([{ 日期: '2026-06-30T00:00:00.000' }]), null);
  });
});

describe('mapStockHkRoe', () => {
  it('取股东权益回报率(%)', () => {
    const out = mapStockHkRoe([{ 市盈率: 14.28, '股东权益回报率(%)': 9.9663537853 }]);
    assert.equal(out, 9.9663537853);
  });

  it('主列缺失时回退到净资产收益率(%)', () => {
    assert.equal(mapStockHkRoe([{ '净资产收益率(%)': 8.5 }]), 8.5);
  });

  it('NaN/缺失 → null', () => {
    assert.equal(mapStockHkRoe([{ '股东权益回报率(%)': 'NaN' }]), null);
    assert.equal(mapStockHkRoe([{ 市盈率: 14 }]), null);
    assert.equal(mapStockHkRoe([]), null);
    assert.equal(mapStockHkRoe(null), null);
  });
});

describe('mapStockHkValueHistory', () => {
  it('eniu 形态：按 valueKey 取指标列、归一日期并升序', () => {
    const out = mapStockHkValueHistory(
      [
        { date: '2022-07-13', pe: 13.76, price: 0 },
        { date: '2006-03-23', pe: 44.77, price: 0 }
      ],
      'pe'
    );
    assert.deepEqual(out, [
      { date: '2006-03-23', value: 44.77 },
      { date: '2022-07-13', value: 13.76 }
    ]);
  });

  it('不同 valueKey 取不同列（pb）', () => {
    const out = mapStockHkValueHistory([{ date: '2022-07-13', pe: 13.76, pb: 3.17, price: 0 }], 'pb');
    assert.deepEqual(out, [{ date: '2022-07-13', value: 3.17 }]);
  });

  it('未传 valueKey 时回退到 value 列（百度形态）', () => {
    const out = mapStockHkValueHistory([{ date: '2026-09-19T00:00:00.000', value: 14.05 }]);
    assert.deepEqual(out, [{ date: '2026-09-19', value: 14.05 }]);
  });

  it('非法行被丢弃', () => {
    const out = mapStockHkValueHistory(
      [
        { date: 'bad', pe: 1 },
        { date: '2022-07-13', pe: 'NaN' },
        { date: '2022-07-12', pe: 12 }
      ],
      'pe'
    );
    assert.deepEqual(out, [{ date: '2022-07-12', value: 12 }]);
  });

  it('空/非数组 → 空数组', () => {
    assert.deepEqual(mapStockHkValueHistory([], 'pe'), []);
    assert.deepEqual(mapStockHkValueHistory(null, 'pe'), []);
  });
});
