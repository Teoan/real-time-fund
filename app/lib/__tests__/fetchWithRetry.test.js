/**
 * fetchWithRetry 单元测试
 *
 * 覆盖：
 *   - 正常响应：直接返回，不重试
 *   - HTTP 4xx/5xx：不重试，立即抛
 *   - transient 错误：指数退避重试直至成功
 *   - transient 错误但重试耗尽：抛最后一次的异常
 *   - AbortError：算作 timeout，不重试
 *   - 非 transient 错误（如 JSON.parse 抛）：不重试
 *
 * 运行：node --test app/lib/__tests__/fetchWithRetry.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchWithRetry, isTransientFetchError } from '../fetchWithRetry.js';

/**
 * 构造浏览器 TypeError('Failed to fetch')，cause 携带具体原因。
 */
const netError = (chromeMsg, attemptRef) => {
  const err = new TypeError('Failed to fetch');
  // Node 环境没有真正的 cause；构造一个 {message: chromeMsg} 模拟
  err.cause = { message: chromeMsg };
  if (attemptRef) attemptRef.count += 1;
  return err;
};

const okResponse = (body = {}) => ({
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

describe('isTransientFetchError', () => {
  it('ERR_EMPTY_RESPONSE → true', () => {
    assert.equal(isTransientFetchError(netError('ERR_EMPTY_RESPONSE')), true);
  });
  it('ERR_CONNECTION_RESET → true', () => {
    assert.equal(isTransientFetchError(netError('ERR_CONNECTION_RESET')), true);
  });
  it('Failed to fetch 无 cause → true（保守视为瞬时）', () => {
    assert.equal(isTransientFetchError(new TypeError('Failed to fetch')), true);
  });
  it('AbortError → false', () => {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    assert.equal(isTransientFetchError(e), false);
  });
  it('JSON.parse 抛 SyntaxError → false', () => {
    assert.equal(isTransientFetchError(new SyntaxError('Unexpected token')), false);
  });
  it('null / undefined → false', () => {
    assert.equal(isTransientFetchError(null), false);
    assert.equal(isTransientFetchError(undefined), false);
  });
});

describe('fetchWithRetry', () => {
  it('正常响应：直接返回', async () => {
    let calls = 0;
    await withMockFetch(
      async () => {
        calls += 1;
        return okResponse({ ok: true });
      },
      async () => {
        const res = await fetchWithRetry('http://x', { timeoutMs: 1000, retries: 2 });
        assert.equal(res.status, 200);
        assert.equal(calls, 1);
      }
    );
  });

  it('HTTP 500：直接返回 res，调用方判断（不重试）', async () => {
    let calls = 0;
    await withMockFetch(
      async () => {
        calls += 1;
        return { ok: false, status: 500, json: async () => ({}) };
      },
      async () => {
        const res = await fetchWithRetry('http://x', { timeoutMs: 1000, retries: 2 });
        assert.equal(res.ok, false);
        assert.equal(res.status, 500);
        assert.equal(calls, 1); // 不重试
      }
    );
  });

  it('HTTP 404：直接返回 res（业务错误，不重试）', async () => {
    let calls = 0;
    await withMockFetch(
      async () => {
        calls += 1;
        return { ok: false, status: 404, json: async () => ({}) };
      },
      async () => {
        const res = await fetchWithRetry('http://x', { retries: 3 });
        assert.equal(res.ok, false);
        assert.equal(res.status, 404);
        assert.equal(calls, 1);
      }
    );
  });

  it('ERR_EMPTY_RESPONSE：第一次失败，第二次成功', async () => {
    let calls = 0;
    await withMockFetch(
      async () => {
        calls += 1;
        if (calls === 1) throw netError('ERR_EMPTY_RESPONSE');
        return okResponse({ recovered: true });
      },
      async () => {
        const res = await fetchWithRetry('http://x', {
          timeoutMs: 1000,
          retries: 2,
          baseDelayMs: 5
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body, { recovered: true });
        assert.equal(calls, 2);
      }
    );
  });

  it('transient 重试耗尽后抛最后一次错误', async () => {
    let calls = 0;
    await withMockFetch(
      async () => {
        calls += 1;
        throw netError('ERR_EMPTY_RESPONSE');
      },
      async () => {
        await assert.rejects(fetchWithRetry('http://x', { retries: 2, baseDelayMs: 5 }), (err) => {
          assert.ok(err instanceof TypeError);
          assert.ok(err.cause?.message?.includes('ERR_EMPTY_RESPONSE'));
          return true;
        });
        // retries=2 共尝试 3 次（attempt=0,1,2）
        assert.equal(calls, 3);
      }
    );
  });

  it('mixed: ERR_CONNECTION_RESET → 失败 → ERR_EMPTY_RESPONSE → 失败 → 成功', async () => {
    const seq = ['ERR_CONNECTION_RESET', 'ERR_EMPTY_RESPONSE'];
    let calls = 0;
    await withMockFetch(
      async () => {
        const errType = seq[calls];
        calls += 1;
        if (errType) throw netError(errType);
        return okResponse({});
      },
      async () => {
        const res = await fetchWithRetry('http://x', { retries: 3, baseDelayMs: 5 });
        assert.equal(calls, 3);
        assert.equal(res.status, 200);
      }
    );
  });

  it('non-transient 错误不重试', async () => {
    let calls = 0;
    await withMockFetch(
      async () => {
        calls += 1;
        throw new SyntaxError('Unexpected token in JSON');
      },
      async () => {
        await assert.rejects(fetchWithRetry('http://x', { retries: 3 }), /Unexpected token/);
        assert.equal(calls, 1);
      }
    );
  });

  it('AbortError 不重试（视为超时）', async () => {
    let calls = 0;
    await withMockFetch(
      async () => {
        calls += 1;
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      },
      async () => {
        await assert.rejects(
          fetchWithRetry('http://x', { retries: 3, timeoutMs: 50 }),
          (err) => err.name === 'AbortError'
        );
        assert.equal(calls, 1);
      }
    );
  });

  it('onRetry 回调被调用正确的次数', async () => {
    let calls = 0;
    const retries = [];
    await withMockFetch(
      async () => {
        calls += 1;
        if (calls < 4) throw netError('ERR_EMPTY_RESPONSE');
        return okResponse({});
      },
      async () => {
        await fetchWithRetry('http://x', {
          retries: 5,
          baseDelayMs: 1,
          onRetry: (n, err) => retries.push({ n, msg: err.cause?.message })
        });
        assert.equal(retries.length, 3);
        assert.deepEqual(
          retries.map((r) => r.n),
          [1, 2, 3]
        );
      }
    );
  });
});
