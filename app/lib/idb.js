/**
 * 极简 IndexedDB 封装（无第三方依赖）
 *
 * 为什么不用 idb-keyval：它只是 tesseract.js 的传递依赖，没有写进 package.json
 * （见 package-lock.json 中 idb-keyval 挂在 tesseract.js 之下），直接 import 属于隐性依赖，
 * 一旦上游换实现就会静默失效。本项目只需要「4 个对象仓库 + 按基金代码读写」，
 * 自己封一层不到 100 行，且能精确控制降级行为。
 *
 * 设计要点：
 *   1. **必须能在 SSR 下安全 import**：Next.js 静态导出仍然会做构建期求值，
 *      因此模块顶层不得触碰 indexedDB，所有访问都推迟到函数调用内部。
 *   2. **任何失败都降级为 null/false**，不抛给 UI——波动信号是增强信息，
 *      缓存不可用（Safari 无痕模式、配额耗尽、被浏览器策略禁用）时应当静默回落为「无缓存直算」。
 *   3. 连接按模块级 memo 复用；升级/关闭事件里主动 close，避免多标签页版本冲突时把对方堵死。
 */

/** 数据库名 */
export const FUND_VOLATILITY_DB_NAME = 'fundVolatility';

/** 数据库版本（新增对象仓库时必须 +1，并在 upgrade 里补建） */
export const FUND_VOLATILITY_DB_VERSION = 1;

/**
 * 对象仓库：对应规格 §3 的四类缓存数据
 */
export const IDB_STORES = Object.freeze({
  /** 基金基本信息 */
  BASIC: 'fundBasic',
  /** 基金历史净值 */
  NAV: 'fundNav',
  /** 基金风险指标 */
  RISK: 'fundRisk',
  /** 基金波动信号 */
  SIGNAL: 'fundSignal'
});

const STORE_NAMES = Object.freeze(Object.values(IDB_STORES));

/** 连接 memo（Promise 形式，避免并发重复 open） */
let dbPromise = null;

/**
 * 当前环境是否支持 IndexedDB。
 * 注意：`typeof indexedDB === 'undefined'` 是本仓库允许保留原生 typeof 的场景
 * （全局环境对象检测），且必须用 typeof 而不是直接引用，否则 SSR 下会 ReferenceError。
 */
export const isIndexedDbSupported = () => {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB != null;
  } catch {
    // 个别浏览器在隐私模式下访问该属性会抛异常
    return false;
  }
};

/** 测试钩子：清掉连接 memo，便于用假 indexedDB 反复初始化 */
export const __resetDbCacheForTests = () => {
  dbPromise = null;
};

/**
 * 打开数据库（并发安全、失败返回 null）。
 * @returns {Promise<IDBDatabase|null>}
 */
export const openFundVolatilityDb = () => {
  if (!isIndexedDbSupported()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(FUND_VOLATILITY_DB_NAME, FUND_VOLATILITY_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) {
          // 不设 keyPath：统一用「基金代码」作为外部键，读写都显式传 key
          db.createObjectStore(name);
        }
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // 其他标签页触发版本升级时，主动让位，否则对方会一直 blocked
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    // blocked / error 都视为「缓存不可用」，并清掉 memo 以便稍后重试
    request.onblocked = () => {
      dbPromise = null;
      resolve(null);
    };
    request.onerror = () => {
      dbPromise = null;
      resolve(null);
    };
  });

  return dbPromise;
};

/** IDBRequest → Promise */
const requestToPromise = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });

/**
 * 事务结束 → Promise。
 * ⚠️ 必须在 `await requestToPromise(...)` **之前**调用：
 * 请求成功不等于事务提交成功（配额溢出、磁盘错误都发生在提交阶段），
 * 而且事后再挂 oncomplete 可能永远等不到回调。
 */
const transactionDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
  });

/**
 * 在一个仓库上执行操作，任意异常都不向调用方抛出。
 *
 * 返回 `{ ok, value }` 而不是裸值：put/delete/clear 成功时 request.result 就是 undefined，
 * 用「返回值是否为 undefined」判断成败会把成功全判成失败。
 *
 * @param {string} storeName
 * @param {'readonly'|'readwrite'} mode
 * @param {(store: IDBObjectStore) => IDBRequest} run
 * @returns {Promise<{ ok: boolean, value: any }>}
 */
const withStore = async (storeName, mode, run) => {
  if (!STORE_NAMES.includes(storeName)) return { ok: false, value: null };
  const db = await openFundVolatilityDb();
  if (!db) return { ok: false, value: null };
  try {
    const tx = db.transaction(storeName, mode);
    const done = transactionDone(tx);
    // 若下面的请求先失败，我们会直接跳进 catch 而不再 await done；
    // 此时 done 的 rejection 无人接管，会变成 unhandledRejection（浏览器控制台噪音 + Sentry 上报）。
    // 挂一个空 catch 只是把 done 标记为「已处理」，catch 块里的 try/catch 仍然照常生效。
    done.catch(() => {});
    const value = await requestToPromise(run(tx.objectStore(storeName)));
    await done;
    return { ok: true, value: value === undefined ? null : value };
  } catch {
    return { ok: false, value: null };
  }
};

/**
 * 读取一条缓存。
 * @param {string} storeName
 * @param {string} key 基金代码
 * @returns {Promise<any|null>} 不存在或不可用时 null
 */
export const idbGet = async (storeName, key) => {
  if (key == null) return null;
  const res = await withStore(storeName, 'readonly', (store) => store.get(String(key)));
  return res.ok ? res.value : null;
};

/**
 * 写入一条缓存（覆盖）。
 * @param {string} storeName
 * @param {string} key 基金代码
 * @param {any} value 必须可结构化克隆（纯 JSON 对象即可）
 * @returns {Promise<boolean>} 是否写入成功
 */
export const idbSet = async (storeName, key, value) => {
  if (key == null || value === undefined) return false;
  const res = await withStore(storeName, 'readwrite', (store) => store.put(value, String(key)));
  return res.ok;
};

/**
 * 删除一条缓存。
 * @returns {Promise<boolean>}
 */
export const idbDelete = async (storeName, key) => {
  if (key == null) return false;
  const res = await withStore(storeName, 'readwrite', (store) => store.delete(String(key)));
  return res.ok;
};

/**
 * 清空某个仓库（用于数据结构升级后的一次性重置）。
 * @returns {Promise<boolean>}
 */
export const idbClearStore = async (storeName) => {
  const res = await withStore(storeName, 'readwrite', (store) => store.clear());
  return res.ok;
};

/** 清空全部 4 个仓库 */
export const idbClearAll = async () => {
  const results = await Promise.all(STORE_NAMES.map((name) => idbClearStore(name)));
  return results.every(Boolean);
};
