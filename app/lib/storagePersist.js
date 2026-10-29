/**
 * localStorage 的「内存镜像 + 写合并」持久层，大对象可挂 IndexedDB 后端。
 *
 * 背景（实测，见提交说明）：
 * - `localStorage.getItem/setItem` 是同步 IPC，且每次调用都要重新做一遍 JSON 编解码。
 * - 分时序列单只 5 日 ≈ 115KB，20 只 ≈ 2.3MB；旧实现每记录一只基金就要「读全量 + parse ×2
 *   + isEqual + 全量 stringify 写回」，2.3MB 上约 56ms/次，20 只 ≈ 1.1s 主线程（30s 一轮）。
 *
 * 这层提供的能力：
 * - 读：镜像优先（原始字符串 + 解析结果各存一份），命中即返回，不碰 localStorage；
 *   返回的是**副本**，调用方原地修改不会污染镜像。
 * - 写：先更新镜像并排队，同一 key 在一轮内多次写入只落盘最后一次；
 *   不在「需要解析」之列的 key 连 JSON.parse 都不做。
 * - 落盘时机：下一个宏任务，或页面隐藏 / 卸载时（调用方通过 `flush()` 同步落盘）。
 * - 跨标签页：`storage` 事件到达时让对应 key 失效，下次读取回落到 localStorage。
 * - 写盘失败（配额写满等）：不再同步抛错，改为通过 `setErrorHandler` 通知订阅方。
 * - **大对象后端（P1）**：被 `isAsyncKey` 命中的键改存 IndexedDB，启动时 `hydrate()` 一次性
 *   灌进镜像，之后所有同步读依旧走镜像；后端不可用时自动退回 localStorage。
 *
 * 这个模块只依赖 lodash，不 import 任何带 `@/` 别名的模块，因此可以在纯 node 下单测
 * （见 app/lib/__tests__/storagePersist.test.js）。
 */

import lodash from 'lodash';

const { isFunction, isNumber, isString } = lodash;

/** 跨标签页通知用的频道名（只在大对象写入成功后发 key，不带值） */
export const STORAGE_CHANNEL_NAME = 'rtf-storage-writes';

/**
 * @param {object} [options]
 * @param {() => Storage|null} [options.getStorage] 返回 localStorage（SSR 下返回 null）
 * @param {() => object|null} [options.getWindow] 返回 window（用于 storage / pagehide 事件）
 * @param {() => object|null} [options.getDocument] 返回 document（用于 visibilitychange）
 * @param {(fn: Function) => any} [options.schedule] 自定义调度器（默认 setTimeout 0）
 * @param {(id: any) => void} [options.cancelSchedule]
 * @param {(key: string) => boolean} [options.isAsyncKey] 该键是否存到后端（默认无）
 * @param {{ loadAll: Function, saveMany: Function, clearAll?: Function }} [options.asyncBackend]
 * @param {() => object|null} [options.createChannel] 返回 BroadcastChannel（默认用全局实现）
 * @param {number} [options.hydrateTimeoutMs] 水合超时（默认 3000ms）：超时按「后端不可用」处理，
 *   宁可退回 localStorage 也不让启动流程卡在 IndexedDB 上
 * @returns {object} 持久层实例
 */
/** 水合超时的哨兵值 */
const TIMEOUT = Symbol('storage-hydrate-timeout');

