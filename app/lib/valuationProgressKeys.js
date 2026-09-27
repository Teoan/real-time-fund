/**
 * 估值加载进度的键约定
 *
 * 生产方在 `app/api/fund.js` 的取数流程里上报，消费方是卡片里的进度条组件，
 * 两边必须用同一套键，因此单独抽出本模块（而不是各自拼字符串）。
 *
 * 约定：
 *   `${code}`                    当前时点评分
 *   `${code}#history:${range}`   区间走势 —— 与评分分开，两者并行时互不覆盖
 */

/**
 * 当前时点评分的进度键
 * @param {string} code
 * @returns {string}
 */
export const scoreProgressKey = (code) => String(code || '').trim();

/**
 * 区间走势的进度键
 * @param {string} code
 * @param {string} range - '1m' | '3m' | '6m' | '1y' | '3y' | 'all'
 * @returns {string}
 */
export const historyProgressKey = (code, range) => `${String(code || '').trim()}#history:${String(range || '')}`;
