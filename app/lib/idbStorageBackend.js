/**
 * storagePersist 的 IndexedDB 后端（P1）
 *
 * 只做三件事，全部 best-effort、不抛错：
 *   - loadAll()  启动水合，一次读出 kv 仓库全部 [key, raw]
 *   - saveMany() 批量写（单事务），value 为 null 表示删除
 *   - clearAll() 清空 kv（仅 storageStore.clear() 会用到）
 *
 * 依赖注入 idb 函数，便于纯 node 单测（见 app/lib/__tests__/idbStorageBackend.test.js）。
 */

import lodash from 'lodash';

import { idbGetAllEntries, idbSetMany, idbClearStore, IDB_STORES } from './idb.js';

const { isFunction, isString } = lodash;

/**
 * @param {object} [deps]
 * @param {(storeName: string) => Promise<Array<[string, any]>|null>} [deps.getAllEntries]
 * @param {(storeName: string, entries: Array<[string, any]>) => Promise<boolean>} [deps.setMany]
 * @param {(storeName: string) => Promise<boolean>} [deps.clearStore]
 * @param {string} [deps.store]
 */
export function createIdbStorageBackend(deps = {}) {
  const getAllEntries = isFunction(deps.getAllEntries) ? deps.getAllEntries : idbGetAllEntries;
  const setMany = isFunction(deps.setMany) ? deps.setMany : idbSetMany;
  const clearStore = isFunction(deps.clearStore) ? deps.clearStore : idbClearStore;
  const store = isString(deps.store) ? deps.store : IDB_STORES.KV;

  return {
    /**
     * @returns {Promise<Map<string, string>|null>} null 表示后端不可用（调用方应退回 localStorage）
     */
    async loadAll() {
      const rows = await getAllEntries(store);
      if (!Array.isArray(rows)) return null;
      const out = new Map();
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const [key, value] = row;
        // KV 仓库里统一存原始字符串；结构异常的数据直接跳过，不让脏数据污染镜像
        if (isString(key) && isString(value)) out.set(key, value);
      }
      return out;
    },

    /**
     * @param {Array<[string, string|null]>} entries
     * @returns {Promise<boolean>}
     */
    async saveMany(entries) {
      if (!Array.isArray(entries) || !entries.length) return true;
      return setMany(store, entries);
    },

    /** @returns {Promise<boolean>} */
    async clearAll() {
      return clearStore(store);
    }
  };
}
