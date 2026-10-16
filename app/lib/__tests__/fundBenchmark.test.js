/**
 * 业绩基准选择表单元测试
 *
 * 覆盖：
 *   - 默认基准（沪深300）
 *   - 美股 / 港股规则的命中与**刻意排除**（标普中国A股、道琼斯88）
 *   - 债券 / 货币型返回 null（无合适基准，信息比率/Alpha/Beta 不展示）
 *   - 返回值是副本，改动不会污染模块常量
 *
 * 运行：node --test app/lib/__tests__/fundBenchmark.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_BENCHMARK, resolveFundBenchmark } from '../fundBenchmark.js';

describe('resolveFundBenchmark', () => {
  it('默认走沪深300（A 股主动权益 / 指数基金）', () => {
    const bench = resolveFundBenchmark({ name: '易方达消费行业股票' });
    assert.deepEqual(bench, { secid: '1.000300', name: '沪深300' });
    assert.deepEqual(DEFAULT_BENCHMARK, { secid: '1.000300', name: '沪深300' });
  });

  it('美股 / 标普 / 纳指 → 标普500 或纳斯达克100，滞后均为 1 个交易日', () => {
    const expected = {
      博时标普500ETF联接A: { secid: '100.SPX', name: '标普500' },
      广发纳斯达克100指数A: { secid: '100.NDX', name: '纳斯达克100' },
      华夏美国股票QDII: { secid: '100.SPX', name: '标普500' },
      某某美股科技基金: { secid: '100.SPX', name: '标普500' }
    };
    for (const [name, bench] of Object.entries(expected)) {
      assert.deepEqual(resolveFundBenchmark({ name }), bench, name);
    }
  });

  it('回归护栏：银华-道琼斯88 走默认基准（道琼斯中国88 是 A 股指数）', () => {
    assert.equal(resolveFundBenchmark({ name: '银华-道琼斯88精选' }).name, '沪深300');
  });

  it('回归护栏：名字带「标普」但不是标普500 的不算美股', () => {
    for (const name of ['标普中国A股红利机会指数', '标普中国A股大盘红利低波指数']) {
      assert.equal(resolveFundBenchmark({ name }).name, '沪深300', name);
    }
    // 「标普港股通低波红利」虽然也带标普，但投的是港股通标的 → 港股规则（恒生指数）更贴切，
    // 这里固化该行为：地域规则优先于「标普」这个指数品牌前缀。
    assert.equal(resolveFundBenchmark({ name: '标普港股通低波红利指数' }).name, '恒生指数');
  });

  it('港股 / 恒生 → 恒生指数，滞后 0（与 A 股同一交易时段）', () => {
    for (const name of ['华夏恒生ETF联接A', '某港股通精选混合', 'H股ETF联接', '香港中小盘基金']) {
      assert.deepEqual(resolveFundBenchmark({ name }), { secid: '100.HSI', name: '恒生指数' });
    }
  });

  it('债券 / 货币型 → null（无可用基准，不拿沪深300 硬算 Beta）', () => {
    for (const name of [
      '某某纯债债券A',
      '招商产业债券',
      '中短债信用债基金',
      '某某利率债指数',
      '某某国债ETF联接',
      '某某货币A'
    ]) {
      assert.equal(resolveFundBenchmark({ name }), null, name);
    }
  });

  it('债优先于地域：美国债券(QDII) 仍然没有股票基准', () => {
    assert.equal(resolveFundBenchmark({ name: '某某美国债券(QDII)' }), null);
    assert.equal(resolveFundBenchmark({ name: '某某香港债券基金' }), null);
  });

  it('缺名称 / 非法输入 → 默认基准（不抛异常）', () => {
    assert.deepEqual(resolveFundBenchmark({}), DEFAULT_BENCHMARK);
    assert.deepEqual(resolveFundBenchmark(null), DEFAULT_BENCHMARK);
    assert.deepEqual(resolveFundBenchmark(), DEFAULT_BENCHMARK);
    assert.deepEqual(resolveFundBenchmark({ name: '   ' }), DEFAULT_BENCHMARK);
    assert.deepEqual(resolveFundBenchmark({ name: 123 }), DEFAULT_BENCHMARK);
  });

  it('返回的是副本：调用方改动不会污染默认基准常量', () => {
    const bench = resolveFundBenchmark({ name: '普通混合基金' });
    bench.secid = 'mutated';
    assert.equal(DEFAULT_BENCHMARK.secid, '1.000300');
    assert.equal(resolveFundBenchmark({ name: '普通混合基金' }).secid, '1.000300');
  });
});
