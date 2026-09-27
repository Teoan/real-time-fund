import { create } from 'zustand';
// 与 app/lib/valuationHistory.js 同理：lodash 是 CJS 包，Node 的 ESM 加载器解析不了命名导出，
// 用「默认导入 + 解构」才能让本模块被 node --test 直接加载（有对应单测）。
import lodash from 'lodash';

const { isNumber, isString } = lodash;

/**
 * 估值计算的加载进度（临时 UI 状态，不落 localStorage、不参与云同步）
 *
 * 为什么用 store 而不是回调/props：
 *   进度是在 `app/api/fund.js` 的取数流程里产生的（逐只拉个股估值、逐项算历史分位），
 *   而消费它的是卡片里的估值面板。两者之间隔着 TanStack Query，
 *   把回调一路透传进 queryFn 不现实，因此用一个按键订阅的临时 store 解耦。
 *
 * key 约定：
 *   `${fundCode}`            当前时点评分
 *   `${fundCode}#history:${range}`  区间走势（与评分互不干扰，避免并行时进度互相覆盖）
 *
 * @typedef {{ percent: number|null, label: string, phase: string, done: number|null, total: number|null }} ValuationProgress
 */

/** 最多保留的进度条目数（防止长时间使用后无界增长；每条仅百余字节） */
const MAX_ENTRIES = 80;

export const useValuationProgressStore = create((set) => ({
  /** @type {Record<string, ValuationProgress>} */
  progress: {},

  /**
   * 写入进度。percent 单调不减 —— 阶段切换时总量会重新计算，
   * 若不夹紧会出现「进度条回退」的观感问题。
   *
   * @param {string} key
   * @param {Partial<ValuationProgress>} patch
   */
  setProgress: (key, patch) =>
    set((state) => {
      const k = isString(key) ? key.trim() : '';
      if (!k || !patch) return state;

      const prev = state.progress[k];
      const next = { ...(prev || {}), ...patch };
      if (isNumber(prev?.percent) && isNumber(next.percent)) {
        next.percent = Math.max(prev.percent, next.percent);
      }
      next.percent = isNumber(next.percent) ? Math.max(0, Math.min(100, next.percent)) : null;

      const progress = { ...state.progress, [k]: next };
      const keys = Object.keys(progress);
      if (keys.length > MAX_ENTRIES) {
        // 淘汰最早写入的条目（依赖对象键的插入顺序）
        for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) delete progress[stale];
      }
      return { progress };
    }),

  /** @param {string} key */
  clearProgress: (key) =>
    set((state) => {
      const k = isString(key) ? key.trim() : '';
      if (!k || !(k in state.progress)) return state;
      const progress = { ...state.progress };
      delete progress[k];
      return { progress };
    })
}));
