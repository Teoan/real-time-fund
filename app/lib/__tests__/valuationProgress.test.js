/**
 * 估值加载进度（store + 键约定）单元测试
 *
 * 覆盖：
 *   - 进度键：评分与区间走势分开，避免并行时互相覆盖
 *   - store：写入/读取、百分比单调不减、0-100 夹紧、按需清空、条目上限淘汰
 *
 * 运行：node --test app/lib/__tests__/valuationProgress.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { scoreProgressKey, historyProgressKey } from '../valuationProgressKeys.js';
import { useValuationProgressStore } from '../../stores/valuationProgressStore.js';

const reset = () => useValuationProgressStore.setState({ progress: {} });
const get = (key) => useValuationProgressStore.getState().progress[key];
const set = (key, patch) => useValuationProgressStore.getState().setProgress(key, patch);
const clear = (key) => useValuationProgressStore.getState().clearProgress(key);

describe('进度键约定', () => {
  it('评分键就是基金代码', () => {
    assert.equal(scoreProgressKey('017436'), '017436');
    assert.equal(scoreProgressKey(' 110022 '), '110022');
  });

  it('区间走势键带 #history 后缀，且区分区间', () => {
    assert.equal(historyProgressKey('110022', '3m'), '110022#history:3m');
    assert.notEqual(historyProgressKey('110022', '1m'), historyProgressKey('110022', '3m'));
  });

  it('评分键与区间键互不相同（并行时不会互相覆盖）', () => {
    assert.notEqual(scoreProgressKey('110022'), historyProgressKey('110022', '3m'));
  });

  it('空输入不抛错', () => {
    assert.equal(scoreProgressKey(null), '');
    assert.equal(historyProgressKey(undefined, undefined), '#history:');
  });
});

describe('valuationProgressStore', () => {
  beforeEach(reset);

  it('写入后可读取', () => {
    set('110022', { percent: 42, label: '拉取持仓个股估值（3/7）', done: 3, total: 7 });
    const p = get('110022');
    assert.equal(p.percent, 42);
    assert.equal(p.label, '拉取持仓个股估值（3/7）');
    assert.equal(p.done, 3);
    assert.equal(p.total, 7);
  });

  it('局部更新保留其余字段', () => {
    set('110022', { percent: 10, label: 'A', phase: 'classify' });
    set('110022', { percent: 20 });
    const p = get('110022');
    assert.equal(p.percent, 20);
    assert.equal(p.label, 'A');
    assert.equal(p.phase, 'classify');
  });

  it('百分比单调不减（防止阶段切换时进度条回退）', () => {
    set('110022', { percent: 60 });
    set('110022', { percent: 30 });
    assert.equal(get('110022').percent, 60);
  });

  it('百分比夹紧到 0-100', () => {
    set('a', { percent: 180 });
    assert.equal(get('a').percent, 100);
    set('b', { percent: -20 });
    assert.equal(get('b').percent, 0);
  });

  it('未提供 percent 时不改动既有百分比', () => {
    set('110022', { percent: 55, label: 'A' });
    set('110022', { label: 'B' });
    assert.equal(get('110022').percent, 55);
    assert.equal(get('110022').label, 'B');
  });

  it('percent 显式置 null → 退化为不定量（不参与单调夹紧）', () => {
    set('110022', { percent: 80 });
    set('110022', { percent: null, label: '重算中' });
    assert.equal(get('110022').percent, null);
    // 之后仍可给出确定进度
    set('110022', { percent: 5 });
    assert.equal(get('110022').percent, 5);
  });

  it('不同键互不影响', () => {
    set(scoreProgressKey('110022'), { percent: 30 });
    set(historyProgressKey('110022', '3m'), { percent: 70 });
    assert.equal(get(scoreProgressKey('110022')).percent, 30);
    assert.equal(get(historyProgressKey('110022', '3m')).percent, 70);
  });

  it('clearProgress 清空指定键，其余保留', () => {
    set('a', { percent: 10 });
    set('b', { percent: 20 });
    clear('a');
    assert.equal(get('a'), undefined);
    assert.equal(get('b').percent, 20);
  });

  it('空键 / 空 patch 不写入', () => {
    set('', { percent: 10 });
    set('   ', { percent: 10 });
    set('c', null);
    assert.deepEqual(useValuationProgressStore.getState().progress, {});
  });

  it('条目数有上限（避免长期运行后无界增长）', () => {
    for (let i = 0; i < 120; i++) set(`fund-${i}`, { percent: i % 100 });
    const keys = Object.keys(useValuationProgressStore.getState().progress);
    assert.ok(keys.length <= 80, `实际 ${keys.length}`);
    // 最新的仍在
    assert.ok(keys.includes('fund-119'));
  });
});
