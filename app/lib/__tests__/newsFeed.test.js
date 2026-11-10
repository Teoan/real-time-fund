/**
 * 市场快讯纯逻辑单测（app/lib/newsFeed.js）
 *
 * 重点守两件容易悄悄坏掉的事：
 *   1. 跨源去重 —— 同一条通稿会同时出现在新浪/同花顺/富途，重复展示会让人以为刷屏；
 *   2. 时间排序 —— publishedAt 为 null 的条目（财新没有时间字段）必须沉底且不打乱原顺序。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeMarketFlash,
  filterBySource,
  normalizeNewsText,
  sortByPublishedDesc,
  formatNewsTime,
  formatRelativeTime,
  formatClock,
  shouldCollapseText,
  splitTitleAndBody,
  resolveFlashSources,
  formatTimeOfDay,
  formatDayLabel,
  groupFlashByDate,
  parseNewsTimestamp
} from '../newsFeed.js';

/** 构造一条归一化条目（字段与 aktools-mappers 的 buildNewsItem 对齐） */
const item = (over = {}) => ({
  id: over.id || `${over.source || 'cls'}:x`,
  source: over.source || 'cls',
  sourceLabel: over.sourceLabel || '财联社',
  title: over.title ?? null,
  content: over.content ?? null,
  summary: over.summary ?? null,
  tag: null,
  url: null,
  publishedAt: over.publishedAt ?? null,
  important: over.important ?? false
});

describe('newsFeed - normalizeNewsText', () => {
  it('去掉方括号、标点与空白后转小写', () => {
    assert.equal(normalizeNewsText('【央行】降准 0.5%，市场沸腾！'), normalizeNewsText('央行降准05市场沸腾'));
  });

  it('非字符串一律返回空串', () => {
    assert.equal(normalizeNewsText(null), '');
    assert.equal(normalizeNewsText(undefined), '');
    assert.equal(normalizeNewsText(123), '');
  });

  it('小数尾零被抹平（0.70 与 0.7 视为同一文本）', () => {
    assert.equal(normalizeNewsText('恒生科技指数涨0.70%'), normalizeNewsText('恒生科技指数涨0.7%'));
    assert.equal(normalizeNewsText('涨1.230%'), normalizeNewsText('涨1.23%'));
  });
});

describe('newsFeed - mergeMarketFlash', () => {
  it('跨源同一条通稿只保留首次出现的那条（≈源优先级）', () => {
    const same = 'Canalys：2023年Q4英特尔CPU出货5000万颗占比78%';
    const merged = mergeMarketFlash([
      item({ source: 'cls', title: same, publishedAt: '2026-11-10T14:00:00' }),
      item({ source: 'sina', title: `【${same}】`, publishedAt: '2026-11-10T14:00:10' }),
      item({ source: 'ths', title: same, publishedAt: '2026-11-10T14:00:20' })
    ]);
    assert.equal(merged.items.length, 1);
    assert.equal(merged.items[0].source, 'cls');
    assert.equal(merged.removed, 2);
  });

  it('标题只差小数尾零/标点时也算重复（真实「港股午评」案例）', () => {
    const merged = mergeMarketFlash([
      item({ source: 'cls', title: '港股午评：恒生指数涨0.29% 恒生科技指数涨0.7%' }),
      item({ source: 'sina', title: '港股午评：恒生指数涨0.29%，恒生科技指数涨0.70%' })
    ]);
    assert.equal(merged.items.length, 1);
    assert.equal(merged.items[0].source, 'cls');
  });

  it('转载加了「财联社X月X日电，」前缀也能识别为同一条', () => {
    const merged = mergeMarketFlash([
      item({ source: 'cls', title: '财联社11月10日电，日本半导体企业Rapidus据称难以按期实现量产。' }),
      item({ source: 'sina', title: '日本半导体企业Rapidus据称难以按期实现量产。' })
    ]);
    assert.equal(merged.items.length, 1);
    assert.equal(merged.items[0].source, 'cls');
  });

  it('转载加了「提前22天！」前缀也能识别为同一条', () => {
    const merged = mergeMarketFlash([
      item({ source: 'cls', title: '宁波舟山港年集装箱吞吐量再破4000万箱' }),
      item({ source: 'sina', title: '提前22天！宁波舟山港年集装箱吞吐量再破4000万箱' })
    ]);
    assert.equal(merged.items.length, 1);
  });

  it('过短的包含关系不合并（防误杀）', () => {
    const merged = mergeMarketFlash([
      item({ source: 'cls', title: '欧股高开' }),
      item({ source: 'sina', title: '欧股高开，德国DAX指数涨1.2%，法国CAC40指数涨0.8%' })
    ]);
    assert.equal(merged.items.length, 2);
  });

  it('不同标题不会被误合并', () => {
    const merged = mergeMarketFlash([
      item({ title: '央行宣布降准 0.5 个百分点', publishedAt: '2026-11-10T10:00:00' }),
      item({ title: '央行宣布下调逆回购利率 10bp', publishedAt: '2026-11-10T10:00:00' })
    ]);
    assert.equal(merged.items.length, 2);
    assert.equal(merged.removed, 0);
  });

  it('按发布时间倒序，null 时间沉底且保持原顺序', () => {
    const merged = mergeMarketFlash([
      item({ id: 'a', title: 'A 早', publishedAt: '2026-11-10T09:00:00' }),
      item({ id: 'b', title: 'B 晚', publishedAt: '2026-11-10T15:00:00' }),
      item({ id: 'c', title: 'C 无时间', publishedAt: null }),
      item({ id: 'd', title: 'D 无时间', publishedAt: null })
    ]);
    assert.deepEqual(
      merged.items.map((i) => i.id),
      ['b', 'a', 'c', 'd']
    );
  });

  it('超过上限时截断', () => {
    const many = Array.from({ length: 10 }, (_, i) => item({ id: `n${i}`, title: `标题${i}` }));
    const merged = mergeMarketFlash(many, { limit: 4 });
    assert.equal(merged.items.length, 4);
    assert.equal(merged.total, 4);
  });

  it('空输入与非法条目安全返回', () => {
    assert.deepEqual(mergeMarketFlash([]), { items: [], removed: 0, total: 0 });
    assert.deepEqual(mergeMarketFlash(null), { items: [], removed: 0, total: 0 });
    const merged = mergeMarketFlash([null, { title: '缺 source' }, item({ title: '正常' })]);
    assert.equal(merged.items.length, 1);
  });
});

