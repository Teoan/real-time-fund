/**
 * 波动信号本地缓存 + 取数编排单元测试
 *
 * 覆盖：
 *   - IndexedDB 不可用（SSR / 无痕模式 / Node 单测环境）时的静默降级
 *   - 缓存版本号不符时强制失效并删除旧记录
 *   - 风险指标 / 波动信号按「净值指纹」（asOfDate + navCount）复用，指纹不符即重算
 *   - 净值写入时裁剪到保留窗口
 *   - 规格 §8 的完整流程：缓存命中 → 补最新 → 计算 → 回写
 *   - 取数失败时用本地缓存兜底，不把页面打成空白
 *
 * 运行：node --test app/lib/__tests__/fundVolatilityCache.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  IDB_STORES,
  idbClearAll,
  idbClearStore,
  idbDelete,
  idbGet,
  idbSet,
  isIndexedDbSupported,
  openFundVolatilityDb
} from '../idb.js';
import {
  NAV_CACHE_TTL_MS,
  NAV_CACHE_VERSION,
  NAV_RETENTION_DAYS,
  SIGNAL_CACHE_VERSION,
  createFundVolatilityCache,
  isNavCacheStale
} from '../fundVolatilityCache.js';
import { loadFundVolatility } from '../fundVolatilityService.js';
import { VOLATILITY_STATES } from '../fundVolatility.js';

// ── 测试工具 ──────────────────────────────────────────────────────────────

/** 内存版 adapter：接口与 app/lib/idb.js 的 4 个函数一致，避免为单测引入 fake-indexeddb */
const createMemoryAdapter = () => {
  const map = new Map();
  const key = (store, k) => `${store}\u001f${k}`;
  return {
    async get(store, k) {
      const v = map.get(key(store, k));
      return v === undefined ? null : structuredClone(v);
    },
    async set(store, k, value) {
      map.set(key(store, k), structuredClone(value));
      return true;
    },
    async delete(store, k) {
      return map.delete(key(store, k));
    },
    async clear(store) {
      for (const k of [...map.keys()]) {
        if (k.startsWith(`${store}\u001f`)) map.delete(k);
      }
      return true;
    },
    size: () => map.size
  };
};

