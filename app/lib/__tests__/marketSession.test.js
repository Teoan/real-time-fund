import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MARKET_SESSION,
  STALE_THRESHOLD_MIN,
  STALE_BACKOFF_MS,
  IDLE_REFRESH_MS,
  NAV_PUBLISH_REFRESH_MS,
  getMarketSession,
  computeRefreshDelay,
  stalenessMinutes,
  isValuationStale,
  isWeekend
} from '../marketSession.js';

/** 北京时间 → 时间戳（不依赖本机时区） */
const sh = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
/** 2026-03-20 是周五 */
const FRI = [2026, 3, 20];

describe('getMarketSession', () => {
  it('按时段切分：盘前 / 早盘 / 午休 / 午后 / 盘后 / 夜间', () => {
    const at = (h, mi) => getMarketSession(sh(FRI[0], FRI[1], FRI[2], h, mi));
    assert.equal(at(8, 0).session, MARKET_SESSION.PRE);
    assert.equal(at(9, 14).session, MARKET_SESSION.PRE);
    assert.equal(at(9, 15).session, MARKET_SESSION.MORNING);
    assert.equal(at(11, 29).session, MARKET_SESSION.MORNING);
    assert.equal(at(11, 30).session, MARKET_SESSION.LUNCH);
    assert.equal(at(12, 59).session, MARKET_SESSION.LUNCH);
    assert.equal(at(13, 0).session, MARKET_SESSION.AFTERNOON);
    assert.equal(at(14, 59).session, MARKET_SESSION.AFTERNOON);
    assert.equal(at(15, 0).session, MARKET_SESSION.POST);
    assert.equal(at(19, 29).session, MARKET_SESSION.POST);
    assert.equal(at(19, 30).session, MARKET_SESSION.NIGHT);
  });

  it('只有早盘与午后算 trading', () => {
    const trading = (h) => getMarketSession(sh(FRI[0], FRI[1], FRI[2], h)).trading;
    assert.equal(trading(10), true);
    assert.equal(trading(14), true);
    assert.equal(trading(12), false);
    assert.equal(trading(8), false);
    assert.equal(trading(16), false);
  });

  it('周末整天都是 WEEKEND（即便钟点在盘中）', () => {
    const sat = getMarketSession(sh(2026, 3, 21, 10));
    assert.equal(sat.session, MARKET_SESSION.WEEKEND);
    assert.equal(sat.trading, false);
    assert.equal(isWeekend(sh(2026, 3, 21, 10)), true);
    assert.equal(isWeekend(sh(2026, 3, 20, 10)), false);
  });
});

describe('computeRefreshDelay（§3.11 时段门控）', () => {
  it('盘中用用户设置的间隔', () => {
    const now = sh(FRI[0], FRI[1], FRI[2], 10);
    assert.equal(computeRefreshDelay({ refreshMs: 60000, now }), 60000);
  });

  it('连续 3 轮 gztime 不推进 → 退避到 5 分钟', () => {
    const now = sh(FRI[0], FRI[1], FRI[2], 10);
    assert.equal(computeRefreshDelay({ refreshMs: 60000, now, stalledRounds: 2 }), 60000);
    assert.equal(computeRefreshDelay({ refreshMs: 60000, now, stalledRounds: 3 }), STALE_BACKOFF_MS);
    // 用户本来就设得比退避更长时，取更长的那个
    assert.equal(computeRefreshDelay({ refreshMs: 20 * 60000, now, stalledRounds: 5 }), 20 * 60000);
  });

  it('盘后净值公布窗口至少 10 分钟一次', () => {
    const now = sh(FRI[0], FRI[1], FRI[2], 16);
    assert.equal(computeRefreshDelay({ refreshMs: 60000, now }), NAV_PUBLISH_REFRESH_MS);
  });

  it('夜间/周末降到 30 分钟一次', () => {
    assert.equal(computeRefreshDelay({ refreshMs: 60000, now: sh(FRI[0], FRI[1], FRI[2], 22) }), IDLE_REFRESH_MS);
    assert.equal(computeRefreshDelay({ refreshMs: 60000, now: sh(2026, 3, 22, 10) }), IDLE_REFRESH_MS);
  });

  it('盘前最多等到 9:15（而不是傻等 30 分钟）', () => {
    const now = sh(FRI[0], FRI[1], FRI[2], 9, 5);
    const delay = computeRefreshDelay({ refreshMs: 60000, now });
    assert.equal(delay, 10 * 60 * 1000);
  });

  it('午休等到 13:00', () => {
    const now = sh(FRI[0], FRI[1], FRI[2], 12, 30);
    assert.equal(computeRefreshDelay({ refreshMs: 60000, now }), 30 * 60 * 1000);
  });

  it('间隔下限 30 秒，避免设置成 1 秒把接口打爆', () => {
    const now = sh(FRI[0], FRI[1], FRI[2], 10);
    assert.equal(computeRefreshDelay({ refreshMs: 1000, now }), 30 * 1000);
  });
});

describe('stalenessMinutes / isValuationStale', () => {
  it('同日落后分钟数', () => {
    const now = sh(FRI[0], FRI[1], FRI[2], 14, 20);
    assert.equal(stalenessMinutes('2026-03-20 14:03', now), 17);
    assert.equal(isValuationStale('2026-03-20 14:03', now), true);
    assert.equal(isValuationStale('2026-03-20 14:10', now), false);
    assert.equal(isValuationStale('2026-03-20 14:10', now, 5), true);
    assert.equal(STALE_THRESHOLD_MIN, 15);
  });

  it('跨日 / 未来时间 / 非法格式 → null（交给调用方按日期判断）', () => {
    const now = sh(FRI[0], FRI[1], FRI[2], 14, 20);
    assert.equal(stalenessMinutes('2026-03-19 14:03', now), null);
    assert.equal(stalenessMinutes('2026-03-20 15:00', now), null);
    assert.equal(stalenessMinutes('昨天', now), null);
    assert.equal(stalenessMinutes(null, now), null);
    assert.equal(isValuationStale(null, now), false);
  });
});
