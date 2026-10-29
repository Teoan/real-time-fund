/**
 * IndexedDB 后端适配器单测（不起真实 IndexedDB，注入假 idb 函数）。
 *
 * 运行：node --test app/lib/__tests__/idbStorageBackend.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createIdbStorageBackend } from '../idbStorageBackend.js';

describe('idbStorageBackend', () => {
  it('loadAll 返回 Map（字符串键值）并过滤脏行', async () => {
    const backend = createIdbStorageBackend({
      getAllEntries: async () => [
        ['funds', '[]'],
        ['fundValuationTimeseries:110022', '{"1":[]}'],
        ['broken', null],
        [null, 'x'],
        'not-a-row'
      ]
    });
    const rows = await backend.loadAll();
    assert.equal(rows instanceof Map, true);
    assert.deepEqual(Array.from(rows.keys()), ['funds', 'fundValuationTimeseries:110022']);
  });

  it('后端不可用（getAllEntries 返回 null）时 loadAll 返回 null', async () => {
    const backend = createIdbStorageBackend({ getAllEntries: async () => null });
    assert.equal(await backend.loadAll(), null);
  });

  it('saveMany 空数组直接成功，不触发写入', async () => {
    let called = 0;
    const backend = createIdbStorageBackend({
      setMany: async () => {
        called += 1;
        return true;
      }
    });
    assert.equal(await backend.saveMany([]), true);
    assert.equal(called, 0);
  });

  it('saveMany 把 entries 透传给 idbSetMany（含删除标记 null）', async () => {
    let received = null;
    const backend = createIdbStorageBackend({
      store: 'kv-test',
      setMany: async (storeName, entries) => {
        received = { storeName, entries };
        return true;
      }
    });
    await backend.saveMany([
      ['fundDailyEarnings', '{}'],
      ['transactions', null]
    ]);
    assert.equal(received.storeName, 'kv-test');
    assert.deepEqual(received.entries, [
      ['fundDailyEarnings', '{}'],
      ['transactions', null]
    ]);
  });

  it('clearAll 走 clearStore', async () => {
    let cleared = null;
    const backend = createIdbStorageBackend({
      store: 'kv-test',
      clearStore: async (storeName) => {
        cleared = storeName;
        return true;
      }
    });
    assert.equal(await backend.clearAll(), true);
    assert.equal(cleared, 'kv-test');
  });
});