const isoDate = (dayOffset) => new Date(Date.UTC(2020, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

/** 合成净值序列：确定性、带一点波动 */
const buildRows = (days, seed = 1) => {
  let s = seed;
  let nav = 1;
  const rows = [];
  for (let i = 0; i < days; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const ret = ((s / 2147483648 - 0.5) * 0.02) / 1;
    nav *= 1 + ret;
    rows.push({ date: isoDate(i), unitNetValue: nav, accumulatedNetValue: nav, equityReturn: ret * 100 });
  }
  return rows;
};

/** 记录调用次数的假取数函数 */
const makeFetchHistory = (rows, { fail = false } = {}) => {
  const calls = [];
  const fn = async (code) => {
    calls.push(code);
    if (fail) throw new Error('净值源不可达');
    return rows;
  };
  fn.calls = calls;
  return fn;
};

// ── IndexedDB 降级 ────────────────────────────────────────────────────────

describe('IndexedDB 不可用时的降级', () => {
  it('Node 环境下识别为不支持', () => {
    assert.equal(isIndexedDbSupported(), false);
  });

  it('openFundVolatilityDb 返回 null 而不是抛异常', async () => {
    assert.equal(await openFundVolatilityDb(), null);
  });

  it('读写删清全部安全降级，不抛异常', async () => {
    assert.equal(await idbGet(IDB_STORES.NAV, '110022'), null);
    assert.equal(await idbSet(IDB_STORES.NAV, '110022', { rows: [] }), false);
    assert.equal(await idbDelete(IDB_STORES.NAV, '110022'), false);
    assert.equal(await idbClearStore(IDB_STORES.NAV), false);
    assert.equal(await idbClearAll(), false);
  });

  it('未知仓库名不落到真实 IndexedDB 逻辑上', async () => {
    assert.equal(await idbGet('notAStore', '110022'), null);
    assert.equal(await idbSet('notAStore', '110022', {}), false);
  });
});

// ── 缓存读写 ──────────────────────────────────────────────────────────────

describe('createFundVolatilityCache - 净值', () => {
  it('写入后可读出，asOfDate 取最后一行日期', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const rows = buildRows(50);
    assert.equal(await cache.writeNav('110022', rows), true);

    const hit = await cache.readNav('110022');
    assert.equal(hit.rows.length, 50);
    assert.equal(hit.asOfDate, rows[49].date);
  });

  it('未写入时返回 null', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    assert.equal(await cache.readNav('999999'), null);
  });

  it('写入时裁剪到保留窗口', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    assert.equal(await cache.writeNav('110022', buildRows(NAV_RETENTION_DAYS + 120)), true);
    const hit = await cache.readNav('110022');
    assert.equal(hit.rows.length, NAV_RETENTION_DAYS);
  });

  it('空序列不写入', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    assert.equal(await cache.writeNav('110022', []), false);
    assert.equal(await cache.readNav('110022'), null);
  });

  it('版本号不符 → 视为未命中并删除旧记录', async () => {
    const adapter = createMemoryAdapter();
    const cache = createFundVolatilityCache(adapter);
    await adapter.set(IDB_STORES.NAV, '110022', { _v: 999, ts: Date.now(), data: { rows: buildRows(10) } });

    assert.equal(await cache.readNav('110022'), null);
    assert.equal(await adapter.get(IDB_STORES.NAV, '110022'), null);
  });

  it('回归护栏：收益率/回撤口径变更后必须靠版本号淘汰旧缓存', async () => {
    // 旧版本（v1）存的是「累计净值环比」算出来的 dailyReturn，是错的。
    // normalizeNavSeries 会原样保留已声明的 dailyReturn，所以不升版本就会继续复用错误数据。
    const adapter = createMemoryAdapter();
    const cache = createFundVolatilityCache(adapter);
    assert.ok(NAV_CACHE_VERSION > 1, '口径变更后 NAV_CACHE_VERSION 必须已升版');

    await adapter.set(IDB_STORES.NAV, '110022', {
      _v: NAV_CACHE_VERSION - 1,
      ts: Date.now(),
      data: { rows: buildRows(10) }
    });

    assert.equal(await cache.readNav('110022'), null);
    assert.equal(await adapter.get(IDB_STORES.NAV, '110022'), null, '旧版本记录应被删除');
  });

  it('结构非法（data 不是对象）→ 视为未命中', async () => {
    const adapter = createMemoryAdapter();
    const cache = createFundVolatilityCache(adapter);
    await adapter.set(IDB_STORES.NAV, '110022', { _v: NAV_CACHE_VERSION, ts: Date.now(), data: 'nope' });
    assert.equal(await cache.readNav('110022'), null);
  });

  it('非法的 rows 字段 → 视为未命中', async () => {
    const adapter = createMemoryAdapter();
    const cache = createFundVolatilityCache(adapter);
    await adapter.set(IDB_STORES.NAV, '110022', { _v: NAV_CACHE_VERSION, ts: Date.now(), data: { rows: 'nope' } });
    assert.equal(await cache.readNav('110022'), null);
  });
});

describe('createFundVolatilityCache - 指标 / 信号指纹', () => {
  const metricsOf = (rows) => ({ asOfDate: rows[rows.length - 1].date, navCount: rows.length, vol20: 12.3 });

  it('指纹一致 → 命中指标缓存', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const metrics = metricsOf(buildRows(80));
    await cache.writeMetrics('110022', metrics);

    const hit = await cache.readMetrics('110022', { asOfDate: metrics.asOfDate, navCount: metrics.navCount });
    assert.ok(hit);
    assert.equal(hit.metrics.vol20, 12.3);
  });

  it('asOfDate 变了 → 指标缓存失效', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const metrics = metricsOf(buildRows(80));
    await cache.writeMetrics('110022', metrics);
    assert.equal(await cache.readMetrics('110022', { asOfDate: '2099-01-01', navCount: metrics.navCount }), null);
  });

  it('navCount 变了 → 指标缓存失效（补了新交易日但日期未变也不能复用）', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const metrics = metricsOf(buildRows(80));
    await cache.writeMetrics('110022', metrics);
    assert.equal(await cache.readMetrics('110022', { asOfDate: metrics.asOfDate, navCount: 81 }), null);
  });

  it('缺指纹 → 返回 null', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    await cache.writeMetrics('110022', metricsOf(buildRows(80)));
    assert.equal(await cache.readMetrics('110022', null), null);
  });

  it('信号缓存同样按指纹校验，且缺 state 视为非法', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const rows = buildRows(80);
    const fingerprint = { asOfDate: rows[79].date, navCount: 80 };

    await cache.writeSignal('110022', {
      ...fingerprint,
      state: '高波动',
      stateLevel: 'warn',
      signals: [],
      primarySignals: [],
      riskScore: 70
    });
    const hit = await cache.readSignal('110022', fingerprint);
    assert.equal(hit.state, '高波动');
    assert.equal(hit.riskScore, 70);

    const adapter = createMemoryAdapter();
    const cache2 = createFundVolatilityCache(adapter);
    await adapter.set(IDB_STORES.SIGNAL, '110022', {
      _v: SIGNAL_CACHE_VERSION,
      ts: Date.now(),
      data: { ...fingerprint }
    });
    assert.equal(await cache2.readSignal('110022', fingerprint), null);
  });
});