export function createStoragePersist(options = {}) {
  const getStorage = isFunction(options.getStorage) ? options.getStorage : () => null;
  const getWindow = isFunction(options.getWindow) ? options.getWindow : () => null;
  const getDocument = isFunction(options.getDocument) ? options.getDocument : () => null;
  const schedule = isFunction(options.schedule) ? options.schedule : (fn) => setTimeout(fn, 0);
  const cancelSchedule =
    options.cancelSchedule !== undefined
      ? options.cancelSchedule
      : (id) => {
          clearTimeout(id);
        };
  const isAsyncKey = isFunction(options.isAsyncKey) ? options.isAsyncKey : () => false;
  const hydrateTimeoutMs = isNumber(options.hydrateTimeoutMs) ? options.hydrateTimeoutMs : 3000;
  const asyncBackend = options.asyncBackend || null;
  const createChannel =
    options.createChannel !== undefined
      ? options.createChannel
      : () => {
          try {
            return typeof BroadcastChannel === 'function' ? new BroadcastChannel(STORAGE_CHANNEL_NAME) : null;
          } catch {
            return null;
          }
        };

  /** key → { raw, value, parsedReady } */
  const memory = new Map();
  /** 本会话显式写过/删过的 key（水合时它们比后端旧值新，不能被覆盖） */
  const touched = new Set();
  /** 待落盘到 localStorage：key → 原始字符串（null 表示删除） */
  let pending = new Map();
  /** 待落盘到后端：key → 原始字符串（null 表示删除） */
  let asyncPending = new Map();
  /** 后端里已知存在的 key（keysWithPrefix 用） */
  const backendKeys = new Set();
  let timer = null;
  let errorHandler = null;
  let externalWriteHandler = null;
  let listenersReady = false;
  let hydrated = false;
  let hydrating = null;
  /** 后端不可用（水合失败 / 被禁用）：所有大对象键退回 localStorage */
  let backendDisabled = false;
  let channel = null;
  let channelReady = false;
  let asyncInFlight = null;

  function storage() {
    try {
      return getStorage() || null;
    } catch {
      return null;
    }
  }

  function available() {
    return !!storage();
  }

  /** 该 key 是否真的走后端（后端不可用时视作普通键） */
  function usesBackend(key) {
    return !!asyncBackend && !backendDisabled && isAsyncKey(key);
  }

  function readFromStorage(key) {
    const store = storage();
    if (!store) return null;
    try {
      return store.getItem(key);
    } catch {
      return null;
    }
  }

  function entryOf(key) {
    const cached = memory.get(key);
    if (cached) return cached;
    // 走后端的键：水合之前以镜像为准（不回落 localStorage，避免读到迁移后的空值）
    const raw = usesBackend(key) && !hydrated ? null : readFromStorage(key);
    const entry = { raw, value: undefined, parsedReady: false };
    memory.set(key, entry);
    return entry;
  }

  /** 解析失败时 parsedOk=false，读取回退为原始字符串 */
  function ensureParsed(entry) {
    if (entry.parsedReady) return entry;
    entry.parsedReady = true;
    if (entry.raw === null) return entry;
    try {
      entry.value = JSON.parse(entry.raw);
      entry.parsedOk = true;
    } catch {
      entry.value = undefined;
      entry.parsedOk = false;
    }
    return entry;
  }

  /** 读取时返回副本：调用方历史上拿到的都是「每次新解析出来的对象」 */
  function cloneValue(value) {
    if (value === null || typeof value !== 'object') return value;
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch {
        // 落到 JSON 往返兜底
      }
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }

  function notifyError(key, error) {
    if (!errorHandler) return;
    try {
      errorHandler({ key, error });
    } catch {
      // ignore
    }
  }

  function getChannel() {
    if (channelReady) return channel;
    channelReady = true;
    try {
      channel = createChannel();
      if (channel && isFunction(channel.addEventListener)) {
        // 其他标签页写了同一个键：只通知，不动镜像（镜像里可能是本标签页更新的值）
        channel.addEventListener('message', (event) => {
          const key = event?.data?.key;
          if (!isString(key) || !externalWriteHandler) return;
          try {
            externalWriteHandler(key);
          } catch {
            // ignore
          }
        });
      }
    } catch {
      channel = null;
    }
    return channel;
  }

  function announce(key) {
    const ch = getChannel();
    if (!ch || !isFunction(ch.postMessage)) return;
    try {
      ch.postMessage({ key });
    } catch {
      // ignore
    }
  }

  /** 同步落盘 localStorage 队列 */
  function flush() {
    if (timer !== null) {
      cancelSchedule(timer);
      timer = null;
    }
    if (pending.size) {
      const batch = pending;
      pending = new Map();
      const store = storage();
      if (store) {
        for (const [key, raw] of batch) {
          try {
            if (raw === null) store.removeItem(key);
            else store.setItem(key, raw);
          } catch (error) {
            // 配额写满等：镜像保留（本轮会话仍可读），只通知订阅方，不重排队避免无限重试
            notifyError(key, error);
          }
        }
      }
    }
    // 大对象队列：异步写，不阻塞页面隐藏时的同步 flush
    if (asyncPending.size) void flushAsync();
  }

  /**
   * 把大对象队列写进后端（单事务批量）。
   * @returns {Promise<boolean>}
   */
  async function flushAsync() {
    if (asyncInFlight) await asyncInFlight.catch(() => {});
    if (!asyncPending.size || !asyncBackend || backendDisabled) return false;
    const batch = asyncPending;
    asyncPending = new Map();
    const entries = Array.from(batch.entries());
    asyncInFlight = (async () => {
      let ok = false;
      try {
        ok = await asyncBackend.saveMany(entries);
      } catch {
        ok = false;
      }
      if (ok) {
        for (const [key, raw] of entries) {
          if (raw === null) backendKeys.delete(key);
          else backendKeys.add(key);
        }
        for (const [key] of entries) announce(key);
        return true;
      }
      // 后端写失败（配额/隐私模式/被策略禁用）：这批值退回 localStorage，宁可占配额也不丢数据
      const store = storage();
      for (const [key, raw] of entries) {
        if (store) {
          try {
            if (raw === null) store.removeItem(key);
            else store.setItem(key, raw);
          } catch {
            // ignore：镜像仍在，本轮会话可读
          }
        }
        notifyError(key, new Error('IndexedDB 写入失败，已退回 localStorage'));
      }
      return false;
    })();
    try {
      return await asyncInFlight;
    } finally {
      asyncInFlight = null;
    }
  }

  function scheduleFlush() {
    if (timer !== null || !available()) return;
    timer = schedule(() => {
      timer = null;
      flush();
    });
  }

  function attachListeners() {
    if (listenersReady) return;
    const win = getWindow();
    if (!win || !isFunction(win.addEventListener)) return;
    listenersReady = true;
    try {
      // 其他标签页写入：镜像失效，下次读取回落到 localStorage
      win.addEventListener('storage', (event) => {
        if (event?.key == null) memory.clear();
        else memory.delete(event.key);
      });
      win.addEventListener('pagehide', flush);
      win.addEventListener('beforeunload', flush);
      const doc = getDocument();
      if (doc && isFunction(doc.addEventListener)) {
        doc.addEventListener('visibilitychange', () => {
          if (doc.visibilityState === 'hidden') flush();
        });
      }
    } catch {
      // ignore
    }
  }

  /**
   * 启动水合：一次性把后端的大对象灌进镜像，并把 localStorage 里的遗留值迁过去。
   *
   * 规则：
   * - 后端读不到（null）→ 视作不可用，这批键永久退回 localStorage（行为与 P1 之前一致）。
   * - 水合前已经写进镜像的键（极少见：启动路径上的写入）优先，不被后端旧值覆盖。
   * - localStorage 里还留着的键视为「比后端新」（后端写失败时才会留在那里）→ 以它为准并迁入后端。
   *
   * @returns {Promise<{ hydrated: boolean, degraded?: boolean, loaded?: number, migrated?: number }>}
   */
  function hydrate() {
    if (!asyncBackend) return Promise.resolve({ hydrated: false });
    if (hydrated) return Promise.resolve({ hydrated: true, loaded: backendKeys.size, migrated: 0 });
    if (hydrating) return hydrating;

    hydrating = (async () => {
      let rows = null;
      let timerId = null;
      try {
        // 超时保护：IndexedDB 打开被阻塞（另一个标签页卡在升级）时不能让首屏一直等
        const timeout = new Promise((resolve) => {
          timerId = setTimeout(() => resolve(TIMEOUT), hydrateTimeoutMs);
          if (timerId && isFunction(timerId.unref)) timerId.unref();
        });
        rows = await Promise.race([Promise.resolve(asyncBackend.loadAll()).catch(() => null), timeout]);
        if (rows === TIMEOUT) rows = null;
      } catch {
        rows = null;
      } finally {
        if (timerId) clearTimeout(timerId);
      }
      if (!(rows instanceof Map)) {
        backendDisabled = true;
        hydrating = null;
        return { hydrated: false, degraded: true };
      }

      for (const [key, raw] of rows) {
        if (!isString(key) || !isString(raw)) continue;
        backendKeys.add(key);
        // 本会话显式写过的优先；早期读取留下的空占位（raw=null）必须被后端值覆盖
        if (touched.has(key)) continue;
        memory.set(key, { raw, value: undefined, parsedReady: false });
      }

      // 迁移：localStorage 里遗留的大对象键
      // 两边都有同一把键时以 localStorage 为准 —— 那是「后端写失败退回本地」留下的值，
      // 比后端里的旧值新；迁移成功后才删除本地副本。
      const migrated = [];
      const store = storage();
      if (store) {
        const localKeys = [];
        try {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (isString(key) && isAsyncKey(key)) localKeys.push(key);
          }
        } catch {
          // ignore
        }
        for (const key of localKeys) {
          if (touched.has(key)) continue; // 启动路径上的写入优先
          const raw = readFromStorage(key);
          if (!isString(raw)) continue;
          memory.set(key, { raw, value: undefined, parsedReady: false });
          migrated.push([key, raw]);
        }
        if (migrated.length) {
          let ok = false;
          try {
            ok = await asyncBackend.saveMany(migrated);
          } catch {
            ok = false;
          }
          if (ok) {
            for (const [key] of migrated) backendKeys.add(key);
            for (const [key] of migrated) {
              try {
                store.removeItem(key);
              } catch {
                // ignore
              }
            }
          } else {
            // 迁不过去就留在原地（镜像里已经是本地值），下次启动再试
            migrated.length = 0;
          }
        }
      }

      hydrated = true;
      hydrating = null;
      return { hydrated: true, loaded: backendKeys.size, migrated: migrated.length };
    })();

    return hydrating;
  }

  return {
    available,

    /** 该键是否走后端（后端不可用时为 false） */
    isAsyncKey: usesBackend,

    /** 是否已完成水合（false 时大对象读不到值；退回 localStorage 也算就绪） */
    isHydrated() {
      return hydrated || backendDisabled || !asyncBackend;
    },

    /** 原始字符串（不解析） */
    getRaw(key) {
      attachListeners();
      return entryOf(key).raw;
    },

    /**
     * 读取并解析
     * @returns {{ raw: string|null, value: any, parsedOk: boolean }}
     */
    read(key) {
      attachListeners();
      const entry = ensureParsed(entryOf(key));
      return {
        raw: entry.raw,
        value: entry.parsedOk ? cloneValue(entry.value) : entry.raw,
        parsedOk: !!entry.parsedOk
      };
    },

    /**
     * 写入（先进镜像，落盘合并到下一轮）
     * @param {string} key
     * @param {string} raw 原始字符串
     * @param {{persist?: boolean}} [writeOptions] `persist: false` 时只更新镜像、不排队落盘
     *   （用于「内容与已存内容深等价、只是 key 顺序不同」的场景，避免无意义的写盘）
     * @returns {boolean} 内容是否发生变化（与镜像中的原始字符串比较）
     */
    write(key, raw, writeOptions = {}) {
      attachListeners();
      const entry = entryOf(key);
      if (entry.raw === raw) return false;
      touched.add(key);
      memory.set(key, { raw, value: undefined, parsedReady: false, parsedOk: false });
      if (writeOptions.persist !== false && available()) {
        if (usesBackend(key)) asyncPending.set(key, raw);
        else pending.set(key, raw);
        scheduleFlush();
      }
      return true;
    },

    /** 删除（同样走排队） */
    remove(key) {
      attachListeners();
      touched.add(key);
      memory.set(key, { raw: null, value: undefined, parsedReady: true, parsedOk: false });
      if (usesBackend(key)) {
        asyncPending.set(key, null);
        backendKeys.delete(key);
      } else {
        pending.set(key, null);
      }
      scheduleFlush();
    },

    /** 枚举前缀（镜像排队中的 key 与后端已知的 key 都计入） */
    keysWithPrefix(prefix) {
      const keys = new Set();
      const store = storage();
      if (store) {
        try {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (isString(key) && key.startsWith(prefix)) keys.add(key);
          }
        } catch {
          // ignore
        }
      }
      for (const key of backendKeys) {
        if (isString(key) && key.startsWith(prefix)) keys.add(key);
      }
      for (const [key, raw] of [...pending, ...asyncPending]) {
        if (!isString(key) || !key.startsWith(prefix)) continue;
        if (raw === null) keys.delete(key);
        else keys.add(key);
      }
      return Array.from(keys);
    },

    flush,

    /** 立即落盘（供页面隐藏 / 测试使用） */
    flushNow: flush,

    /** 等待大对象队列写完（测试与启动流程用） */
    flushAsync,

    /** 启动水合 */
    hydrate,

    /** 写盘失败回调 */
    setErrorHandler(handler) {
      errorHandler = isFunction(handler) ? handler : null;
    },

    /** 其他标签页写入了某个键（大对象后端没有 storage 事件，靠 BroadcastChannel 补） */
    setExternalWriteHandler(handler) {
      externalWriteHandler = isFunction(handler) ? handler : null;
    },

    /**
     * 清空全部内容（storageStore.clear 用）：镜像、两个队列与后端一起清。
     * @returns {Promise<boolean>}
     */
    async clearAll() {
      if (timer !== null) {
        cancelSchedule(timer);
        timer = null;
      }
      memory.clear();
      touched.clear();
      pending = new Map();
      asyncPending = new Map();
      backendKeys.clear();
      if (!asyncBackend || backendDisabled || !isFunction(asyncBackend.clearAll)) return true;
      try {
        return await asyncBackend.clearAll();
      } catch {
        return false;
      }
    },

    /** 测试用：丢弃镜像与排队（不动 localStorage / 后端内容） */
    reset() {
      if (timer !== null) {
        cancelSchedule(timer);
        timer = null;
      }
      memory.clear();
      touched.clear();
      pending = new Map();
      asyncPending = new Map();
      backendKeys.clear();
      listenersReady = false;
      errorHandler = null;
      externalWriteHandler = null;
      hydrated = false;
      hydrating = null;
      backendDisabled = false;
      channel = null;
      channelReady = false;
      asyncInFlight = null;
    },

    /** 测试用：查看排队情况 */
    __pending() {
      return new Map(pending);
    },

    /** 测试用：查看大对象排队情况 */
    __asyncPending() {
      return new Map(asyncPending);
    }
  };
}
