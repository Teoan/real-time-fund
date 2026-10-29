import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createStoragePersist } from '../storagePersist.js';

/** 假 localStorage：记录所有写入次数，方便验证写合并 */
function createFakeStorage(options = {}) {
  const map = new Map();
  const calls = { setItem: 0, getItem: 0, removeItem: 0 };
  return {
    map,
    calls,
    get length() {
      return map.size;
    },
    key(i) {
      return Array.from(map.keys())[i] ?? null;
    },
    getItem(key) {
      calls.getItem += 1;
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, raw) {
      calls.setItem += 1;
      if (options.failSetItem) throw new Error('QuotaExceededError');
      map.set(key, raw);
    },
    removeItem(key) {
      calls.removeItem += 1;
      map.delete(key);
    },
    clear() {
      map.clear();
    }
  };
}

/** 手动调度器：不依赖真实定时器，测试里显式 run() */
function createScheduler() {
  let seq = 0;
  const tasks = new Map();
  return {
    schedule(fn) {
      const id = ++seq;
      tasks.set(id, fn);
      return id;
    },
    cancelSchedule(id) {
      tasks.delete(id);
    },
    run() {
      const snapshot = Array.from(tasks.values());
      tasks.clear();
      snapshot.forEach((fn) => fn());
    },
    get size() {
      return tasks.size;
    }
  };
}

function createEnv(overrides = {}) {
  const storage = overrides.storage || createFakeStorage();
  const scheduler = createScheduler();
  const listeners = new Map();
  const win = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    }
  };
  const persist = createStoragePersist({
    getStorage: () => storage,
    getWindow: () => win,
    getDocument: () => null,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule
  });
  const emit = (type, event) => (listeners.get(type) || []).forEach((fn) => fn(event));
  return { storage, scheduler, persist, win, emit };
}

describe('storagePersist — 内存镜像', () => {
  it('写入后立刻可读，但落盘推迟到下一轮 flush', () => {
    const { storage, scheduler, persist } = createEnv();
    persist.write('funds', JSON.stringify([{ code: '110022' }]));

    assert.deepEqual(persist.read('funds').value, [{ code: '110022' }]);
    assert.equal(storage.map.has('funds'), false, 'flush 前不应落盘');
    assert.equal(scheduler.size, 1);

    scheduler.run();
    assert.equal(storage.map.get('funds'), JSON.stringify([{ code: '110022' }]));
  });

  it('同一 key 一轮内多次写入只落盘最后一次', () => {
    const { storage, scheduler, persist } = createEnv();
    for (let i = 0; i < 20; i++) persist.write('funds', JSON.stringify([{ code: String(i) }]));
    scheduler.run();

    assert.equal(storage.calls.setItem, 1, '20 次写入应合并成 1 次落盘');
    assert.deepEqual(JSON.parse(storage.map.get('funds')), [{ code: '19' }]);
  });

  it('内容完全相同的重复写入不排队、不落盘', () => {
    const { storage, scheduler, persist } = createEnv();
    const raw = JSON.stringify({ a: 1 });
    assert.equal(persist.write('cfg', raw), true);
    assert.equal(persist.write('cfg', raw), false);
    scheduler.run();
    assert.equal(storage.calls.setItem, 1);
  });

  it('persist: false 只更新镜像、不写盘（深等价场景）', () => {
    const { storage, scheduler, persist } = createEnv();
    storage.map.set('cfg', JSON.stringify({ a: 1, b: 2 }));
    persist.write('cfg', JSON.stringify({ b: 2, a: 1 }), { persist: false });
    scheduler.run();

    assert.equal(storage.calls.setItem, 0);
    assert.deepEqual(persist.read('cfg').value, { b: 2, a: 1 });
  });

  it('read 返回副本，调用方修改不污染镜像', () => {
    const { persist } = createEnv();
    persist.write('funds', JSON.stringify([{ code: '110022', tags: ['a'] }]));
    const first = persist.read('funds').value;
    first[0].code = 'MUTATED';
    first[0].tags.push('b');

    assert.deepEqual(persist.read('funds').value, [{ code: '110022', tags: ['a'] }]);
  });

  it('解析失败时回退为原始字符串', () => {
    const { persist } = createEnv();
    persist.write('localSortBy', 'default');
    assert.equal(persist.read('localSortBy').raw, 'default');
    assert.equal(persist.read('localSortBy').value, 'default');
    assert.equal(persist.read('localSortBy').parsedOk, false);
  });

  it('不存在的 key 返回 raw=null', () => {
    const { persist } = createEnv();
    assert.equal(persist.read('nope').raw, null);
    assert.equal(persist.getRaw('nope'), null);
  });
});

