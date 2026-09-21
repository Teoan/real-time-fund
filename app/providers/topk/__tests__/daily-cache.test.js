/**
 * TopK 天维度缓存单元测试
 *
 * 覆盖：
 *   - 提取最新行 + 映射
 *   - localStorage 读写
 *   - 24h 过期
 *   - 版本不匹配时忽略
 *   - localStorage 不可用时静默
 *
 * 运行：node --test app/providers/topk/__tests__/daily-cache.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getCachedStockFundamental,
  writeCache,
  cacheStockFundamentalFromRows,
  getCachedStockHkValueHistory,
  writeCachedStockHkValueHistory,
  getCachedStockValueWindow,
  writeCachedStockValueWindow,
  cleanExpiredTopKCache,
  getTopKCacheStats,
  __test__ as dailyCacheInternals
} from '../topk-daily-cache.js';

// Mock localStorage
const mockStorage = (() => {
  let store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i) => Object.keys(store)[i] || null,
    clear: () => {
      store = {};
    }
  };
})();

// Patch global localStorage
const origLocalStorage = globalThis.localStorage;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true, configurable: true });
  mockStorage.clear();
});
afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: origLocalStorage, writable: true, configurable: true });
});

describe('extractLatestRow', () => {
  it('取数据日期最新的一行', () => {
    const rows = [
      { 数据日期: '2024-06-01T00:00:00.000', 'PE(TTM)': 15, 市净率: 2 },
      { 数据日期: '2024-06-03T00:00:00.000', 'PE(TTM)': 16, 市净率: 2.1 },
      { 数据日期: '2024-06-02T00:00:00.000', 'PE(TTM)': 15.5, 市净率: 2.05 }
    ];
    const result = dailyCacheInternals.extractLatestRow(rows, { code: '600519' });
    assert.equal(result.pe, 16);
    assert.equal(result.pb, 2.1);
    assert.equal(result.code, '600519');
  });

  it('空数组返回 null', () => {
    assert.equal(dailyCacheInternals.extractLatestRow([], {}), null);
    assert.equal(dailyCacheInternals.extractLatestRow(null, {}), null);
  });

  it('NaN 值归一为 null', () => {
    const rows = [{ 数据日期: '2024-06-01T00:00:00.000', 'PE(TTM)': NaN, 市净率: 'NaT' }];
    const result = dailyCacheInternals.extractLatestRow(rows, {});
    assert.equal(result.pe, null);
    assert.equal(result.pb, null);
  });
});

describe('writeCache / getCachedStockFundamental', () => {
  it('写入后可读取', () => {
    const data = { code: '600519', pe: 20, pb: 6, fetchedAt: Date.now() };
    writeCache('600519', data);
    const cached = getCachedStockFundamental('600519');
    assert.deepEqual(cached, data);
  });

  it('不存在的 key 返回 null', () => {
    assert.equal(getCachedStockFundamental('999999'), null);
  });

  it('24h 后过期', () => {
    const data = { code: '600519', pe: 20 };
    writeCache('600519', data);

    // 手动篡改 ts 为25h 前
    const raw = JSON.parse(mockStorage.getItem('topk:stockFundamentals:600519'));
    raw.ts = Date.now() - 25 * 60 * 60 * 1000;
    mockStorage.setItem('topk:stockFundamentals:600519', JSON.stringify(raw));

    assert.equal(getCachedStockFundamental('600519'), null);
  });

  it('版本不匹配时忽略', () => {
    mockStorage.setItem(
      'topk:stockFundamentals:600519',
      JSON.stringify({
        _v: 999,
        ts: Date.now(),
        data: { code: '600519' }
      })
    );
    assert.equal(getCachedStockFundamental('600519'), null);
  });

  it('损坏的 JSON 静默忽略', () => {
    mockStorage.setItem('topk:stockFundamentals:600519', 'not-json{{{');
    assert.equal(getCachedStockFundamental('600519'), null);
  });
});

describe('cacheStockFundamentalFromRows', () => {
  it('从全量历史中提取最新行并缓存', () => {
    const rows = [
      { 数据日期: '2024-06-01T00:00:00.000', 'PE(TTM)': 15, 市净率: 2, 当日收盘价: 100 },
      { 数据日期: '2024-06-03T00:00:00.000', 'PE(TTM)': 16, 市净率: 2.1, 当日收盘价: 102 }
    ];
    const result = cacheStockFundamentalFromRows('600519', rows, { secid: '1.600519', code: '600519' });
    assert.equal(result.pe, 16);
    assert.equal(result.price, 102);

    // 验证已写入 localStorage
    const cached = getCachedStockFundamental('600519');
    assert.equal(cached.pe, 16);
  });
});

describe('cleanExpiredTopKCache', () => {
  it('清理过期条目，保留未过期条目', () => {
    writeCache('600519', { code: '600519', pe: 20 });
    writeCache('000001', { code: '000001', pe: 5 });

    // 篡改 600519 的 ts 使其过期
    const raw = JSON.parse(mockStorage.getItem('topk:stockFundamentals:600519'));
    raw.ts = Date.now() - 25 * 60 * 60 * 1000;
    mockStorage.setItem('topk:stockFundamentals:600519', JSON.stringify(raw));

    cleanExpiredTopKCache();

    assert.equal(getCachedStockFundamental('600519'), null);
    assert.notEqual(getCachedStockFundamental('000001'), null);
  });
});

describe('getTopKCacheStats', () => {
  it('返回缓存条数和字节数', () => {
    writeCache('600519', { code: '600519', pe: 20 });
    writeCache('000001', { code: '000001', pe: 5 });
    const stats = getTopKCacheStats();
    assert.equal(stats.count, 2);
    assert.ok(stats.totalBytes > 0);
  });
});

describe('港股估值序列天级缓存', () => {
  const series = [
    { date: '2021-09-20', value: 20.1 },
    { date: '2022-07-13', value: 13.76 }
  ];

  it('写入后可读取，按 symbol + indicator 区分', () => {
    writeCachedStockHkValueHistory('00700', 'pe', series);
    assert.deepEqual(getCachedStockHkValueHistory('00700', 'pe'), series);
    // 不同指标 / 不同股票互不影响
    assert.equal(getCachedStockHkValueHistory('00700', 'pb'), null);
    assert.equal(getCachedStockHkValueHistory('09988', 'pe'), null);
  });

  it('缓存键为 topk:hkValueHistory:{symbol}:{indicator}', () => {
    writeCachedStockHkValueHistory('00700', 'pe', series);
    assert.notEqual(mockStorage.getItem('topk:hkValueHistory:00700:pe'), null);
  });

  it('空数组不写入', () => {
    writeCachedStockHkValueHistory('00700', 'pe', []);
    assert.equal(getCachedStockHkValueHistory('00700', 'pe'), null);
  });

  it('24h 后过期', () => {
    writeCachedStockHkValueHistory('00700', 'pe', series);
    const raw = JSON.parse(mockStorage.getItem('topk:hkValueHistory:00700:pe'));
    raw.ts = Date.now() - 25 * 60 * 60 * 1000;
    mockStorage.setItem('topk:hkValueHistory:00700:pe', JSON.stringify(raw));
    assert.equal(getCachedStockHkValueHistory('00700', 'pe'), null);
  });

  it('版本不匹配时忽略', () => {
    mockStorage.setItem('topk:hkValueHistory:00700:pe', JSON.stringify({ _v: 999, ts: Date.now(), data: series }));
    assert.equal(getCachedStockHkValueHistory('00700', 'pe'), null);
  });

  it('损坏的 JSON 静默忽略', () => {
    mockStorage.setItem('topk:hkValueHistory:00700:pe', 'not-json{{{');
    assert.equal(getCachedStockHkValueHistory('00700', 'pe'), null);
  });
});

describe('缓存管理工具覆盖港股序列族', () => {
  it('cleanExpiredTopKCache 同时清理两族缓存', () => {
    writeCache('600519', { code: '600519', pe: 20 });
    writeCachedStockHkValueHistory('00700', 'pe', [{ date: '2022-07-13', value: 13.76 }]);

    // 仅让港股条目过期
    const raw = JSON.parse(mockStorage.getItem('topk:hkValueHistory:00700:pe'));
    raw.ts = Date.now() - 25 * 60 * 60 * 1000;
    mockStorage.setItem('topk:hkValueHistory:00700:pe', JSON.stringify(raw));

    cleanExpiredTopKCache();

    assert.equal(getCachedStockHkValueHistory('00700', 'pe'), null);
    assert.notEqual(getCachedStockFundamental('600519'), null);
  });

  it('getTopKCacheStats 同时统计两族缓存', () => {
    writeCache('600519', { code: '600519', pe: 20 });
    writeCachedStockHkValueHistory('00700', 'pe', [{ date: '2022-07-13', value: 13.76 }]);
    const stats = getTopKCacheStats();
    assert.equal(stats.count, 2);
    assert.ok(stats.totalBytes > 0);
  });
});

describe('A 股分位窗口天级缓存', () => {
  const win = {
    values: { pe: [10, 11], pb: [1, 1.1], ps: [2, 2.1] },
    latest: { date: '2024-06-02', pe: 11, pb: 1.1, ps: 2.1 }
  };

  it('写入后可读取，按 symbol 区分', () => {
    writeCachedStockValueWindow('600519', win);
    assert.deepEqual(getCachedStockValueWindow('600519'), win);
    assert.equal(getCachedStockValueWindow('000001'), null);
  });

  it('缓存键为 topk:stockValueWindow:{symbol}', () => {
    writeCachedStockValueWindow('600519', win);
    assert.notEqual(mockStorage.getItem('topk:stockValueWindow:600519'), null);
  });

  it('缺少 values 时不写入', () => {
    writeCachedStockValueWindow('600519', { latest: null });
    assert.equal(getCachedStockValueWindow('600519'), null);
  });

  it('24h 后过期', () => {
    writeCachedStockValueWindow('600519', win);
    const raw = JSON.parse(mockStorage.getItem('topk:stockValueWindow:600519'));
    raw.ts = Date.now() - 25 * 60 * 60 * 1000;
    mockStorage.setItem('topk:stockValueWindow:600519', JSON.stringify(raw));
    assert.equal(getCachedStockValueWindow('600519'), null);
  });

  it('损坏的 JSON 静默忽略', () => {
    mockStorage.setItem('topk:stockValueWindow:600519', 'not-json{{{');
    assert.equal(getCachedStockValueWindow('600519'), null);
  });

  it('清理与统计工具覆盖窗口族', () => {
    writeCachedStockValueWindow('600519', win);
    assert.equal(getTopKCacheStats().count, 1);

    const raw = JSON.parse(mockStorage.getItem('topk:stockValueWindow:600519'));
    raw.ts = Date.now() - 25 * 60 * 60 * 1000;
    mockStorage.setItem('topk:stockValueWindow:600519', JSON.stringify(raw));
    cleanExpiredTopKCache();
    assert.equal(getCachedStockValueWindow('600519'), null);
  });
});
