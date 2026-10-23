/**
 * 交易时段判定与刷新节流（第三批 §3.11）
 *
 * 背景：原刷新循环只有一条「每 refreshMs 一次」的固定节奏，与市场是否开市无关——
 * 半夜、午休、周末照样每分钟打一遍估值接口，既浪费流量又容易触发上游限流；
 * 反过来，盘中若上游 `gztime` 停住不推进（数据源挂了/被墙），前端仍显示「实时估值」，
 * 用户看到的是一条冻结的曲线却毫无提示。
 *
 * 本模块提供三件事，全部是纯函数（`now` 可注入，便于测试）：
 * 1. `getMarketSession(now)`      —— 当前处于盘前/早盘/午休/午盘/盘后/夜间/周末哪一段；
 * 2. `computeRefreshDelay(...)`   —— 结合时段与「连续无推进轮数」算出下一次刷新延迟；
 * 3. `stalenessMinutes(...)`      —— `gztime` 距今落后多少分钟，用于卡片标记「数据延迟」。
 *
 * 时区：A 股时段按 Asia/Shanghai 判定（与 `gztime` 字符串同口径），不受运行机器时区影响。
 * 节假日：本模块只区分交易日/周末；节假日依赖 `tradingCalendar`，未在此处理（周末已覆盖主要空转）。
 */

/** 时段枚举 */
export const MARKET_SESSION = {
  WEEKEND: 'weekend',
  PRE: 'pre',
  MORNING: 'morning',
  LUNCH: 'lunch',
  AFTERNOON: 'afternoon',
  POST: 'post',
  NIGHT: 'night'
};

/** 早盘 9:15 开始（集合竞价 + 估值接口开始出数） */
const MORNING_START_MIN = 9 * 60 + 15;
/** 早盘 11:30 结束 */
const MORNING_END_MIN = 11 * 60 + 30;
/** 午盘 13:00 开始 */
const AFTERNOON_START_MIN = 13 * 60;
/** 午盘 15:00 结束 */
const AFTERNOON_END_MIN = 15 * 60;
/** 净值公布窗口结束（19:30 之后基本已出，无需高频） */
const NAV_PUBLISH_END_MIN = 19 * 60 + 30;

/** 非交易时段的基础刷新间隔：30 分钟 */
export const IDLE_REFRESH_MS = 30 * 60 * 1000;
/** 净值公布窗口的刷新间隔：10 分钟（净值一天只出一次，但要知道「出了没有」） */
export const NAV_PUBLISH_REFRESH_MS = 10 * 60 * 1000;
/** `gztime` 落后超过该分钟数视为「数据延迟」 */
export const STALE_THRESHOLD_MIN = 15;
/** 连续多少轮 `gztime` 不推进后开始退避 */
export const STALL_ROUNDS_LIMIT = 3;
/** 退避后的最小刷新间隔：5 分钟 */
export const STALE_BACKOFF_MS = 5 * 60 * 1000;

const SHANGHAI_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hour12: false
});

/**
 * 取 Asia/Shanghai 下的时间分量
 * @param {number|Date} now
 * @returns {{ date: string, hour: number, minute: number, weekday: string, minutesOfDay: number }}
 */
function shanghaiParts(now) {
  const d = now instanceof Date ? now : new Date(now);
  const parts = {};
  for (const p of SHANGHAI_FORMATTER.formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute,
    weekday: parts.weekday,
    minutesOfDay: hour * 60 + minute
  };
}

/**
 * 判断是否周末（周六/周日）
 * @param {number|Date} now
 */
export function isWeekend(now = Date.now()) {
  const { weekday } = shanghaiParts(now);
  return weekday === 'Sat' || weekday === 'Sun';
}

/**
 * 当前市场时段
 * @param {number|Date} [now]
 * @returns {{ session: string, trading: boolean, minutesOfDay: number, date: string }}
 */
export function getMarketSession(now = Date.now()) {
  const { weekday, minutesOfDay, date } = shanghaiParts(now);
  const weekend = weekday === 'Sat' || weekday === 'Sun';
  let session;
  if (weekend) {
    session = MARKET_SESSION.WEEKEND;
  } else if (minutesOfDay < MORNING_START_MIN) {
    session = MARKET_SESSION.PRE;
  } else if (minutesOfDay < MORNING_END_MIN) {
    session = MARKET_SESSION.MORNING;
  } else if (minutesOfDay < AFTERNOON_START_MIN) {
    session = MARKET_SESSION.LUNCH;
  } else if (minutesOfDay < AFTERNOON_END_MIN) {
    session = MARKET_SESSION.AFTERNOON;
  } else if (minutesOfDay < NAV_PUBLISH_END_MIN) {
    session = MARKET_SESSION.POST;
  } else {
    session = MARKET_SESSION.NIGHT;
  }
  return {
    session,
    trading: session === MARKET_SESSION.MORNING || session === MARKET_SESSION.AFTERNOON,
    minutesOfDay,
    date
  };
}

