import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { QueryClient } from '@tanstack/react-query';

import { createManualQueryCache } from '../manualQueryCache.js';

/** 最小 QueryClient 替身：只用 Map 承载数据，便于断言读写穿透 */
const createFakeClient = () => {
  const store = new Map();
  return {
    store,
    getQueryData: (key) => store.get(JSON.stringify(key)),
    setQueryData: (key, value) => {
      store.set(JSON.stringify(key), value);
      return value;
    }
  };
};

const createCache = (client, clock) => createManualQueryCache({ getQueryClient: () => client, now: () => clock.now });

describe('createManualQueryCache', () => {
  it('TTL 内返回写入值，写透到 QueryClient', () => {
    const client = createFakeClient();
    const clock = { now: 1_000 };
    const cache = createCache(client, clock);

    cache.set(['fundValuationLast', '110022'], { gsz: 1.23 }, 10_000);

    assert.deepEqual(cache.get(['fundValuationLast', '110022']), { gsz: 1.23 });
    // 数据确实写进了 QueryClient，便于调试与外部读取
    assert.deepEqual(client.store.get(JSON.stringify(['fundValuationLast', '110022'])), { gsz: 1.23 });
  });

  it('超过 TTL 立即视为未命中（这正是 v5 setQueryData 丢弃 staleTime 后丢失的行为）', () => {
    const client = createFakeClient();
    const clock = { now: 0 };
    const cache = createCache(client, clock);

    cache.set(['stockFundamentals', '1.600519'], { pe: 20 }, 10 * 1000);

    clock.now = 10 * 1000;
    assert.deepEqual(cache.get(['stockFundamentals', '1.600519']), { pe: 20 }, '正好到期仍算有效');

    clock.now = 10 * 1000 + 1;
    assert.equal(cache.get(['stockFundamentals', '1.600519']), undefined);
  });

  it('未写入过的 key 返回 undefined，不同 key 的 TTL 互不影响', () => {
    const client = createFakeClient();
    const clock = { now: 0 };
    const cache = createCache(client, clock);

    cache.set(['a'], 'short', 1_000);
    cache.set(['b'], 'long', 60_000);

    clock.now = 5_000;

    assert.equal(cache.get(['a']), undefined);
    assert.equal(cache.get(['b']), 'long');
    assert.equal(cache.get(['never-written']), undefined);
  });

  it('ttl 缺省/非法/非正数 → 视为立即可过期，不会静默变成永久缓存', () => {
    const client = createFakeClient();
    const clock = { now: 0 };
    const cache = createCache(client, clock);

    cache.set(['k1'], 1);
    cache.set(['k2'], 2, -1);
    cache.set(['k3'], 3, null);

    // 同一时刻（+1ms）读取即过期
    clock.now = 1;

    assert.equal(cache.get(['k1']), undefined);
    assert.equal(cache.get(['k2']), undefined);
    assert.equal(cache.get(['k3']), undefined);
    // 但值仍在底层缓存里，gcTime 之后才会被回收
    assert.equal(client.store.get(JSON.stringify(['k1'])), 1);
  });

  it('重复写入刷新有效期', () => {
    const client = createFakeClient();
    const clock = { now: 0 };
    const cache = createCache(client, clock);

    cache.set(['k'], 'v1', 10_000);
    clock.now = 8_000;
    cache.set(['k'], 'v2', 10_000);

    clock.now = 15_000;
    assert.equal(cache.get(['k']), 'v2');

    clock.now = 18_001;
    assert.equal(cache.get(['k']), undefined);
  });

  it('clear() 清空时间戳表 → 全部落为未命中', () => {
    const client = createFakeClient();
    const clock = { now: 0 };
    const cache = createCache(client, clock);

    cache.set(['k'], 'v', 60_000);
    cache.clear();

    assert.equal(cache.get(['k']), undefined);
  });

  it('真实 QueryClient 上，先失效的是自管 TTL 而不是 gcTime', () => {
    // gcTime 用 Infinity，避免 node:test 进程被 GC 定时器吊住
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const clock = { now: 0 };
    const cache = createManualQueryCache({ getQueryClient: () => qc, now: () => clock.now });

    cache.set(['fundValuationLast', '000001'], { gsz: 9.99 }, 10_000);

    clock.now = 5_000;
    assert.deepEqual(cache.get(['fundValuationLast', '000001']), { gsz: 9.99 });

    clock.now = 10_001;
    assert.equal(cache.get(['fundValuationLast', '000001']), undefined);
    // 底层条目还在：过期判定完全由本模块负责，不再依赖 QueryClient 的（被丢弃的）staleTime
    assert.deepEqual(qc.getQueryData(['fundValuationLast', '000001']), { gsz: 9.99 });
  });
});