describe('newsFeed - sortByPublishedDesc / filterBySource', () => {
  it('排序不修改原数组', () => {
    const input = [
      item({ id: 'a', publishedAt: '2026-11-10T09:00:00' }),
      item({ id: 'b', publishedAt: '2026-11-10T11:00:00' })
    ];
    const snapshot = input.map((i) => i.id);
    sortByPublishedDesc(input);
    assert.deepEqual(
      input.map((i) => i.id),
      snapshot
    );
  });

  it('filterBySource：all / null 不过滤，具体 id 精确匹配', () => {
    const items = [item({ source: 'cls' }), item({ source: 'em' })];
    assert.equal(filterBySource(items, 'all').length, 2);
    assert.equal(filterBySource(items, null).length, 2);
    assert.equal(filterBySource(items, 'em').length, 1);
    assert.equal(filterBySource(items, 'nope').length, 0);
  });
});

describe('newsFeed - 时间格式化', () => {
  const now = new Date(2026, 10, 10, 15, 30, 0).getTime();

  it('当天只显示 HH:mm', () => {
    assert.equal(formatNewsTime('2026-11-10T14:05:03', now), '14:05');
  });

  it('跨天补 MM-DD', () => {
    assert.equal(formatNewsTime('2026-11-09T14:05:03', now), '11-09 14:05');
  });

  it('非法/缺失时间返回占位符', () => {
    assert.equal(formatNewsTime(null, now), '—');
    assert.equal(formatNewsTime('not-a-date', now), '—');
  });

  it('相对时间分档', () => {
    assert.equal(formatRelativeTime('2026-11-10T15:29:40', now), '刚刚');
    assert.equal(formatRelativeTime('2026-11-10T15:25:00', now), '5 分钟前');
    assert.equal(formatRelativeTime('2026-11-10T12:30:00', now), '3 小时前');
    assert.equal(formatRelativeTime('2026-11-08T15:30:00', now), '2 天前');
  });

  it('未来时间按「刚刚」处理（上游抓取时间可能略超前于本地时钟）', () => {
    assert.equal(formatRelativeTime('2026-11-10T15:35:00', now), '刚刚');
  });

  it('parseNewsTimestamp 对无时区本地时间串按本地解析', () => {
    assert.equal(parseNewsTimestamp('2026-11-10T14:05:03'), new Date(2026, 10, 10, 14, 5, 3).getTime());
    assert.equal(parseNewsTimestamp(''), null);
  });

  it('formatClock 输出 HH:mm:ss', () => {
    assert.equal(formatClock(now), '15:30:00');
  });
});

