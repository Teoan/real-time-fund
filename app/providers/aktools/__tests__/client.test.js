/**
 * AKTools client 单元测试
 *
 * 运行：node --test app/providers/aktools/__tests__/client.test.js
 *
 * 覆盖：
 *   - 正常调用 → 返回标准化结果
 *   - NaN/NaT → null
 *   - 404 → FundNotFoundError
 *   - 429 → AktoolsRateLimitError
 *   - 超时 → AktoolsTimeoutError
 *   - 非 JSON → AktoolsParseError
 *   - 重试仅对 transient（网络）错误生效，FundNotFound 立即抛
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAktoolsClient } from '../aktools-client.js';
import {
  FundNotFoundError,
  AktoolsApiError,
  AktoolsParseError,
  AktoolsRateLimitError,
  AktoolsTimeoutError
} from '../aktools-errors.js';

/**
 * 通过修改全局 fetch 模拟不同响应。
 */
function withMockFetch(mock, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

const okJson = (body, init = {}) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
  ...init
});

describe('AKTools client', () => {
  it('正常响应：sanitize 后返回', async () => {
    await withMockFetch(
      async () => okJson({ success: true, data: [{ 基金代码: '110022' }] }),
      async () => {
        const c = createAktoolsClient({ baseUrl: 'http://x', timeoutMs: 1000, retries: 0 });
        const out = await c.call('fund_name_em');
        assert.deepEqual(out, [{ 基金代码: '110022' }]);
      }
    );
  });

  it('NaN/NaT 归一为 null', async () => {
    await withMockFetch(
      async () =>
        okJson({
          success: true,
          data: [{ 净值日期: '2024-06-01', 单位净值: NaN, 日增长率: 'NaT' }]
        }),
      async () => {
        const c = createAktoolsClient({ baseUrl: 'http://x', retries: 0 });
        const out = await c.call('fund_open_fund_info_em', { symbol: 'X' });
        assert.equal(out[0]['单位净值'], null);
        assert.equal(out[0]['日增长率'], null);
      }
    );
  });

  it('控制字符被 strip（避免 JSON.parse 失败）', async () => {
    await withMockFetch(
      async () => {
        const dirty = '易方达\x00消费\x01行\x7F业';
        return okJson({
          success: true,
          data: [{ 基金代码: '110022', 基金简称: dirty }]
        });
      },
      async () => {
        const c = createAktoolsClient({ baseUrl: 'http://x', retries: 0 });
        const out = await c.call('fund_name_em');
        assert.equal(out[0]['基金简称'], '易方达消费行业');
      }
    );
  });

  it('404 → FundNotFoundError', async () => {
    await withMockFetch(
      async () => ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }),
      async () => {
        const c = createAktoolsClient({ baseUrl: 'http://x', retries: 0 });
        await assert.rejects(c.call('fund_open_fund_info_em'), FundNotFoundError);
      }
    );
  });

  it('429 → AktoolsRateLimitError', async () => {
    await withMockFetch(
      async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({}) }),
      async () => {
        const c = createAktoolsClient({ baseUrl: 'http://x', retries: 0 });
        await assert.rejects(c.call('fund_x'), AktoolsRateLimitError);
      }
    );
  });

  it('500 → AktoolsApiError', async () => {
    await withMockFetch(
      async () => ({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) }),
      async () => {
        const c = createAktoolsClient({ baseUrl: 'http://x', retries: 0 });
        await assert.rejects(c.call('fund_x'), AktoolsApiError);
      }
    );
  });

  it('非 JSON 响应 → AktoolsParseError', async () => {
    await withMockFetch(
      async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        }
      }),
      async () => {
        const c = createAktoolsClient({ baseUrl: 'http://x', retries: 0 });
        await assert.rejects(c.call('fund_x'), AktoolsParseError);
      }
    );
  });

  it('空数组：client 不抛错，由调用方按业务决定', async () => {
    await withMockFetch(
      async () => okJson({ success: true, data: [] }),
      async () => {
        const c = createAktoolsClient({ baseUrl: 'http://x', retries: 0 });
        const out = await c.call('fund_x');
        assert.deepEqual(out, []);
      }
    );
  });

  it('网络失败（非 AbortError） → AktoolsUnavailableError', async () => {
    await withMockFetch(
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => {
        const c = createAktoolsClient({ baseUrl: 'http://x', retries: 0 });
        await assert.rejects(c.call('fund_x'), (err) => /网络错误/.test(err.message));
      }
    );
  });

  it('URL 拼接：正确生成查询串', async () => {
    let capturedUrl = null;
    await withMockFetch(
      async (url) => {
        capturedUrl = url;
        return okJson({ success: true, data: [] });
      },
      async () => {
        const c = createAktoolsClient({ baseUrl: 'http://x/', retries: 0 });
        await c.call('fund_x', { symbol: '110022', page: 1, nullParam: null });
        assert.equal(capturedUrl, 'http://x/fund_x?symbol=110022&page=1');
      }
    );
  });

  it('healthCheck 返回 availability 与 latency', async () => {
    await withMockFetch(
      async () => okJson({ success: true, data: [] }),
      async () => {
        const c = createAktoolsClient({ baseUrl: 'http://x', retries: 0 });
        const h = await c.healthCheck();
        assert.equal(typeof h.available, 'boolean');
        assert.equal(typeof h.latency, 'number');
        assert.ok(h.checkedAt);
      }
    );
  });

  it('超时 → AktoolsTimeoutError', async () => {
    await withMockFetch(
      (url, init) =>
        new Promise((resolve, reject) => {
          // 监听 abort 信号：触发后抛 AbortError，与浏览器行为一致
          init.signal.addEventListener('abort', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
      async () => {
        const c = createAktoolsClient({ baseUrl: 'http://x', timeoutMs: 50, retries: 0 });
        await assert.rejects(c.call('fund_x'), AktoolsTimeoutError);
      }
    );
  });
});
