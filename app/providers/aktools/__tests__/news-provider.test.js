/**
 * 市场资讯 Provider 单测
 *
 * 覆盖：
 *   - 能力开关关闭 → AktoolsUnsupportedError（UI 的降级依赖这个异常）
 *   - 5 个快讯源的取数 + 映射（mock fetch，走 AKTools 的 { success, data } 信封）
 *   - 财联社「重点」把 symbol=重点 透传给上游，并标记 important
 *   - force 穿透内存缓存（刷新按钮的核心语义）
 *   - 联播日期归一与必填校验
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAktoolsProvider } from '../aktools-provider.js';
import { createAktoolsClient } from '../aktools-client.js';
import { AktoolsUnsupportedError, AktoolsError } from '../aktools-errors.js';

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

/**
 * 装上 mock fetch 并记录每次请求的 URL。
 * @param {(url: string) => object} handler
 * @param {(calls: string[]) => Promise<void>} fn
 */
const withMockFetch = async (handler, fn) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
};

const makeProvider = (capabilities) =>
  createAktoolsProvider({
    client: createAktoolsClient({ baseUrl: 'http://mock', retries: 0 }),
    capabilities
  });

describe('资讯 Provider - 能力开关', () => {
  it('关闭时抛 AktoolsUnsupportedError', async () => {
    const provider = makeProvider({ getMarketFlashEm: false });
    await assert.rejects(() => provider.getMarketFlashEm(), AktoolsUnsupportedError);
  });

  it('显式关闭某项后仍抛 AktoolsUnsupportedError', async () => {
    const provider = makeProvider({ getFinanceBreakfast: false });
    await assert.rejects(() => provider.getFinanceBreakfast(), AktoolsUnsupportedError);
  });

  it('8 项资讯能力默认开启（快讯页依赖这个默认值）', () => {
    const provider = makeProvider();
    const names = [
      'getMarketFlashCls',
      'getMarketFlashEm',
      'getMarketFlashSina',
      'getMarketFlashThs',
      'getMarketFlashFutu',
      'getFinanceBreakfast',
      'getCaixinHighlights',
      'getCctvNews'
    ];
    for (const name of names) {
      assert.equal(provider.capabilities[name], true, `${name} 应默认开启`);
    }
  });
});

describe('资讯 Provider - 快讯取数', () => {
  it('东财快讯映射为归一化条目', async () => {
    await withMockFetch(
      () =>
        okJson({
          success: true,
          data: [
            {
              标题: '法本信息与鸿蒙生态服务公司签约合作',
              摘要: '据法本信息消息',
              发布时间: '2026-11-10 09:12:00',
              链接: 'https://finance.eastmoney.com/a/1.html'
            }
          ]
        }),
      async () => {
        const items = await makeProvider({ getMarketFlashEm: true }).getMarketFlashEm();
        assert.equal(items.length, 1);
        assert.equal(items[0].source, 'em');
        assert.equal(items[0].title, '法本信息与鸿蒙生态服务公司签约合作');
        assert.equal(items[0].publishedAt, '2026-11-10T09:12:00');
      }
    );
  });

  it('上游空表返回 []，不抛错', async () => {
    await withMockFetch(
      () => okJson({ success: true, data: [] }),
      async () => {
        const items = await makeProvider({ getMarketFlashSina: true }).getMarketFlashSina();
        assert.deepEqual(items, []);
      }
    );
  });

  it('财联社「重点」把 symbol=重点 透传并标记 important', async () => {
    await withMockFetch(
      () =>
        okJson({
          success: true,
          data: [{ 标题: '重要消息', 内容: '重要消息正文', 发布日期: '2026-11-10', 发布时间: '10:00:00' }]
        }),
      async (calls) => {
        const provider = makeProvider({ getMarketFlashCls: true });
        const items = await provider.getMarketFlashCls({ important: true });
        assert.equal(items[0].important, true);
        assert.ok(calls[0].includes('symbol=') && decodeURIComponent(calls[0]).includes('symbol=重点'));
      }
    );
  });

  it('财联社默认取「全部」且不标记重要', async () => {
    await withMockFetch(
      () =>
        okJson({
          success: true,
          data: [{ 标题: '普通消息', 内容: '正文', 发布日期: '2026-11-10', 发布时间: '09:00:00' }]
        }),
      async (calls) => {
        const items = await makeProvider({ getMarketFlashCls: true }).getMarketFlashCls();
        assert.equal(items[0].important, false);
        assert.ok(decodeURIComponent(calls[0]).includes('symbol=全部'));
      }
    );
  });
});