describe('newsFeed - shouldCollapseText', () => {
  it('超过阈值才折叠', () => {
    assert.equal(shouldCollapseText('短'), false);
    assert.equal(shouldCollapseText('长'.repeat(200)), true);
    assert.equal(shouldCollapseText(null), false);
  });
});

describe('newsFeed - splitTitleAndBody（标题与正文去重）', () => {
  it('新浪形态：【标题】正文 → 剥掉【标题】与电头', () => {
    const out = splitTitleAndBody({
      title: '所罗门群岛附近海域发生5.5级地震',
      content: '【所罗门群岛附近海域发生5.5级地震】财联社11月10日电，据测定…'
    });
    assert.equal(out.title, '所罗门群岛附近海域发生5.5级地震');
    assert.equal(out.body, '据测定…');
  });

  it('标题即全文（东财）→ 正文为空，不重复渲染', () => {
    const out = splitTitleAndBody({ title: '【11月10日午间新闻精选】1、截至午间收盘…', content: '' });
    assert.equal(out.title, '【11月10日午间新闻精选】1、截至午间收盘…');
    assert.equal(out.body, '');
  });

  it('截断标题带省略号：整条只展示完整正文，不展示截断标题', () => {
    const out = splitTitleAndBody({
      title: 'SUSQUEHANNA 将 超微电脑公司 目标价从 15 美元上调至 18 美元…',
      content: 'SUSQUEHANNA 将 超微电脑公司 目标价从 15 美元上调至 18 美元。'
    });
    assert.equal(out.title, '');
    assert.equal(out.body, 'SUSQUEHANNA 将 超微电脑公司 目标价从 15 美元上调至 18 美元。');
  });

  it('标题与正文无关时两者都保留', () => {
    const out = splitTitleAndBody({ title: '欧股多数高开', content: '欧洲主要股指开盘上涨。' });
    assert.equal(out.body, '欧洲主要股指开盘上涨。');
  });

  it('无标题时正文原样返回', () => {
    assert.deepEqual(splitTitleAndBody({ content: '只有正文' }), { title: '', body: '只有正文' });
  });
});

describe('newsFeed - resolveFlashSources（来源筛选）', () => {
  const ALL = ['cls', 'em', 'ths', 'sina', 'futu'];

  it("'all' / 空值 → 全部源", () => {
    assert.deepEqual(resolveFlashSources('all', ALL), ALL);
    assert.deepEqual(resolveFlashSources(null, ALL), ALL);
    assert.deepEqual(resolveFlashSources(undefined, ALL), ALL);
  });

  it('单个源 id（字符串）→ 只取该源（曾因把它当“非数组”回落成全量而导致筛选失效）', () => {
    assert.deepEqual(resolveFlashSources('em', ALL), ['em']);
    assert.deepEqual(resolveFlashSources('cls', ALL), ['cls']);
    assert.deepEqual(resolveFlashSources(' sina ', ALL), ['sina']);
  });

  it('数组 → 按 allowed 顺序输出（保证与「全部」视图同一去重优先级）', () => {
    assert.deepEqual(resolveFlashSources(['sina', 'em'], ALL), ['em', 'sina']);
    assert.deepEqual(resolveFlashSources(['futu', 'cls', 'ths'], ALL), ['cls', 'ths', 'futu']);
  });

  it('非法 id 被丢弃，混入合法项时仍生效', () => {
    assert.deepEqual(resolveFlashSources(['em', 'bogus'], ALL), ['em']);
  });

  it('全部非法 / 空数组 → 回落全部源，避免白屏', () => {
    assert.deepEqual(resolveFlashSources('bogus', ALL), ALL);
    assert.deepEqual(resolveFlashSources([], ALL), ALL);
    assert.deepEqual(resolveFlashSources(['x', 'y'], ALL), ALL);
  });

  it('重复项去重', () => {
    assert.deepEqual(resolveFlashSources(['em', 'em'], ALL), ['em']);
  });

  it('非字符串项被忽略', () => {
    assert.deepEqual(resolveFlashSources([123, null, 'em'], ALL), ['em']);
  });
});