describe('createFundVolatilityCache - 基本信息 / 清理', () => {
  it('基本信息读写', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    await cache.writeBasic('110022', { code: '110022', name: '易方达消费行业' });
    const hit = await cache.readBasic('110022');
    assert.equal(hit.data.name, '易方达消费行业');
  });

  it('clearFund 清掉四个仓库', async () => {
    const adapter = createMemoryAdapter();
    const cache = createFundVolatilityCache(adapter);
    const rows = buildRows(60);
    const fingerprint = { asOfDate: rows[59].date, navCount: 60 };

    await cache.writeBasic('110022', { code: '110022' });
    await cache.writeNav('110022', rows);
    await cache.writeMetrics('110022', { ...fingerprint, vol20: 1 });
    await cache.writeSignal('110022', { ...fingerprint, state: '正常' });
    assert.equal(adapter.size(), 4);

    assert.equal(await cache.clearFund('110022'), true);
    assert.equal(adapter.size(), 0);
    assert.equal(await cache.readNav('110022'), null);
  });

  it('clearFund 不影响其它基金', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    await cache.writeNav('110022', buildRows(30));
    await cache.writeNav('161725', buildRows(30));
    await cache.clearFund('110022');
    assert.equal(await cache.readNav('110022'), null);
    assert.ok(await cache.readNav('161725'));
  });

  it('空代码不产生读写', async () => {
    const adapter = createMemoryAdapter();
    const cache = createFundVolatilityCache(adapter);
    assert.equal(await cache.writeNav('  ', buildRows(10)), false);
    assert.equal(await cache.readNav(''), null);
    assert.equal(adapter.size(), 0);
  });
});

describe('isNavCacheStale', () => {
  const entry = (ts, rows = [{ date: '2024-01-01', unitNav: 1 }]) => ({ ts, rows });

  it('新鲜期内不算过期', () => {
    assert.equal(isNavCacheStale(entry(1000), 1000 + NAV_CACHE_TTL_MS - 1), false);
  });

  it('达到新鲜期即过期', () => {
    assert.equal(isNavCacheStale(entry(1000), 1000 + NAV_CACHE_TTL_MS), true);
  });

  it('null / 无 ts / 空序列一律视为过期', () => {
    assert.equal(isNavCacheStale(null, Date.now()), true);
    assert.equal(isNavCacheStale({ rows: [{}] }, Date.now()), true);
    assert.equal(isNavCacheStale(entry(1000, []), 1000), true);
  });

  it('可覆盖新鲜期', () => {
    assert.equal(isNavCacheStale(entry(1000), 2000, 500), true);
  });
});

// ── 取数编排 ──────────────────────────────────────────────────────────────