describe('资讯 Provider - force 穿透缓存', () => {
  const payload = { success: true, data: [{ 标题: 'x', 内容: 'y', 发布时间: '2026-11-10 10:00:00' }] };

  it('不带 force 时第二次命中内存缓存（只发一次请求）', async () => {
    await withMockFetch(
      () => okJson(payload),
      async (calls) => {
        const provider = makeProvider({ getMarketFlashThs: true });
        await provider.getMarketFlashThs();
        await provider.getMarketFlashThs();
        assert.equal(calls.length, 1);
      }
    );
  });

  it('带 force 时每次都打到上游', async () => {
    await withMockFetch(
      () => okJson(payload),
      async (calls) => {
        const provider = makeProvider({ getMarketFlashThs: true });
        await provider.getMarketFlashThs({ force: true });
        await provider.getMarketFlashThs({ force: true });
        assert.equal(calls.length, 2);
      }
    );
  });
});

describe('资讯 Provider - 财经早餐 / 财新', () => {
  it('财经早餐保持全量（裁剪由业务层负责）', async () => {
    const data = Array.from({ length: 5 }, (_, i) => ({
      标题: `早餐 ${i}`,
      摘要: '摘要',
      发布时间: '2026-11-10 07:00:00',
      链接: 'https://finance.eastmoney.com/a/x.html'
    }));
    await withMockFetch(
      () => okJson({ success: true, data }),
      async () => {
        const items = await makeProvider({ getFinanceBreakfast: true }).getFinanceBreakfast();
        assert.equal(items.length, 5);
        assert.equal(items[0].source, 'cjzc');
      }
    );
  });

  it('财新无时间字段时 publishedAt 为 null', async () => {
    await withMockFetch(
      () => okJson({ success: true, data: [{ tag: '宏观', summary: '内容', url: 'https://cxdata.caixin.com/pc/1' }] }),
      async () => {
        const items = await makeProvider({ getCaixinHighlights: true }).getCaixinHighlights();
        assert.equal(items.length, 1);
        assert.equal(items[0].publishedAt, null);
        assert.equal(items[0].tag, '宏观');
      }
    );
  });
});

describe('资讯 Provider - 新闻联播', () => {
  it("'YYYY-MM-DD' 归一成 YYYYMMDD 传给上游", async () => {
    await withMockFetch(
      () => okJson({ success: true, data: [{ date: '2026-11-10', title: '会议', content: '内容' }] }),
      async (calls) => {
        const items = await makeProvider({ getCctvNews: true }).getCctvNews('2026-11-10');
        assert.equal(items.length, 1);
        assert.ok(calls[0].includes('date=20261110'));
      }
    );
  });

  it('非法日期抛 AktoolsError，且不发起请求', async () => {
    await withMockFetch(
      () => okJson({ success: true, data: [] }),
      async (calls) => {
        await assert.rejects(() => makeProvider({ getCctvNews: true }).getCctvNews('昨天'), AktoolsError);
        assert.equal(calls.length, 0);
      }
    );
  });

  it('缺日期直接拒绝（上游没有「最新」语义）', async () => {
    await assert.rejects(() => makeProvider({ getCctvNews: true }).getCctvNews(), AktoolsError);
  });
});
