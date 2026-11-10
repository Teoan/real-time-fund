/**
 * 市场快讯的纯展示逻辑（合并 / 去重 / 排序 / 时间格式化）。
 *
 * 为什么单独一个模块而不是塞进 NewsTab 或 fund.js：
 *   - 这 5 个资讯源内容高度重复（同一条通稿会同时出现在新浪/同花顺/富途），
 *     合并去重是「正确性」问题，不是样式问题，必须有单测守住；
 *   - 纯函数不碰网络、不碰 localStorage，可以在 node:test 里直接跑；
 *   - Provider 只负责「单源 → 归一化条目」，跨源合并属于业务决策，放这里最合适。
 *
 * 条目结构见 aktools-mappers.js 的 buildNewsItem：
 *   { id, source, sourceLabel, title, content, summary, tag, url, publishedAt, important }
 *
 * ⚠️ publishedAt 是**不带时区**的本地时间串（`YYYY-MM-DDTHH:mm:ss`）。
 *    `new Date(...)` 解析这种格式时按本地时区处理，正好符合上游「中国市场本地时间」的口径。
 */
import lodash from 'lodash';

const { isArray, isString, isNumber, isNil } = lodash;

/** 合并后的默认条数上限：em 单源就 200 条，不封顶会让首屏 DOM 过大 */
export const MARKET_FLASH_MAX_ITEMS = 300;

/**
 * 去重指纹长度。
 *
 * 取归一化后的前 30 字：同一条通稿在不同源里的标题通常一字不差，
 * 但偶有全角/半角、末尾省略号、方括号包裹等差异，按前 N 字比较比全等更稳。
 * 再长会把「同一事件不同角度」误判为重复，再短容易把不同新闻误合并。
 */
const FINGERPRINT_LENGTH = 30;

/**
 * 文本归一化：去掉标点、方括号、空白并转小写，只留可比较的正文。
 *
 * 去掉的字符包含快讯里高频出现的 `【】（）()《》：:，,。.、…！!？?` 与各类空白。
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
export const normalizeNewsText = (text) => {
  if (!isString(text)) return '';
  // 白名单法（只保留字母/数字/汉字）比逐个列举标点可靠：
  // 上游标题里混着全角/半角括号、各种省略号、不间断空格，枚举法总会漏。
  return (
    text
      // 小数尾零先抹平再丢标点：`涨0.70%` 与 `涨0.7%` 是同一条通稿，
      // 不处理会让「港股午评…0.7% / 0.70%」这类重复逃过去重（真实踩到过）。
      .replace(/(\d+)\.(\d+)/g, (_, intPart, fracPart) => `${intPart}.${fracPart.replace(/0+$/, '')}`)
      .replace(/[^\p{L}\p{N}]/gu, '')
      .toLowerCase()
  );
};

/**
 * 生成去重指纹。
 *
 * 同时返回两个形态，因为它们各自解决一类重复：
 *   - `prefix`（前 30 字）：解决「几乎一模一样」的转载，比如只差标点或小数尾零；
 *   - `full`（归一化全文）：解决「加前缀/后缀」的转载，例如
 *     `财联社11月10日电，日本半导体企业Rapidus…` 与 `日本半导体企业Rapidus…`。
 *     只用 prefix 做包含判断会失败 —— 短标题落在长标题的 30 字窗口之外。
 *
 * @param {object} item
 * @returns {{ prefix: string, full: string }}
 */
const fingerprintOf = (item) => {
  const raw = item.title || item.content || item.summary || '';
  const full = normalizeNewsText(raw);
  return { prefix: full.slice(0, FINGERPRINT_LENGTH), full };
};

/**
 * 解析 publishedAt（'YYYY-MM-DDTHH:mm:ss' / 'YYYY-MM-DD'）为毫秒时间戳。
 * 非法或缺失返回 null（排序时沉底）。
 *
 * @param {string|null|undefined} publishedAt
 * @returns {number|null}
 */
