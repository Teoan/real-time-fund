/**
 * A股交易日历：基于 chinese-days 节假日数据，严格判断某日期是否为交易日
 * 交易日 = 周一至周五 且 不在法定节假日
 * 调休补班日（周末变工作日）A股仍休市，故不视为交易日
 */

const CDN_BASE = 'https://cdn.jsdelivr.net/npm/chinese-days@1/dist/years';
const yearCache = new Map(); // year -> Set<dateStr> (holidays)，只在**加载成功**后写入
const yearInFlight = new Map(); // year -> Promise，避免并发重复请求
const yearRetryAfter = new Map(); // year -> 毫秒时间戳，失败后的退避截止时间
const RETRY_BACKOFF_MS = 60 * 1000;

/**
 * 该年份的节假日数据是否已成功加载。
 *
 * 只有加载成功才会返回 true；`isTradingDay` 在未加载的年份会退化成「只排除周末」，
 * 调用方（延迟确认天数、收益补录）可以用这个函数判断结果是否可信。
 * @param {number} year
 * @returns {boolean}
 */
export function hasHolidayData(year) {
  return yearCache.has(year);
}

/**
 * 加载某年的节假日数据。
 *
 * 失败时**不写入缓存**（早期实现写了一个空集合，导致此后整年都按「每个工作日都是交易日」
 * 计算，且再也修不回来），改为 60 秒退避后允许重试；返回值在失败时为 null。
 * @param {number} year
 * @returns {Promise<Set<string>|null>} 节假日日期集合，格式 YYYY-MM-DD；加载失败返回 null
 */
export async function loadHolidaysForYear(year) {
  if (yearCache.has(year)) {
    return yearCache.get(year);
  }
  const inFlight = yearInFlight.get(year);
  if (inFlight) return inFlight;

  const retryAt = yearRetryAfter.get(year);
  if (retryAt && Date.now() < retryAt) return null;

  const task = (async () => {
    try {
      const res = await fetch(`${CDN_BASE}/${year}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const holidays = new Set(Object.keys(data?.holidays ?? {}));
      // 空集合不等于「今年没有节假日」：正常年份至少春节/国庆若干天，视为异常响应，不落缓存
      if (holidays.size === 0) throw new Error('节假日数据为空');
      yearCache.set(year, holidays);
      yearRetryAfter.delete(year);
      return holidays;
    } catch (e) {
      console.warn(`[tradingCalendar] 加载 ${year} 年节假日失败（${RETRY_BACKOFF_MS / 1000}s 后重试）:`, e);
      yearRetryAfter.set(year, Date.now() + RETRY_BACKOFF_MS);
      return null;
    } finally {
      yearInFlight.delete(year);
    }
  })();

  yearInFlight.set(year, task);
  return task;
}

/**
 * 加载多个年份的节假日数据
 * @param {number[]} years
 */
export async function loadHolidaysForYears(years) {
  await Promise.all([...new Set(years)].map(loadHolidaysForYear));
}

/**
 * 判断某日期是否为 A股交易日
 *
 * 注意：该年节假日数据未加载（或加载失败）时，退化为「只排除周末」——结果可能把节假日
 * 误判为交易日。需要区分「确定」与「退化」时，配 `hasHolidayData(year)` 使用。
 * @param {dayjs.Dayjs} date - dayjs 对象
 * @param {Map<number, Set<string>>} [cache] - 可选，已加载的年份缓存，默认使用内部 yearCache
 * @returns {boolean}
 */
export function isTradingDay(date, cache = yearCache) {
  const dayOfWeek = date.day(); // 0=周日, 6=周六
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  const dateStr = date.format('YYYY-MM-DD');
  const year = date.year();
  const holidays = cache.get(year);
  if (!holidays) return true; // 未加载该年数据时，仅排除周末
  return !holidays.has(dateStr);
}

/**
 * 返回 date 当天或之前最近的一个 A 股交易日（dayjs 对象）。
 * 如果 date 自身是交易日则返回自身。最多向前回溯 30 天。
 * @param {dayjs.Dayjs} date - dayjs 对象
 * @returns {dayjs.Dayjs | null} 最近的交易日，找不到时返回 null
 */
export function getPrevTradingDay(date) {
  let d = date.startOf('day');
  let attempts = 30;
  while (attempts-- > 0) {
    if (isTradingDay(d)) return d;
    d = d.subtract(1, 'day');
  }
  return null;
}

/**
 * 计算 startDateStr 与 endDateStr 之间有多少个 A 股交易日
 * （不含 start 当天，含 end 当天；若 start >= end 返回 0）。
 * @param {string} startDateStr - 起始日期 YYYY-MM-DD
 * @param {string} endDateStr   - 结束日期 YYYY-MM-DD
 * @param {function} toDayjs    - 将日期字符串转为 dayjs 对象的函数
 * @returns {number} 交易日天数
 */
export function countTradingDaysBetween(startDateStr, endDateStr, toDayjs) {
  const start = toDayjs(startDateStr).startOf('day');
  const end = toDayjs(endDateStr).startOf('day');
  const totalDays = end.diff(start, 'day');
  if (totalDays <= 0) return 0;
  let count = 0;
  let d = start.add(1, 'day');
  // 安全上限：最多遍历 400 天（覆盖极端跨年长假场景）
  const limit = Math.min(totalDays, 400);
  for (let i = 0; i < limit; i++) {
    if (isTradingDay(d)) count++;
    d = d.add(1, 'day');
  }
  return count;
}
