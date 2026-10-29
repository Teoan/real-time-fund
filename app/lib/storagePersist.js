/**
 * localStorage 的「内存镜像 + 写合并」持久层。
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
 *   不在「需要解析」之列的 key 连 JSON.parse 都不做（由调用方用 `readValue` 时才解析）。
 * - 落盘时机：下一个宏任务，或页面隐藏 / 卸载时（调用方通过 `flush()` 同步落盘）。
 * - 跨标签页：`storage` 事件到达时让对应 key 失效，下次读取回落到 localStorage。
 * - 写盘失败（配额写满等）：不再同步抛错，改为通过 `setErrorHandler` 通知订阅方。
 *
 * 这个模块只依赖 lodash，不 import 任何带 `@/` 别名的模块，因此可以在纯 node 下单测
 * （见 app/lib/__tests__/storagePersist.test.js）。
 */

import lodash from 'lodash';

const { isFunction, isString } = lodash;

/**
 * @param {object} [options]
 * @param {() => Storage|null} [options.getStorage] 返回 localStorage（SSR 下返回 null）
 * @param {() => object|null} [options.getWindow] 返回 window（用于 storage / pagehide 事件）
 * @param {() => object|null} [options.getDocument] 返回 document（用于 visibilitychange）
 * @param {(fn: Function) => any} [options.schedule] 自定义调度器（默认 setTimeout 0）
 * @param {(id: any) => void} [options.cancelSchedule]
 * @returns {object} 持久层实例
 */
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

  /** key → { raw, value, parsedReady } */
  const memory = new Map();
  /** 待落盘：key → 原始字符串（null 表示删除） */
  let pending = new Map();
  let timer = null;
  let errorHandler = null;
  let listenersReady = false;

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
    const entry = { raw: readFromStorage(key), value: undefined, parsedReady: false };
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

  function flush() {
    if (timer !== null) {
      cancelSchedule(timer);
      timer = null;
    }
    if (!pending.size) return;
    const batch = pending;
    pending = new Map();
    const store = storage();
    if (!store) return;
    for (const [key, raw] of batch) {
      try {
        if (raw === null) store.removeItem(key);
        else store.setItem(key, raw);
      } catch (error) {
        // 配额写满等：镜像保留（本轮会话仍可读），只通知订阅方，不重排队避免无限重试
        if (errorHandler) {
          try {
            errorHandler({ key, error });
          } catch {
            // ignore
          }
        }
      }
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

  return {
    available,

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
      memory.set(key, { raw, value: undefined, parsedReady: false, parsedOk: false });
      if (writeOptions.persist !== false && available()) {
        pending.set(key, raw);
        scheduleFlush();
      }
      return true;
    },

    /** 删除（同样走排队） */
    remove(key) {
      attachListeners();
      memory.set(key, { raw: null, value: undefined, parsedReady: true, parsedOk: false });
      pending.set(key, null);
      scheduleFlush();
    },

    /** 枚举前缀（镜像排队中的 key 也计入） */
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
      for (const [key, raw] of pending) {
        if (!isString(key) || !key.startsWith(prefix)) continue;
        if (raw === null) keys.delete(key);
        else keys.add(key);
      }
      return Array.from(keys);
    },

    flush,

    /** 立即落盘（供页面隐藏 / 测试使用） */
    flushNow: flush,

    /** 写盘失败回调 */
    setErrorHandler(handler) {
      errorHandler = isFunction(handler) ? handler : null;
    },

    /** 测试用：丢弃镜像与排队（不动 localStorage 内容） */
    reset() {
      if (timer !== null) {
        cancelSchedule(timer);
        timer = null;
      }
      memory.clear();
      pending = new Map();
      listenersReady = false;
      errorHandler = null;
    },

    /** 测试用：查看排队情况 */
    __pending() {
      return new Map(pending);
    }
  };
}