export const parseNewsTimestamp = (publishedAt) => {
  if (!isString(publishedAt)) return null;
  const trimmed = publishedAt.trim();
  if (!trimmed) return null;
  const ms = new Date(trimmed).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * 按发布时间倒序；无时间的条目沉底且**保持原有相对顺序**（财新没有时间字段，
 * 它的顺序来自上游，不能被打乱）。
 *
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export const sortByPublishedDesc = (items) => {
  if (!isArray(items) || items.length === 0) return [];
  const timed = [];
  const untimed = [];
  for (const item of items) {
    if (!item) continue;
    if (isNumber(parseNewsTimestamp(item.publishedAt))) timed.push(item);
    else untimed.push(item);
  }
  // Array.prototype.sort 在 V8 上稳定，时间相同时保留输入顺序（≈源优先级）
  timed.sort((a, b) => parseNewsTimestamp(b.publishedAt) - parseNewsTimestamp(a.publishedAt));
  return timed.concat(untimed);
};

/**
 * 判断两个指纹是否指向同一条通稿。
 *
 * 先比全等，再比**包含关系**：通稿在转载时常被加上前后缀，实测真实数据里的两种形态——
 *   `财联社11月10日电，日本半导体企业Rapidus…`  vs  `日本半导体企业Rapidus…`
 *   `宁波舟山港年集装箱吞吐量再破4000万箱`        vs  `提前22天！宁波舟山港年集装箱吞吐量再破4000万箱`
 * 全等比对漏掉这两种，而它们在「全部」流里就是同一句话连着出现两遍。
 *
 * 用最短 12 字做闸门：更短的指纹（如「欧股高开」）包含在长标题里属于巧合，不能合并。
 */
const FINGERPRINT_CONTAINMENT_MIN = 12;

/**
 * @param {{prefix: string, full: string}} a
 * @param {{prefix: string, full: string}} b
 */
const isSameFingerprint = (a, b) => {
  if (a.prefix === b.prefix) return true;
  if (a.full.length < FINGERPRINT_CONTAINMENT_MIN || b.full.length < FINGERPRINT_CONTAINMENT_MIN) return false;
  return a.full.includes(b.full) || b.full.includes(a.full);
};

/**
 * 合并多源快讯：按指纹去重 → 时间倒序 → 截断。
 *
 * 去重保留**先出现**的那条，因此调用方传进来的顺序就是优先级
 * （业务层按 config 的 AKTOOLS_NEWS_SOURCES.priority 传：cls > em > ths > sina > futu）。
 *
 * @param {Array<object>} items 各源条目按优先级拼接后的数组
 * @param {{ limit?: number }} [options]
 * @returns {{ items: Array<object>, removed: number, total: number }}
 *   removed = 被去掉的重复条数（UI 用来显示「去重 N 条」）
 */
export const mergeMarketFlash = (items, { limit = MARKET_FLASH_MAX_ITEMS } = {}) => {
  if (!isArray(items) || items.length === 0) return { items: [], removed: 0, total: 0 };

  // 已保留条目的指纹（约 300 条 × 一两百字，逐个 includes 比较在当前量级完全够用）
  const keptFingerprints = [];
  const kept = [];
  for (const item of items) {
    if (!item || !isString(item.source)) continue;
    const fingerprint = fingerprintOf(item);
    const duplicated =
      fingerprint.full && keptFingerprints.some((existing) => isSameFingerprint(existing, fingerprint));
    if (duplicated) continue;
    if (fingerprint.full) keptFingerprints.push(fingerprint);
    kept.push(item);
  }

  const sorted = sortByPublishedDesc(kept);
  const capped = isNumber(limit) && limit > 0 ? sorted.slice(0, limit) : sorted;
  return { items: capped, removed: items.length - kept.length, total: capped.length };
};

/**
 * 单源筛选（'all' / null 表示不过滤）。
 *
 * @param {Array<object>} items
 * @param {string|null|undefined} sourceId
 * @returns {Array<object>}
 */
export const filterBySource = (items, sourceId) => {
  if (!isArray(items)) return [];
  if (!isString(sourceId) || sourceId === 'all') return items;
  return items.filter((item) => item && item.source === sourceId);
};

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 快讯时间显示：当天只给 `HH:mm`（时间轴上一眼可读），跨天补 `MM-DD`。
 *
 * @param {string|null|undefined} publishedAt
 * @param {number} [now] 便于测试注入
 * @returns {string} 无法解析时返回 '—'
 */
export const formatNewsTime = (publishedAt, now = Date.now()) => {
  const ms = parseNewsTimestamp(publishedAt);
  if (!isNumber(ms)) return '—';
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return sameDay ? time : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
};

/**
 * 相对时间（「3 分钟前」）：列表里比绝对时间更易判断新鲜度。
 *
 * @param {string|null|undefined} publishedAt
 * @param {number} [now]
 * @returns {string}
 */
export const formatRelativeTime = (publishedAt, now = Date.now()) => {
  const ms = parseNewsTimestamp(publishedAt);
  if (!isNumber(ms)) return '';

  const diff = now - ms;
  // 上游时间可能比本地时钟略超前（抓取时间 vs 发布时间），负值按「刚刚」处理
  if (diff < 60 * 1000) return '刚刚';

  const minutes = Math.floor(diff / (60 * 1000));
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;

  return formatNewsTime(publishedAt, now);
};

/**
 * 本地时钟 `HH:mm:ss`，用于页头「更新于 …」。
 * @param {number} [ts]
 * @returns {string}
 */
export const formatClock = (ts = Date.now()) => {
  if (!isNumber(ts)) return '—';
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/**
 * 正文超出阈值才提供「展开」按钮，避免给两行文本也挂个开关。
 * @param {string|null|undefined} text
 * @param {number} [threshold]
 * @returns {boolean}
 */
export const shouldCollapseText = (text, threshold = 120) => {
  if (!isString(text)) return false;
  return text.length > threshold;
};

/**
 * 「更新于 …」文案：优先用最早一次成功取数时间，缺失则回退当前时间。
 * @param {number|null|undefined} fetchedAt
 * @returns {string}
 */
export const formatFetchedAt = (fetchedAt) => {
  if (isNil(fetchedAt) || !isNumber(fetchedAt)) return '—';
  return formatClock(fetchedAt);
};

/**
 * 去掉快讯开头常见的电头（「财联社11月10日电，」「11月10日讯：」）。
 *
 * 这类前缀在列表里几乎每一条都有，占掉标题开头 10 个字却零信息量 ——
 * 来源与日期已经由条目的元信息行（时间 + 来源徽标）表达过。
 *
 * 只匹配「日期 + 电/讯 + 分隔符」这一种固定形态，不做泛化，避免误伤正文。
 */
const DATELINE_RE = /^(?:财联社|上证报|证券时报|中证网|新华社|中新网)?\s*\d{1,2}月\d{1,2}日(?:电|讯)[，,、:：]?\s*/;

const stripDateline = (text) => (isString(text) ? text.replace(DATELINE_RE, '') : text);

/**
 * 把「标题 + 正文」拆成互不重复的两段。
 *
 * 三个源的标题形态不一样，直接并排渲染会看到同一句话两遍：
 *   - 新浪：没有标题列，标题由正文的 `【标题】正文…` 派生
 *   - 财联社：有标题列，但正文同样以 `【标题】` 开头
 *   - 东财：标题列本身就是整条快讯，正文为空
 * 因此：标题照常加粗展示，正文若以标题开头就把这段前缀剥掉。
 *
 * @param {{ title?: string|null, content?: string|null, summary?: string|null }} item
 * @returns {{ title: string, body: string }}
 */
export const splitTitleAndBody = (item) => {
  const rawTitle = (item.title || '').trim();
  const rawText = (item.content || item.summary || '').trim();

  const title = stripDateline(rawTitle);
  let text = rawText;

  if (!title) return { title: '', body: stripDateline(text) };

  /*
   * 截断标题（以省略号结尾）说明标题只是正文开头几十字的截断，不是一句完整的话。
   * 这时**不能**拿它去剥离正文 —— 剥完正文会从半句开始（「…从9」的后面直接接「月的0.6%」）。
   * 处理办法：标题不展示，正文完整展示；只有正文为空时才退回用标题兜底。
   */
  if (title.endsWith('…')) {
    text = stripDateline(text);
    return text ? { title: '', body: text } : { title, body: '' };
  }

  // ① 先剥掉正文开头的「【标题】」：财联社/新浪都是这种形态
  if (text.startsWith(`【${title}】`)) text = text.slice(title.length + 2);
  else if (text.startsWith(`【${rawTitle}】`)) text = text.slice(rawTitle.length + 2);
  else if (text.startsWith(title)) text = text.slice(title.length);

  // ② 再剥电头：必须在 ① 之后 —— 正文真正的开头是「财联社11月10日电，」，
  //    而它前面还挡着一个「【标题】」，先剥电头会匹配不到（真实数据踩过）
  text = stripDateline(text);
  // 少数情况下「【标题】」与标题列不完全一致，残留的方括号标题一并去掉
  text = text.replace(/^【[^】]{2,60}】/, '');
  text = stripDateline(text);

  // ③ 剥完前缀常剩下一个句读符（东财「标题即全文」的变体），一并清掉
  text = text.replace(/^[。，、：；!！?？\s]+/, '');

  if (!text) return { title, body: '' };
  if (title === text) return { title, body: '' };
  return { title, body: text };
};

/**
 * 归一化「快讯源选择」。
 *
 * 三种入参都要支持，且**必须区分「单个源」与「全量」**：
 *   'all' / null / undefined  → 全部源
 *   'em'                      → 仅东财（曾经的 bug：字符串被当成非数组 → 回落全量，
 *                               导致点任何来源 chip 都取回全部 5 源，过滤形同虚设）
 *   ['em', 'sina']            → 指定多源
 *
 * 非法 id 一律丢弃，并保持 `allowed` 的顺序（即去重优先级）；全部非法时回落全量，
 * 避免用户点了个不存在的源得到一片空白。
 *
 * @param {string|string[]|null|undefined} sources
 * @param {string[]} allowed 允许的源 id 列表（顺序即优先级）
 * @returns {string[]}
 */
export const resolveFlashSources = (sources, allowed) => {
  const ids = isArray(allowed) ? allowed : [];
  if (isNil(sources) || sources === 'all') return [...ids];

  const requested = isArray(sources) ? sources : [sources];
  const picked = new Set();
  for (const raw of requested) {
    if (!isString(raw)) continue;
    const id = raw.trim();
    if (id && ids.includes(id)) picked.add(id);
  }

  // 按 allowed 顺序输出，保证去重优先级与「全部」视图一致
  const ordered = ids.filter((id) => picked.has(id));
  return ordered.length > 0 ? ordered : [...ids];
};

/**
 * 只取时分（`HH:mm`），用于**已按日期分组**的列表。
 *
 * 与 formatNewsTime 的分工：那个在跨天时补 `MM-DD`，适合无分组的自由时间轴；
 * 走到分组渲染时，日期已经在分组标题里说过一次，条目里再重复就是噪音。
 *
 * @param {string|null|undefined} publishedAt
 * @returns {string}
 */
export const formatTimeOfDay = (publishedAt) => {
  if (!isString(publishedAt)) return '—';
  const m = publishedAt.match(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/);
  return m ? m[1] : '—';
};

/**
 * 分组标题：今天 / 昨天 / M月D日。
 *
 * @param {string} dateKey 'YYYY-MM-DD'
 * @param {number} [now]
 * @returns {string}
 */
export const formatDayLabel = (dateKey, now = Date.now()) => {
  if (!isString(dateKey)) return '';
  const parts = dateKey.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !isNumber(n))) return dateKey;
  const [year, month, day] = parts;

  const n = new Date(now);
  const todayKey = `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
  if (dateKey === todayKey) return '今天';

  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  const yesterdayKey = `${y.getFullYear()}-${pad2(y.getMonth() + 1)}-${pad2(y.getDate())}`;
  if (dateKey === yesterdayKey) return '昨天';

  return year === n.getFullYear() ? `${month}月${day}日` : `${year}年${month}月${day}日`;
};

/**
 * 把已按时间倒序的条目按「自然日」切段，供带日期分隔线的列表渲染。
 *
 * 输入必须已排序（业务侧由 mergeMarketFlash 保证），这里只做相邻切分，
 * 不做二次排序 —— 否则无时间条目（财新）会被打乱。
 *
 * @param {Array<object>} items
 * @param {number} [now]
 * @returns {Array<{ key: string, label: string, items: Array<object> }>}
 */
export const groupFlashByDate = (items, now = Date.now()) => {
  if (!isArray(items) || items.length === 0) return [];

  const groups = [];
  let current = null;
  for (const item of items) {
    if (!item) continue;
    const key = isString(item.publishedAt) && item.publishedAt.length >= 10 ? item.publishedAt.slice(0, 10) : 'unknown';
    if (!current || current.key !== key) {
      current = { key, label: key === 'unknown' ? '时间未知' : formatDayLabel(key, now), items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
};
