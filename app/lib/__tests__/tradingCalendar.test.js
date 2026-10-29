/**
 * 交易日历加载与降级行为单元测试
 *
 * 回归重点：**加载失败绝不能落缓存**。早期实现 catch 里写入空集合，导致此后一整年
 * 都把节假日当交易日（延迟确认天数、收益补录全错），而且进程内再也修不回来。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';

import { loadHolidaysForYear, hasHolidayData, isTradingDay } from '../tradingCalendar.js';

const realFetch = globalThis.fetch;
let calls = 0;

const stubFetch = (impl) => {
  calls = 0;
  globalThis.fetch = async (...args) => {
    calls += 1;
    return impl(...args);
  };
};

beforeEach(() => {
  calls = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('loadHolidaysForYear：失败不缓存', () => {
  it('请求失败 → 返回 null，且不写缓存，60 秒内不重复请求', async () => {
    stubFetch(() => {
      throw new Error('network down');
    });
    const first = await loadHolidaysForYear(1901);
    assert.equal(first, null);
    assert.equal(hasHolidayData(1901), false);
    assert.equal(calls, 1);

    // 退避期内第二次调用：直接返回 null，不发请求
    const second = await loadHolidaysForYear(1901);
    assert.equal(second, null);
    assert.equal(calls, 1, '退避期内不应重复请求');
  });

  it('HTTP 非 2xx → 视为失败', async () => {
    stubFetch(() => ({ ok: false, status: 503 }));
    assert.equal(await loadHolidaysForYear(1902), null);
    assert.equal(hasHolidayData(1902), false);
  });

  it('节假日集合为空 → 视为异常响应，不缓存', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ holidays: {} }) }));
    assert.equal(await loadHolidaysForYear(1903), null);
    assert.equal(hasHolidayData(1903), false);
  });

  it('成功后写缓存，并发调用只发一次请求', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ holidays: { '1904-01-01': '元旦' } }) }));
    const [a, b] = await Promise.all([loadHolidaysForYear(1904), loadHolidaysForYear(1904)]);
    assert.ok(a instanceof Set);
    assert.equal(a.size, 1);
    assert.deepEqual([...a], [...b]);
    assert.equal(hasHolidayData(1904), true);
    assert.equal(calls, 1, '并发调用应共用同一个 in-flight 请求');

    // 命中缓存后不再请求
    await loadHolidaysForYear(1904);
    assert.equal(calls, 1);
  });
});

describe('isTradingDay：未加载年份退化为只排除周末', () => {
  it('周六/周日为 false，周一为 true', () => {
    // 1905 年未加载（上面从未请求），走 weekend-only 退化逻辑
    assert.equal(hasHolidayData(1905), false);
    assert.equal(isTradingDay(dayjs('1905-01-07')), false, '周六');
    assert.equal(isTradingDay(dayjs('1905-01-08')), false, '周日');
    assert.equal(isTradingDay(dayjs('1905-01-09')), true, '周一');
  });
});