describe('newsFeed - 分组与时间显示（阅读版式）', () => {
  const now = new Date(2026, 10, 10, 16, 0, 0).getTime(); // 2026-11-10 16:00

  it('formatTimeOfDay 只给 HH:mm', () => {
    assert.equal(formatTimeOfDay('2026-11-10T14:05:03'), '14:05');
    assert.equal(formatTimeOfDay('2026-11-09T09:00:00'), '09:00');
    assert.equal(formatTimeOfDay(null), '—');
    assert.equal(formatTimeOfDay('oops'), '—');
  });

  it('formatDayLabel：今天 / 昨天 / 同年月日 / 跨年月日', () => {
    assert.equal(formatDayLabel('2026-11-10', now), '今天');
    assert.equal(formatDayLabel('2026-11-09', now), '昨天');
    assert.equal(formatDayLabel('2026-11-06', now), '11月6日');
    assert.equal(formatDayLabel('2025-12-31', now), '2025年12月31日');
  });

  it('groupFlashByDate 按相邻同日切段，保持原顺序', () => {
    const groups = groupFlashByDate(
      [
        item({ id: 'a', publishedAt: '2026-11-10T15:00:00' }),
        item({ id: 'b', publishedAt: '2026-11-10T09:00:00' }),
        item({ id: 'c', publishedAt: '2026-11-09T20:00:00' })
      ],
      now
    );
    assert.equal(groups.length, 2);
    assert.equal(groups[0].label, '今天');
    assert.deepEqual(
      groups[0].items.map((i) => i.id),
      ['a', 'b']
    );
    assert.equal(groups[1].label, '昨天');
    assert.deepEqual(
      groups[1].items.map((i) => i.id),
      ['c']
    );
  });

  it('无时间的条目归入「时间未知」段而不是丢掉', () => {
    const groups = groupFlashByDate(
      [item({ id: 'a', publishedAt: '2026-11-10T15:00:00' }), item({ id: 'b', publishedAt: null })],
      now
    );
    assert.equal(groups.length, 2);
    assert.equal(groups[1].label, '时间未知');
    assert.equal(groups[1].items[0].id, 'b');
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(groupFlashByDate([]), []);
    assert.deepEqual(groupFlashByDate(null), []);
  });
});

describe('newsFeed - splitTitleAndBody（电头与截断标题）', () => {
  it('去掉「财联社X月X日电，」电头', () => {
    const out = splitTitleAndBody({
      title: '财联社11月10日电，欧洲股市集体高开',
      content: '财联社11月10日电，欧洲股市集体高开，STOXX600指数涨0.83%。'
    });
    assert.equal(out.title, '欧洲股市集体高开');
    assert.ok(!out.body.startsWith('财联社'));
  });

  it('截断标题（以…结尾）不参与剥离，正文从完整句首开始', () => {
    const out = splitTitleAndBody({
      title: '财联社11月10日电，接受WSJ调查的经济学家预计，10月美国总体通胀月率将从9…',
      content:
        '财联社11月10日电，接受WSJ调查的经济学家预计，10月美国总体通胀月率将从9月的0.6%降至0.3%，核心通胀月率从0.3%降至0.2%。'
    });
    // 标题是正文的截断，展示它会与正文重复；整条只展示完整正文
    assert.equal(out.title, '');
    assert.ok(out.body.startsWith('接受WSJ调查的经济学家预计'));
    assert.ok(out.body.includes('0.2%。'));
  });

  it('截断标题且无正文时，退回展示标题（不能渲染成空白）', () => {
    const out = splitTitleAndBody({ title: '某条快讯标题很长被上游截断…', content: '' });
    assert.equal(out.title, '某条快讯标题很长被上游截断…');
    assert.equal(out.body, '');
  });

  it('财联社真实形态：【标题】+ 电头 + 正文 —— 两者都要剥掉', () => {
    const out = splitTitleAndBody({
      title: '贵州茅台王莉：行业仍处于深度调整之中',
      content: '【贵州茅台王莉：行业仍处于深度调整之中】财联社11月10日电，贵州茅台10日召开业绩说明会。'
    });
    assert.equal(out.title, '贵州茅台王莉：行业仍处于深度调整之中');
    assert.equal(out.body, '贵州茅台10日召开业绩说明会。');
  });

  it('单句快讯（标题=正文）只渲染标题，不重复', () => {
    const out = splitTitleAndBody({
      title: '马士基股价下跌3.3%，连续第九个交易日走低。',
      content: '马士基股价下跌3.3%，连续第九个交易日走低。'
    });
    assert.equal(out.body, '');
  });

  it('不含电头的标题不受影响', () => {
    const out = splitTitleAndBody({ title: '欧股多数高开', content: '欧洲主要股指开盘上涨。' });
    assert.deepEqual(out, { title: '欧股多数高开', body: '欧洲主要股指开盘上涨。' });
  });
});