describe('loadFundVolatility', () => {
  it('首次调用：走网络取数并回写缓存', async () => {
    const adapter = createMemoryAdapter();
    const cache = createFundVolatilityCache(adapter);
    const fetchHistory = makeFetchHistory(buildRows(300));

    const result = await loadFundVolatility('110022', {
      fetchHistory,
      cache,
      basic: { code: '110022', name: '测试基金' }
    });

    assert.equal(result.code, '110022');
    assert.equal(result.navCount, 300);
    assert.deepEqual(result.sources, { nav: 'network', metrics: 'computed', signal: 'computed' });
    assert.ok(Number.isFinite(result.metrics.vol20));
    assert.ok(result.metrics.vol20Percentile >= 0);
    assert.equal(result.basic.name, '测试基金');
    assert.equal(fetchHistory.calls.length, 1);

    // 四类缓存都已落盘
    assert.equal(adapter.size(), 4);
    assert.ok(await cache.readNav('110022'));
    assert.ok(await cache.readBasic('110022'));
  });

  it('二次调用命中缓存，不再发起请求', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const fetchHistory = makeFetchHistory(buildRows(300));

    const first = await loadFundVolatility('110022', { fetchHistory, cache });
    const second = await loadFundVolatility('110022', { fetchHistory, cache });

    assert.equal(fetchHistory.calls.length, 1);
    assert.deepEqual(second.sources, { nav: 'cache', metrics: 'cache', signal: 'cache' });
    assert.deepEqual(second.metrics, first.metrics);
    assert.equal(second.state, first.state);
    assert.equal(second.riskScore, first.riskScore);
    assert.deepEqual(second.primarySignals, first.primarySignals);
  });

  it('基本信息可跨次读回（第二次不传 basic 也能拿到）', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const fetchHistory = makeFetchHistory(buildRows(120));

    await loadFundVolatility('110022', { fetchHistory, cache, basic: { code: '110022', name: '测试基金' } });
    const second = await loadFundVolatility('110022', { fetchHistory, cache });
    assert.equal(second.basic.name, '测试基金');
  });

  it('forceRefresh 重取净值但仍复用指标/信号（指纹未变）', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const fetchHistory = makeFetchHistory(buildRows(200));

    await loadFundVolatility('110022', { fetchHistory, cache });
    const refreshed = await loadFundVolatility('110022', { fetchHistory, cache, forceRefresh: true });

    assert.equal(fetchHistory.calls.length, 2);
    assert.deepEqual(refreshed.sources, { nav: 'network', metrics: 'cache', signal: 'cache' });
  });

  it('净值补了新交易日 → 指纹变化 → 指标与信号重算', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const rows = buildRows(200);
    const fetchHistory = makeFetchHistory(rows);

    await loadFundVolatility('110022', { fetchHistory, cache });

    // 第二天多了一行净值
    const grown = [...rows, { date: isoDate(200), unitNetValue: 1.02, accumulatedNetValue: 1.02, equityReturn: 0.5 }];
    const fetchHistory2 = makeFetchHistory(grown);
    const next = await loadFundVolatility('110022', { fetchHistory: fetchHistory2, cache, forceRefresh: true });

    assert.equal(next.navCount, 201);
    assert.deepEqual(next.sources, { nav: 'network', metrics: 'computed', signal: 'computed' });
  });

  it('合并补最新：本地缓存与远端取并集，历史行不丢', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const rows = buildRows(200);

    // 第一次只有前 150 行
    await loadFundVolatility('110022', { fetchHistory: makeFetchHistory(rows.slice(0, 150)), cache });
    // 第二次远端给全量 200 行
    const next = await loadFundVolatility('110022', {
      fetchHistory: makeFetchHistory(rows),
      cache,
      forceRefresh: true
    });

    assert.equal(next.navCount, 200);
    const cached = await cache.readNav('110022');
    assert.equal(cached.rows.length, 200);
    assert.equal(cached.asOfDate, rows[199].date);
  });

  it('取数失败但本地有历史 → 用缓存出结果并带 error，不空白', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    await loadFundVolatility('110022', { fetchHistory: makeFetchHistory(buildRows(200)), cache });

    const result = await loadFundVolatility('110022', {
      fetchHistory: makeFetchHistory(null, { fail: true }),
      cache,
      forceRefresh: true
    });

    assert.equal(result.error, '净值源不可达');
    assert.equal(result.sources.nav, 'cache');
    assert.equal(result.state !== VOLATILITY_STATES.INSUFFICIENT, true);
    assert.equal(result.navCount, 200);
  });

  it('取数失败且无缓存 → 数据不足', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const result = await loadFundVolatility('110022', {
      fetchHistory: makeFetchHistory(null, { fail: true }),
      cache,
      forceRefresh: true
    });

    assert.equal(result.state, VOLATILITY_STATES.INSUFFICIENT);
    assert.equal(result.error, '净值源不可达');
    assert.equal(result.riskScore, null);
    assert.deepEqual(result.signals, []);
  });

  it('取数成功但返回空 → 数据不足', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const result = await loadFundVolatility('110022', { fetchHistory: makeFetchHistory([]), cache });
    assert.equal(result.state, VOLATILITY_STATES.INSUFFICIENT);
    assert.equal(result.navCount, 0);
  });

  it('未提供 fetchHistory → 数据不足并给出原因', async () => {
    const result = await loadFundVolatility('110022', { cache: createFundVolatilityCache(createMemoryAdapter()) });
    assert.equal(result.state, VOLATILITY_STATES.INSUFFICIENT);
    assert.match(result.error, /未提供历史净值取数函数/);
  });

  it('空基金代码 → 数据不足', async () => {
    const result = await loadFundVolatility('  ', { fetchHistory: makeFetchHistory(buildRows(50)) });
    assert.equal(result.state, VOLATILITY_STATES.INSUFFICIENT);
    assert.match(result.error, /缺少基金代码/);
  });

  it('支持取数函数返回 { rows } 包装结构', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const rows = buildRows(300);
    const result = await loadFundVolatility('110022', { fetchHistory: async () => ({ rows }), cache });
    assert.equal(result.navCount, 300);
    assert.ok(Number.isFinite(result.metrics.vol20));
  });

  it('缓存新鲜期可由 ttl 覆盖', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const fetchHistory = makeFetchHistory(buildRows(200));

    await loadFundVolatility('110022', { fetchHistory, cache });
    // ttl=0 等价于「一律视为过期」
    const result = await loadFundVolatility('110022', { fetchHistory, cache, ttl: 0 });
    assert.equal(fetchHistory.calls.length, 2);
    assert.equal(result.sources.nav, 'network');
  });

  it('状态与信号自洽：stateLevel 与 state 对应', async () => {
    const cache = createFundVolatilityCache(createMemoryAdapter());
    const result = await loadFundVolatility('110022', { fetchHistory: makeFetchHistory(buildRows(400)), cache });
    const allowed = {
      正常: 'normal',
      波动扩大: 'warn',
      回撤加深: 'warn',
      高波动: 'warn',
      极端波动: 'danger',
      '高波动 + 较大回撤': 'danger',
      数据不足: 'muted'
    };
    assert.equal(result.stateLevel, allowed[result.state]);
  });

  it('回归护栏：取数静默返回空数组时，来源必须标成 cache 并给出提示', async () => {
    // fetchFundHistory 内部是 try/catch → 网络失败时返回 []，不会抛。
    // 若服务层只看「没抛异常」就标成 network，用户点刷新后会以为已经拿到最新净值。
    const cache = createFundVolatilityCache(createMemoryAdapter());
    await loadFundVolatility('110022', { fetchHistory: makeFetchHistory(buildRows(200)), cache });

    const result = await loadFundVolatility('110022', {
      fetchHistory: makeFetchHistory([]),
      cache,
      forceRefresh: true
    });

    assert.equal(result.sources.nav, 'cache');
    assert.equal(result.sources.metrics, 'cache');
    assert.match(result.error, /未取到新净值/);
    assert.equal(result.navCount, 200);
  });

  it('回归护栏：写缓存失败不得被记成「净值取数失败」', async () => {
    // 取数成功、只是落盘失败：结果必须与取数成功完全一致（sources.nav=network、无 error）
    const adapter = createMemoryAdapter();
    const brokenAdapter = {
      ...adapter,
      set: async () => {
        throw new Error('QuotaExceededError');
      }
    };
    const cache = createFundVolatilityCache(brokenAdapter);

    const result = await loadFundVolatility('110022', { fetchHistory: makeFetchHistory(buildRows(200)), cache });

    assert.equal(result.error, null);
    assert.equal(result.sources.nav, 'network');
    assert.equal(result.sources.metrics, 'computed');
    assert.equal(result.navCount, 200);
    assert.ok(Number.isFinite(result.metrics.vol20));
  });
});
