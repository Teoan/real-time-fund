/**
 * AKTools mappers 单元测试
 *
 * 运行：node --test app/providers/aktools/__tests__/mappers.test.js
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
  mapFundRankRow,
  mapFundRankRows,
  mapFundValuationRow,
  mapFundValuationRows,
  mapSectorBoardRow,
  mapSectorBoardRows,
  mapSectorFundFlowRows,
  mergeSectorNetInflow,
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
  mapStockUsFinancial,
  __test__ as mappersInternals
} from '../aktools-mappers.js';

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

describe('mapStockUsFinancial', () => {
  // 实测 stock_financial_us_analysis_indicator_em 返回的行（截取关键列）
  const usRows = [
    {
      REPORT_DATE: '2024-09-28 00:00:00',
      ROE_AVG: 157.4125075569,
      PARENT_HOLDER_NETPROFIT_YOY: -3.3599670086,
      OPERATE_INCOME_YOY: 2.0219940775,
      GROSS_PROFIT_RATIO: 46.2063498152,
      CURRENCY_ABBR: 'USD'
    },
    {
      REPORT_DATE: '2025-09-27 00:00:00',
      ROE_AVG: 171.4224497448,
      PARENT_HOLDER_NETPROFIT_YOY: 19.4951779466,
      OPERATE_INCOME_YOY: 6.4255117828,
      GROSS_PROFIT_RATIO: 46.9051641072,
      CURRENCY_ABBR: 'USD'
    }
  ];

  it('取最新报告期并映射为领域字段（不泄漏 AKShare 列名）', () => {
    const out = mapStockUsFinancial(usRows);
    assert.equal(out.roe, 171.4224497448);
    assert.equal(out.epsGrowth, 19.4951779466);
    assert.equal(out.revenueGrowth, 6.4255117828);
    assert.equal(out.grossMargin, 46.9051641072);
    assert.equal(out.reportDate, '2025-09-27');
    assert.equal(out.currency, 'USD');
    // 不得出现 AKShare 原始列名
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'ROE_AVG'), false);
  });

  it('乱序输入也取最新报告期', () => {
    const out = mapStockUsFinancial([usRows[1], usRows[0]]);
    assert.equal(out.reportDate, '2025-09-27');
  });

  it('部分指标缺失 → 该字段 null，其余保留', () => {
    const out = mapStockUsFinancial([
      { REPORT_DATE: '2025-09-27 00:00:00', ROE_AVG: 30.25, OPERATE_INCOME_YOY: 'NaN' }
    ]);
    assert.equal(out.roe, 30.25);
    assert.equal(out.revenueGrowth, null);
    assert.equal(out.epsGrowth, null);
  });

  it('全部指标缺失 → null（避免把空报告当有效结果缓存）', () => {
    assert.equal(mapStockUsFinancial([{ REPORT_DATE: '2025-09-27 00:00:00' }]), null);
  });

  it('空/非法输入 → null', () => {
    assert.equal(mapStockUsFinancial([]), null);
    assert.equal(mapStockUsFinancial(null), null);
    assert.equal(mapStockUsFinancial(undefined), null);
    assert.equal(mapStockUsFinancial('not-an-array'), null);
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

describe('mapFundRankRow', () => {
  const fullRow = {
    序号: 1,
    基金代码: '002910',
    基金简称: '易方达供给改革混合',
    日期: '2026-10-30T00:00:00.000',
    单位净值: 2.341,
    累计净值: 2.341,
    日增长率: -0.55,
    近1周: 1.23,
    近1月: 4.56,
    近3月: 7.89,
    近6月: '12.34',
    近1年: 25.68,
    近2年: 38.9,
    近3年: 41.2,
    今年来: 18.11,
    成立来: 134.1,
    自定义: null,
    手续费: '0.15%'
  };

  it('18 列中文键 → 16 字段 domain model', () => {
    const out = mapFundRankRow(fullRow);
    assert.deepEqual(out, {
      code: '002910',
      name: '易方达供给改革混合',
      date: '2026-10-30',
      unitNav: 2.341,
      accNav: 2.341,
      dayReturn: -0.55,
      week1: 1.23,
      month1: 4.56,
      month3: 7.89,
      month6: 12.34,
      year1: 25.68,
      year2: 38.9,
      year3: 41.2,
      yearToDate: 18.11,
      sinceInception: 134.1,
      feeRate: 0.15,
      sourceRank: 1
    });
  });

  it('手续费 "0.15%" 去百分号后存百分数口径', () => {
    assert.equal(mapFundRankRow({ 基金代码: '000001', 手续费: '1.50%' }).feeRate, 1.5);
    assert.equal(mapFundRankRow({ 基金代码: '000001', 手续费: '--' }).feeRate, null);
  });

  it('次新基金的 近2年/近3年 NaN → null（不与 0 混淆）', () => {
    const out = mapFundRankRow({ 基金代码: '020001', 近1年: 3.2, 近2年: 'NaN', 近3年: NaN });
    assert.equal(out.year1, 3.2);
    assert.equal(out.year2, null);
    assert.equal(out.year3, null);
  });

  it('日期截到 YYYY-MM-DD', () => {
    assert.equal(mapFundRankRow({ 基金代码: '000001', 日期: '2026-10-30T00:00:00.000' }).date, '2026-10-30');
  });

  it('缺基金代码 → null', () => {
    assert.equal(mapFundRankRow(null), null);
    assert.equal(mapFundRankRow({ 基金简称: '无代码' }), null);
  });
});

describe('mapFundRankRows', () => {
  it('整表映射并剔除无代码行', () => {
    const out = mapFundRankRows([
      { 基金代码: '000001', 近1年: 10 },
      { 基金简称: '坏数据' },
      { 基金代码: '000002', 近1年: -5 }
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[1].year1, -5);
  });

  it('空/非数组 → []', () => {
    assert.deepEqual(mapFundRankRows(null), []);
    assert.deepEqual(mapFundRankRows([]), []);
  });
});

describe('mapFundValuationRow', () => {
  const row = {
    序号: 1,
    基金代码: '000008',
    基金名称: '嘉实中证500ETF联接A',
    '2026-11-05-估算数据-估算值': '2.0124',
    '2026-11-05-估算数据-估算增长率': '1.80%',
    '2026-11-05-公布数据-单位净值': '2.0102',
    '2026-11-05-公布数据-日增长率': '1.69%',
    估算偏差: '0.11%',
    '2026-11-04-单位净值': '1.9768'
  };

  it('日期前缀列 → 固定字段，百分比去 %', () => {
    const out = mapFundValuationRow(row);
    assert.equal(out.code, '000008');
    assert.equal(out.name, '嘉实中证500ETF联接A');
    assert.equal(out.date, '2026-11-05');
    assert.equal(out.estChange, 1.8);
    assert.equal(out.estValue, 2.0124);
    assert.equal(out.nav, 2.0102);
    assert.equal(out.navChange, 1.69);
    assert.equal(out.deviation, 0.11);
  });

  it('上一日净值取 `YYYY-MM-DD-单位净值`，不能误取「公布数据-单位净值」', () => {
    assert.equal(mapFundValuationRow(row).prevNav, 1.9768);
  });

  it('交易日切换（列名日期变化）仍然解析成功', () => {
    const nextDay = {
      基金代码: '000009',
      '2026-11-06-估算数据-估算增长率': '-0.42%',
      '2026-11-06-公布数据-日增长率': '--'
    };
    const out = mapFundValuationRow(nextDay);
    assert.equal(out.date, '2026-11-06');
    assert.equal(out.estChange, -0.42);
    assert.equal(out.navChange, null);
    assert.equal(out.prevNav, null);
  });

  it('缺基金代码 → null', () => {
    assert.equal(mapFundValuationRow(null), null);
    assert.equal(mapFundValuationRow({ 基金名称: '无代码' }), null);
  });

  it('整表映射并剔除坏行', () => {
    const out = mapFundValuationRows([row, { 基金名称: '坏数据' }, { 基金代码: '000042' }]);
    assert.equal(out.length, 2);
    assert.deepEqual(mapFundValuationRows(null), []);
  });
});

describe('mapSectorBoardRow', () => {
  const row = {
    排名: 1,
    板块名称: '光伏辅材',
    板块代码: 'BK1316',
    最新价: 2306.99,
    涨跌幅: 9.94,
    换手率: 3.46,
    上涨家数: 18,
    下跌家数: 0,
    领涨股票: '永臻股份',
    '领涨股票-涨跌幅': 9.98
  };

  it('行业板块 → 项目字段', () => {
    const out = mapSectorBoardRow(row, 'industry');
    assert.equal(out.id, 'industry:BK1316');
    assert.equal(out.sector_name, '光伏辅材');
    assert.equal(out.sector_type, 'industry');
    assert.equal(out.change_pct, 9.94);
    assert.equal(out.net_inflow, null);
    assert.equal(out.leader, '永臻股份');
    assert.equal(out.leader_change, 9.98);
  });

  it('概念板块 type 透传', () => {
    assert.equal(mapSectorBoardRow(row, 'concept').sector_type, 'concept');
  });

  it('缺板块名称 → null；整表剔除坏行', () => {
    assert.equal(mapSectorBoardRow({ 板块代码: 'BK1' }), null);
    assert.equal(mapSectorBoardRows([row, null], 'industry').length, 1);
    assert.deepEqual(mapSectorBoardRows(null), []);
  });
});

describe('mapSectorFundFlowRows / mergeSectorNetInflow', () => {
  it('按名称取今日主力净流入', () => {
    const map = mapSectorFundFlowRows([
      { 序号: 1, 名称: '电力设备', '今日主力净流入-净额': 6310020864.0 },
      { 序号: 2, 名称: '光伏辅材', '今日主力净流入-净额': '--' }
    ]);
    assert.equal(map['电力设备'], 6310020864.0);
    assert.equal(map['光伏辅材'], null);
    assert.deepEqual(mapSectorFundFlowRows(null), {});
  });

  it('合并后缺数据的板块 net_inflow 保持 null', () => {
    const boards = [
      { sector_name: '电力设备', change_pct: 3.79, net_inflow: null },
      { sector_name: '未知板块', change_pct: 1.0, net_inflow: null }
    ];
    const merged = mergeSectorNetInflow(boards, { 电力设备: 123 });
    assert.equal(merged[0].net_inflow, 123);
    assert.equal(merged[1].net_inflow, null);
    assert.deepEqual(mergeSectorNetInflow(null, {}), []);
  });
});
