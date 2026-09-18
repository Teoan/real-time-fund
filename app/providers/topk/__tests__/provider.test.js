/**
 * TopK Provider 单元测试
 *
 * 覆盖：
 *   - searchFund 正常 / 空 / 过滤无效
 *   - getFundDetail 字段完整 / 部分 null / 未找到
 *   - getFundNavHistory 排序 / 去重 / 区间过滤
 *   - getFundHoldings 正常 / 无披露
 *   - 不支持的能力抛 TopKUnsupportedError
 *
 * 运行：node --test app/providers/topk/__tests__/provider.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTopKProvider } from '../topk-provider.js';
import { createTopKClient } from '../topk-client.js';
import { FundNotFoundError, TopKUnsupportedError } from '../topk-errors.js';

const okJson = (body) => ({
  ok: true,
  status: 200,
  json: async () => body
});

const withMockFetch = async (handler, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(url, init);
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

describe('TopK Provider - searchFund', () => {
  it('正常响应 → 映射后返回', async () => {
    await withMockFetch(
      async () =>
        okJson({
          success: true,
          data: [
            { 基金代码: '110022', 基金简称: '易方达消费', 基金类型: '股票型' },
            { 基金代码: '000001', 基金简称: '华夏成长', 基金类型: '混合型' }
          ]
        }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { searchFund: true }
        });
        const out = await provider.searchFund('110022');
        assert.equal(out.length, 2);
        assert.equal(out[0].code, '110022');
        assert.equal(out[0].name, '易方达消费');
        assert.equal(out[0].type, '股票型');
      }
    );
  });

  it('空数据返回 []，不抛异常', async () => {
    await withMockFetch(
      async () => okJson({ success: true, data: [] }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { searchFund: true }
        });
        const out = await provider.searchFund('nothing');
        assert.deepEqual(out, []);
      }
    );
  });

  it('能力未启用 → TopKUnsupportedError', async () => {
    const provider = createTopKProvider({
      client: createTopKClient({ baseUrl: 'http://x', retries: 0 })
    });
    await assert.rejects(provider.searchFund('any'), TopKUnsupportedError);
  });
});

describe('TopK Provider - getFundDetail', () => {
  it('完整字段', async () => {
    await withMockFetch(
      async () =>
        okJson({
          success: true,
          data: [
            { item: '基金名称', value: '华夏成长混合' },
            { item: '基金全称', value: '华夏成长前收费' },
            { item: '基金类型', value: '混合型-偏股' },
            { item: '成立时间', value: '2001-12-18' },
            { item: '基金公司', value: '华夏基金管理有限公司' },
            { item: '基金经理', value: '王泽实' }
          ]
        }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getFundDetail: true }
        });
        const out = await provider.getFundDetail('000001');
        assert.equal(out.code, '000001');
        assert.equal(out.name, '华夏成长混合');
        assert.equal(out.manager, '王泽实');
        assert.equal(out.establishDate, '2001-12-18');
      }
    );
  });

  it('部分字段 null', async () => {
    await withMockFetch(
      async () =>
        okJson({
          success: true,
          data: [{ item: '基金名称', value: '某基金' }]
        }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getFundDetail: true }
        });
        const out = await provider.getFundDetail('999999');
        assert.equal(out.manager, null);
        assert.equal(out.company, null);
      }
    );
  });

  it('完全空响应 → FundNotFoundError', async () => {
    await withMockFetch(
      async () => okJson({ success: true, data: [] }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getFundDetail: true }
        });
        await assert.rejects(provider.getFundDetail('xxxx'), FundNotFoundError);
      }
    );
  });
});

describe('TopK Provider - getFundNavHistory', () => {
  it('按日期升序 + 去重', async () => {
    await withMockFetch(
      async () =>
        okJson({
          success: true,
          data: [
            { 净值日期: '2024-06-02', 单位净值: 1.2, 日增长率: 0.5 },
            { 净值日期: '2024-06-01', 单位净值: 1.19, 日增长率: null },
            { 净值日期: '2024-06-01', 单位净值: 1.18, 日增长率: null }
          ]
        }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getFundNavHistory: true }
        });
        const out = await provider.getFundNavHistory('000001');
        assert.equal(out.length, 2);
        assert.equal(out[0].date, '2024-06-01');
        assert.equal(out[1].date, '2024-06-02');
      }
    );
  });

  it('区间过滤', async () => {
    await withMockFetch(
      async () =>
        okJson({
          success: true,
          data: [
            { 净值日期: '2024-05-30', 单位净值: 1.1 },
            { 净值日期: '2024-06-01', 单位净值: 1.19 },
            { 净值日期: '2024-06-02', 单位净值: 1.2 },
            { 净值日期: '2024-06-10', 单位净值: 1.25 }
          ]
        }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getFundNavHistory: true }
        });
        const out = await provider.getFundNavHistory('000001', '2024-06-01', '2024-06-02');
        assert.equal(out.length, 2);
      }
    );
  });

  it('空数据 → FundNotFoundError', async () => {
    await withMockFetch(
      async () => okJson({ success: true, data: [] }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getFundNavHistory: true }
        });
        await assert.rejects(provider.getFundNavHistory('000001'), FundNotFoundError);
      }
    );
  });
});

describe('TopK Provider - getFundHoldings', () => {
  it('正常持仓', async () => {
    await withMockFetch(
      async () =>
        okJson({
          success: true,
          data: [
            {
              序号: 1,
              股票代码: '600519',
              股票名称: '贵州茅台',
              占净值比例: 5.23,
              持股数: 12.34,
              持仓市值: 23456.78,
              季度: '2024 年1季度股票投资明细'
            }
          ]
        }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getFundHoldings: true }
        });
        const out = await provider.getFundHoldings('000001', '2024');
        assert.equal(out.holdings.length, 1);
        assert.equal(out.holdings[0].stockCode, '600519');
        assert.equal(out.reportDate, '2024-03-31');
        assert.equal(out.dataDate, '2024-03-31');
        assert.equal(out.source, 'topk');
      }
    );
  });

  it('没有披露数据 → 空数组 + reportDate null', async () => {
    await withMockFetch(
      async () => okJson({ success: true, data: [] }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getFundHoldings: true }
        });
        const out = await provider.getFundHoldings('000001');
        assert.deepEqual(out.holdings, []);
        assert.equal(out.reportDate, null);
      }
    );
  });
});

describe('TopK Provider - getStockFundamentals', () => {
  it('正常行 → 映射到标准 StockFundamental 结构', async () => {
    await withMockFetch(
      async () =>
        okJson({
          success: true,
          data: [
            {
              数据日期: '2024-06-03T00:00:00.000',
              当日收盘价: 100,
              总市值: 1000000000,
              流通市值: 800000000,
              'PE(TTM)': 15.5,
              市净率: 2.3,
              市销率: 1.8,
              PEG值: 1.2
            }
          ]
        }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getStockFundamentals: true }
        });
        const out = await provider.getStockFundamentals('600519', {
          secid: '1.600519',
          market: 'A',
          code: '600519'
        });
        assert.equal(out.secid, '1.600519');
        assert.equal(out.code, '600519');
        assert.equal(out.pe, 15.5);
        assert.equal(out.pb, 2.3);
        assert.equal(out.ps, 1.8);
        assert.equal(out.peg, 1.2);
        assert.equal(out.dividendYield, null);
        assert.equal(out.epsGrowth, null);
      }
    );
  });

  it('非 6 位代码 → TopKError', async () => {
    const provider = createTopKProvider({
      client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
      capabilities: { getStockFundamentals: true }
    });
    await assert.rejects(provider.getStockFundamentals('12345'), /6 位代码/);
  });

  it('能力显式禁用 → TopKUnsupportedError', async () => {
    const provider = createTopKProvider({
      client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
      capabilities: { getStockFundamentals: false }
    });
    await assert.rejects(provider.getStockFundamentals('600519'), TopKUnsupportedError);
  });

  it('空数据 → FundNotFoundError', async () => {
    await withMockFetch(
      async () => okJson({ success: true, data: [] }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getStockFundamentals: true }
        });
        await assert.rejects(provider.getStockFundamentals('600519'), FundNotFoundError);
      }
    );
  });
});

describe('TopK Provider - getStockValueHistory', () => {
  const historyRows = [
    {
      数据日期: '2024-06-04T00:00:00.000',
      当日收盘价: 102,
      'PE(TTM)': 15.8,
      市净率: 2.35,
      市销率: 1.84,
      PEG值: 1.22
    },
    {
      数据日期: '2024-06-03T00:00:00.000',
      当日收盘价: 100,
      'PE(TTM)': 15.5,
      市净率: 2.3,
      市销率: 1.8,
      PEG值: 1.2
    }
  ];

  it('返回按数据日期升序的归一化序列（不泄漏 AKShare 列名）', async () => {
    await withMockFetch(
      async () => okJson({ success: true, data: historyRows }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getStockFundamentals: true }
        });
        const out = await provider.getStockValueHistory('600519');
        assert.equal(out.length, 2);
        assert.deepEqual(
          out.map((r) => r.date),
          ['2024-06-03', '2024-06-04']
        );
        assert.equal(out[0].pe, 15.5);
        assert.equal(out[0].pb, 2.3);
        assert.equal(out[0].ps, 1.8);
        assert.equal(out[0].peg, 1.2);
        assert.equal(out[0].price, 100);
        assert.equal(out[1].pe, 15.8);
      }
    );
  });

  it('非法日期的行被丢弃', async () => {
    await withMockFetch(
      async () => okJson({ success: true, data: [{ 数据日期: 'bad', 'PE(TTM)': 99 }] }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getStockFundamentals: true }
        });
        await assert.rejects(provider.getStockValueHistory('600519'), FundNotFoundError);
      }
    );
  });

  it('非 6 位代码 → TopKError', async () => {
    const provider = createTopKProvider({
      client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
      capabilities: { getStockFundamentals: true }
    });
    await assert.rejects(provider.getStockValueHistory('12345'), /6 位代码/);
  });

  it('能力显式禁用 → TopKUnsupportedError', async () => {
    const provider = createTopKProvider({
      client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
      capabilities: { getStockFundamentals: false }
    });
    await assert.rejects(provider.getStockValueHistory('600519'), TopKUnsupportedError);
  });

  it('空数据 → FundNotFoundError', async () => {
    await withMockFetch(
      async () => okJson({ success: true, data: [] }),
      async () => {
        const provider = createTopKProvider({
          client: createTopKClient({ baseUrl: 'http://mock', retries: 0 }),
          capabilities: { getStockFundamentals: true }
        });
        await assert.rejects(provider.getStockValueHistory('600519'), FundNotFoundError);
      }
    );
  });
});