describe('storagePersist — 删除与枚举', () => {
  it('remove 排队后 flush 生效', () => {
    const { storage, scheduler, persist } = createEnv();
    storage.map.set('funds', '[]');
    persist.remove('funds');

    assert.equal(persist.getRaw('funds'), null, '镜像应立即失效');
    scheduler.run();
    assert.equal(storage.map.has('funds'), false);
  });

  it('keysWithPrefix 合并「已落盘」与「排队中」的 key，并排除待删除的', () => {
    const { storage, scheduler, persist } = createEnv();
    storage.map.set('ts:110022', '{}');
    storage.map.set('ts:161725', '{}');
    persist.write('ts:006282', '{}');
    persist.remove('ts:161725');

    assert.deepEqual(persist.keysWithPrefix('ts:').sort(), ['ts:006282', 'ts:110022']);
    scheduler.run();
    assert.deepEqual(persist.keysWithPrefix('ts:').sort(), ['ts:006282', 'ts:110022']);
  });
});

describe('storagePersist — 失败与跨标签页', () => {
  it('写盘抛错时通知订阅方，且镜像仍可读', () => {
    const storage = createFakeStorage({ failSetItem: true });
    const { scheduler, persist } = createEnv({ storage });
    const errors = [];
    persist.setErrorHandler((info) => errors.push(info.key));

    persist.write('funds', '[]');
    scheduler.run();

    assert.deepEqual(errors, ['funds']);
    assert.deepEqual(persist.read('funds').value, [], '失败后镜像仍保留，本轮会话可继续用');
  });

  it('storage 事件让镜像失效，下次读取回落到 localStorage', () => {
    const { storage, persist, emit } = createEnv();
    storage.map.set('funds', JSON.stringify([{ code: 'A' }]));
    assert.deepEqual(persist.read('funds').value, [{ code: 'A' }]);

    // 模拟其他标签页改写
    storage.map.set('funds', JSON.stringify([{ code: 'B' }]));
    emit('storage', { key: 'funds' });

    assert.deepEqual(persist.read('funds').value, [{ code: 'B' }]);
  });

  it('pagehide 时同步 flush', () => {
    const { storage, persist, emit } = createEnv();
    persist.write('ts:110022', '{"1":[]}');
    assert.equal(storage.map.has('ts:110022'), false);

    emit('pagehide');
    assert.equal(storage.map.has('ts:110022'), true);
  });

  it('无 localStorage（SSR）时不抛错，退化为纯内存', () => {
    const persist = createStoragePersist({ getStorage: () => null });
    assert.equal(persist.available(), false);
    assert.equal(persist.read('funds').raw, null);

    // 存储不可用时写只落镜像（会话内可读），flush 是空转
    persist.write('funds', '[]');
    assert.equal(persist.read('funds').raw, '[]');
    persist.flush();
  });
});

describe('storagePersist — reset', () => {
  it('reset 丢弃排队，不写盘', () => {
    const { storage, persist } = createEnv();
    persist.write('funds', '[]');
    persist.reset();
    persist.flush();
    assert.equal(storage.map.has('funds'), false);
  });
});

/** 假 IndexedDB 后端（只实现 storagePersist 需要的三个方法） */
function createFakeBackend(options = {}) {
  const rows = new Map(Object.entries(options.rows || {}));
  const calls = { loadAll: 0, saveMany: 0, clearAll: 0 };
  return {
    rows,
    calls,
    async loadAll() {
      calls.loadAll += 1;
      return options.unavailable ? null : new Map(rows);
    },
    async saveMany(entries) {
      calls.saveMany += 1;
      if (options.failSave) return false;
      for (const [key, raw] of entries) {
        if (raw === null) rows.delete(key);
        else rows.set(key, raw);
      }
      return true;
    },
    async clearAll() {
      calls.clearAll += 1;
      rows.clear();
      return true;
    }
  };
}