/**
 * 距离当日某个时刻还有多少毫秒（已过则为 0）
 */
function msUntilMinute(minutesOfDay, nowMs) {
  const { minutesOfDay: cur, hour, minute } = shanghaiParts(nowMs);
  if (minutesOfDay <= cur) return 0;
  const base = new Date(nowMs);
  // 用「当前上海时间 + 差值分钟」推算，避免依赖本机时区
  const deltaMin = minutesOfDay - (hour * 60 + minute);
  return deltaMin * 60 * 1000 - (base.getSeconds() * 1000 + base.getMilliseconds());
}

/**
 * 计算下一次刷新应等待的毫秒数。
 *
 * 规则：
 * - 盘中（9:15–11:30 / 13:00–15:00）：用用户设置的 `refreshMs`，若已连续 N 轮 `gztime` 未推进
 *   则退避到至少 `STALE_BACKOFF_MS`（5 分钟），避免对着一个已经停止更新的源白刷；
 * - 盘前/午休：最多等到下一个时段开始（保证 9:15、13:00 准时恢复）；
 * - 盘后净值公布窗口（15:00–19:30）：10 分钟一次；
 * - 夜间/周末：30 分钟一次（只为捕捉净值补录）。
 *
 * @param {{ refreshMs?: number, now?: number, stalledRounds?: number, session?: string }} params
 * @returns {number} 延迟毫秒，最小 30 秒
 */
export function computeRefreshDelay({ refreshMs = 60 * 1000, now = Date.now(), stalledRounds = 0, session } = {}) {
  const state = session || getMarketSession(now).session;
  const base = Math.max(30 * 1000, Number(refreshMs) || 60 * 1000);
  const stalled = Number(stalledRounds) || 0;

  if (state === MARKET_SESSION.MORNING || state === MARKET_SESSION.AFTERNOON) {
    if (stalled >= STALL_ROUNDS_LIMIT) return Math.max(base, STALE_BACKOFF_MS);
    return base;
  }

  if (state === MARKET_SESSION.PRE) {
    const untilOpen = msUntilMinute(MORNING_START_MIN, now);
    return Math.max(30 * 1000, Math.min(IDLE_REFRESH_MS, untilOpen || IDLE_REFRESH_MS));
  }
  if (state === MARKET_SESSION.LUNCH) {
    const untilAfternoon = msUntilMinute(AFTERNOON_START_MIN, now);
    return Math.max(30 * 1000, Math.min(IDLE_REFRESH_MS, untilAfternoon || IDLE_REFRESH_MS));
  }
  if (state === MARKET_SESSION.POST) {
    return Math.max(base, NAV_PUBLISH_REFRESH_MS);
  }
  return Math.max(base, IDLE_REFRESH_MS);
}

/**
 * `gztime` 距今落后多少分钟
 * @param {string|null|undefined} gztime - 形如 `2026-03-21 14:03`
 * @param {number} [now]
 * @returns {number|null} 无法解析返回 null
 */
export function stalenessMinutes(gztime, now = Date.now()) {
  if (typeof gztime !== 'string') return null;
  const m = gztime.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const { date: today, hour, minute } = shanghaiParts(now);
  if (`${y}-${mo}-${d}` !== today) {
    // 跨日不做分钟级比较（可能只是还没开盘），交给调用方按日期判断
    return null;
  }
  const nowMin = hour * 60 + minute;
  const gzMin = Number(h) * 60 + Number(mi);
  const diff = nowMin - gzMin;
  return diff >= 0 ? diff : null;
}

/**
 * 估值是否已经「看起来不动了」
 * @param {string|null|undefined} gztime
 * @param {number} [now]
 * @param {number} [threshold=STALE_THRESHOLD_MIN]
 * @returns {boolean}
 */
export function isValuationStale(gztime, now = Date.now(), threshold = STALE_THRESHOLD_MIN) {
  const mins = stalenessMinutes(gztime, now);
  return mins != null && mins >= threshold;
}

export const __test__ = {
  shanghaiParts,
  msUntilMinute,
  MORNING_START_MIN,
  MORNING_END_MIN,
  AFTERNOON_START_MIN,
  AFTERNOON_END_MIN,
  NAV_PUBLISH_END_MIN
};