const BIG_PREFIX = 'big:';
const isBigKey = (key) => key.startsWith(BIG_PREFIX);

function createAsyncEnv(overrides = {}) {
  const storage = overrides.storage || createFakeStorage();
  const backend = overrides.backend || createFakeBackend();
  const scheduler = createScheduler();
  const listeners = new Map();
  const win = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    }
  };
  const messages = [];
  const channel = {
    addEventListener(type, fn) {
      if (type === 'message') channel._onMessage = fn;
    },
    postMessage(data) {
      messages.push(data);
    }
  };
  const persist = createStoragePersist({
    getStorage: () => storage,
    getWindow: () => win,
    getDocument: () => null,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
    isAsyncKey: overrides.isAsyncKey || isBigKey,
    asyncBackend: backend,
    createChannel: () => channel
  });
  const emit = (type, event) => (listeners.get(type) || []).forEach((fn) => fn(event));
  /** 模拟其他标签页在频道里发消息 */
  const receive = (data) => channel._onMessage && channel._onMessage({ data });
  return { storage, backend, scheduler, persist, win, emit, messages, receive };
}

describe('storagePersist — IndexedDB 后端（P1）', () => {
  it('水合前不回落 localStorage，水合后大对象可同步读', async () => {
    const { storage, persist } = createAsyncEnv({
      backend: createFakeBackend({ rows: { 'big:1': JSON.stringify({ a: 1 }) } })
    });
    storage.map.set('funds', '[]');

    assert.equal(persist.read('big:1').raw, null, '水合前读不到（后端值还没进镜像）');
    assert.equal(persist.isHydrated(), false);

    const result = await persist.hydrate();
    assert.equal(result.hydrated, true);
    assert.equal(persist.isHydrated(), true);
    assert.deepEqual(persist.read('big:1').value, { a: 1 });
  });

  it('两边都有同一把键时以 localStorage 为准（后端写失败退回本地的那份更新）', async () => {
    // 模拟上一次会话后端写失败 → 值退回 localStorage，而后端里留着旧值
    const env = createAsyncEnv({
      backend: createFakeBackend({ rows: { 'big:1': JSON.stringify({ a: 'old' }) } })
    });
    env.storage.map.set('big:1', JSON.stringify({ a: 'new' }));

    await env.persist.hydrate();

    assert.deepEqual(env.persist.read('big:1').value, { a: 'new' });
    assert.deepEqual(JSON.parse(env.backend.rows.get('big:1')), { a: 'new' }, '本地副本应被迁入后端');
    assert.equal(env.storage.map.has('big:1'), false, '迁入成功后删除本地副本');
  });

  it('水合时把 localStorage 里的遗留大对象迁进后端并删除本地键', async () => {
    const { storage, backend, persist } = createAsyncEnv();
    storage.map.set('big:1', JSON.stringify({ legacy: true }));
    storage.map.set('funds', '[]');

    const result = await persist.hydrate();

    assert.equal(result.migrated, 1);
    assert.deepEqual(JSON.parse(backend.rows.get('big:1')), { legacy: true });
    assert.equal(storage.map.has('big:1'), false, '迁移成功后应删除 localStorage 里的旧值');
    assert.equal(storage.map.has('funds'), true, '非大对象键不动');
    assert.deepEqual(persist.read('big:1').value, { legacy: true });
  });

  it('迁移失败时留在 localStorage，下次启动再试', async () => {
    const { storage, persist } = createAsyncEnv({ backend: createFakeBackend({ failSave: true }) });
    storage.map.set('big:1', JSON.stringify({ legacy: true }));

    const result = await persist.hydrate();

    assert.equal(result.migrated, 0);
    assert.equal(storage.map.has('big:1'), true);
    assert.deepEqual(persist.read('big:1').value, { legacy: true });
  });

  it('大对象写入只进后端队列，不写 localStorage，落盘后写入后端', async () => {
    const { storage, scheduler, backend, persist } = createAsyncEnv();
    await persist.hydrate();

    persist.write('big:1', JSON.stringify({ a: 2 }));
    assert.equal(storage.map.has('big:1'), false);
    assert.equal(persist.__asyncPending().size, 1);

    scheduler.run();
    await persist.flushAsync();

    assert.equal(storage.calls.setItem, 0, '大对象不应写 localStorage');
    assert.deepEqual(JSON.parse(backend.rows.get('big:1')), { a: 2 });
  });

  it('同一轮内多次写入合并成一次 saveMany', async () => {
    const { scheduler, backend, persist } = createAsyncEnv();
    await persist.hydrate();

    for (let i = 0; i < 10; i++) persist.write('big:1', JSON.stringify({ i }));
    persist.write('big:2', JSON.stringify({ i: 'x' }));
    scheduler.run();
    await persist.flushAsync();

    assert.equal(backend.calls.saveMany, 1, '两个 key 应在一个事务里写完');
    assert.deepEqual(JSON.parse(backend.rows.get('big:1')), { i: 9 });
  });

  it('后端写入失败时退回 localStorage 并通知订阅方', async () => {
    const { storage, scheduler, persist } = createAsyncEnv({ backend: createFakeBackend({ failSave: true }) });
    await persist.hydrate();
    const errors = [];
    persist.setErrorHandler((info) => errors.push(info.key));

    persist.write('big:1', JSON.stringify({ a: 3 }));
    scheduler.run();
    await persist.flushAsync();

    assert.deepEqual(errors, ['big:1']);
    assert.deepEqual(JSON.parse(storage.map.get('big:1')), { a: 3 }, '宁可占 localStorage 也不丢数据');
    assert.deepEqual(persist.read('big:1').value, { a: 3 });
  });

  it('后端不可用时整体退回 localStorage（行为与 P1 之前一致）', async () => {
    const { storage, scheduler, persist } = createAsyncEnv({ backend: createFakeBackend({ unavailable: true }) });

    const result = await persist.hydrate();
    assert.deepEqual(result, { hydrated: false, degraded: true });

    persist.write('big:1', JSON.stringify({ a: 4 }));
    scheduler.run();
    assert.equal(storage.map.get('big:1'), JSON.stringify({ a: 4 }));
  });

  it('keysWithPrefix 计入后端已有的键', async () => {
    const { persist } = createAsyncEnv({
      backend: createFakeBackend({ rows: { 'big:1': '{}', 'big:2': '{}', other: '{}' } })
    });
    await persist.hydrate();
    assert.deepEqual(persist.keysWithPrefix('big:').sort(), ['big:1', 'big:2']);
  });

  it('clearAll 同时清空后端与镜像', async () => {
    const { backend, persist } = createAsyncEnv({ backend: createFakeBackend({ rows: { 'big:1': '{"a":1}' } }) });
    await persist.hydrate();
    assert.deepEqual(persist.read('big:1').value, { a: 1 });

    await persist.clearAll();

    assert.equal(backend.calls.clearAll, 1);
    assert.equal(backend.rows.size, 0);
    assert.equal(persist.read('big:1').raw, null);
    assert.deepEqual(persist.keysWithPrefix('big:'), []);
  });

  it('写入成功后广播 key（不带值），其他标签页写入触发外部回调', async () => {
    const { scheduler, persist, messages, receive } = createAsyncEnv();
    await persist.hydrate();

    const seen = [];
    persist.setExternalWriteHandler((key) => seen.push(key));

    persist.write('big:1', '{"a":1}');
    scheduler.run();
    await persist.flushAsync();
    assert.deepEqual(messages, [{ key: 'big:1' }]);

    receive({ key: 'big:2' });
    assert.deepEqual(seen, ['big:2']);
  });

  it('早期读取留下的空占位不会被水合跳过', async () => {
    const { persist } = createAsyncEnv({ backend: createFakeBackend({ rows: { 'big:1': '{"a":9}' } }) });
    assert.equal(persist.read('big:1').raw, null); // 水合前先读一次，留下占位
    await persist.hydrate();
    assert.deepEqual(persist.read('big:1').value, { a: 9 });
  });
});
