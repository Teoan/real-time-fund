/**
 * 市场资讯 mapper 单测
 *
 * 用 AKShare 文档给出的真实列名/样本形态做输入（见 doc/AKShare基金接口接入.md），
 * 守住三件事：
 *   1. 8 个源的字段差异被正确归一（尤其财联社的「日期+时间分两列」与新浪的「只有内容」）；
 *   2. 列名缺失只让该字段为 null，绝不抛错（AKShare 改版时页面不能白屏）；
 *   3. 时间统一成不带时区的 `YYYY-MM-DDTHH:mm:ss`，不引入跨时区换算。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapMarketFlashClsRow,
  mapMarketFlashEmRow,
  mapMarketFlashSinaRow,
  mapMarketFlashThsRow,
  mapMarketFlashFutuRow,
  mapBreakfastRow,
  mapCaixinRow,
  mapCctvRow,
  mapNewsRows,
  mapNewsPublishedAt,
  deriveFlashTitle,
  __test__extended
} from '../aktools-mappers.js';

const { parseNewsDateTimeParts } = __test__extended;

describe('资讯 mapper - 时间解析', () => {
  it('完整日期时间', () => {
    assert.equal(mapNewsPublishedAt({ 发布时间: '2024-03-13 16:18:40' }), '2024-03-13T16:18:40');
  });

  it('只有日期时补 00:00:00', () => {
    assert.equal(mapNewsPublishedAt({ 发布时间: '2024-03-13' }), '2024-03-13T00:00:00');
  });

  it('财联社：发布日期 + 发布时间 两列拼合', () => {
    assert.equal(mapNewsPublishedAt({ 发布日期: '2026-11-10', 发布时间: '14:05:03' }), '2026-11-10T14:05:03');
  });

  it('英文列名 date（news_cctv）', () => {
    assert.equal(mapNewsPublishedAt({ date: '2026-11-10' }), '2026-11-10T00:00:00');
  });

  it('中文年月日与 8 位数字日期', () => {
    assert.equal(parseNewsDateTimeParts('2026年11月10日').date, '2026-11-10');
    assert.equal(parseNewsDateTimeParts('20261110').date, '2026-11-10');
  });

  it('纯时间返回 time、date 为 null（供与日期列拼合）', () => {
    assert.deepEqual(parseNewsDateTimeParts('14:05'), { date: null, time: '14:05:00' });
  });

  it('毫秒/秒时间戳都支持', () => {
    const ms = new Date(2026, 10, 10, 9, 30, 0).getTime();
    assert.equal(mapNewsPublishedAt({ 发布时间: ms }), '2026-11-10T09:30:00');
    assert.equal(mapNewsPublishedAt({ 发布时间: Math.floor(ms / 1000) }), '2026-11-10T09:30:00');
  });

  it('非法值与空值返回 null', () => {
    assert.equal(mapNewsPublishedAt({ 发布时间: 'nan' }), null);
    assert.equal(mapNewsPublishedAt({ 发布时间: '' }), null);
    assert.equal(mapNewsPublishedAt({}), null);
    assert.equal(mapNewsPublishedAt(null), null);
    assert.equal(parseNewsDateTimeParts('99:99'), null);
  });
});

describe('资讯 mapper - deriveFlashTitle', () => {
  it('优先取【】内的标题', () => {
    assert.equal(deriveFlashTitle('【央行降准 0.5 个百分点】为支持实体经济发展…'), '央行降准 0.5 个百分点');
  });

  it('无括号时截断 40 字并加省略号', () => {
    const long = '一'.repeat(60);
    const title = deriveFlashTitle(long);
    assert.equal(title.length, 41);
    assert.ok(title.endsWith('…'));
  });

  it('空内容返回 null', () => {
    assert.equal(deriveFlashTitle(null), null);
    assert.equal(deriveFlashTitle('   '), null);
  });
});

describe('资讯 mapper - 财联社（stock_info_global_cls）', () => {
  const row = {
    标题: '华为轮值董事长徐直军谈鸿蒙生态未来目标',
    内容: '华为轮值董事长徐直军谈鸿蒙生态未来目标：拥有10万个应用',
    发布日期: '2026-11-10',
    发布时间: '14:05:03'
  };

  it('归一化字段齐全，且无外链（上游没有链接列）', () => {
    const mapped = mapMarketFlashClsRow(row);
    assert.equal(mapped.source, 'cls');
    assert.equal(mapped.sourceLabel, '财联社');
    assert.equal(mapped.title, row.标题);
    assert.equal(mapped.publishedAt, '2026-11-10T14:05:03');
    assert.equal(mapped.url, null);
    assert.equal(mapped.important, false);
    assert.match(mapped.id, /^cls:/);
  });

  it('important 由调用方传入（symbol=重点）', () => {
    const mapped = mapMarketFlashClsRow(row, { important: true });
    assert.equal(mapped.important, true);
  });

  it('缺标题时从内容派生', () => {
    const mapped = mapMarketFlashClsRow({ 内容: '【标题来了】正文内容' });
    assert.equal(mapped.title, '标题来了');
  });
});

describe('资讯 mapper - 东财 / 同花顺 / 富途', () => {
  it('东财：标题 + 摘要 + 链接', () => {
    const mapped = mapMarketFlashEmRow({
      标题: '法本信息与鸿蒙生态服务公司签约合作',
      摘要: '据法本信息消息…',
      发布时间: '2026-11-10 09:12:00',
      链接: 'https://finance.eastmoney.com/a/2026111030.html'
    });
    assert.equal(mapped.source, 'em');
    assert.equal(mapped.sourceLabel, '东财');
    assert.equal(mapped.content, null);
    assert.equal(mapped.publishedAt, '2026-11-10T09:12:00');
    assert.ok(mapped.url.startsWith('https://'));
  });

  it('同花顺 / 富途：标题 + 内容 + 链接', () => {
    for (const [mapper, source, label] of [
      [mapMarketFlashThsRow, 'ths', '同花顺'],
      [mapMarketFlashFutuRow, 'futu', '富途']
    ]) {
      const mapped = mapper({
        标题: '欧股多数高开',
        内容: '欧洲主要股指开盘上涨',
        发布时间: '2026-11-10 15:02:00',
        链接: 'https://news.example.com/1'
      });
      assert.equal(mapped.source, source);
      assert.equal(mapped.sourceLabel, label);
      assert.equal(mapped.content, '欧洲主要股指开盘上涨');
      assert.equal(mapped.publishedAt, '2026-11-10T15:02:00');
    }
  });

  it('非法链接（站内锚点）被丢弃', () => {
    const mapped = mapMarketFlashEmRow({ 标题: 'x', 链接: '#detail' });
    assert.equal(mapped.url, null);
  });
});

describe('资讯 mapper - 新浪（stock_info_global_sina）', () => {
  it('只有「时间/内容」时标题从内容派生', () => {
    const mapped = mapMarketFlashSinaRow({
      时间: '2024-03-13 16:18:40',
      内容: '【九部门：鼓励在有条件的村布放智能快件箱】商务部等9部门发布…'
    });
    assert.equal(mapped.source, 'sina');
    assert.equal(mapped.sourceLabel, '新浪');
    assert.equal(mapped.title, '九部门：鼓励在有条件的村布放智能快件箱');
    assert.equal(mapped.publishedAt, '2024-03-13T16:18:40');
    assert.equal(mapped.url, null);
  });
});

describe('资讯 mapper - 财经早餐 / 财新 / 联播', () => {
  it('财经早餐：标题 + 摘要 + 时间 + 链接', () => {
    const mapped = mapBreakfastRow({
      标题: '东方财富财经早餐 3月13日周三',
      摘要: '重点关注…',
      发布时间: '2024-03-13 07:00:00',
      链接: 'http://finance.eastmoney.com/a/202403133.html'
    });
    assert.equal(mapped.sourceLabel, '财经早餐');
    assert.equal(mapped.title, '东方财富财经早餐 3月13日周三');
    assert.equal(mapped.publishedAt, '2024-03-13T07:00:00');
  });

  it('财新：英文列名，无时间字段', () => {
    const mapped = mapCaixinRow({
      tag: '宏观',
      summary: '央行公开市场净投放…',
      url: 'https://cxdata.caixin.com/pc/1'
    });
    assert.equal(mapped.sourceLabel, '财新');
    assert.equal(mapped.tag, '宏观');
    assert.equal(mapped.publishedAt, null);
    assert.ok(mapped.url);
  });

  it('联播：date / title / content', () => {
    const mapped = mapCctvRow({ date: '2026-11-10', title: '中共中央政治局召开会议', content: '会议指出…' });
    assert.equal(mapped.sourceLabel, '新闻联播');
    assert.equal(mapped.publishedAt, '2026-11-10T00:00:00');
    assert.equal(mapped.title, '中共中央政治局召开会议');
  });
});

describe('资讯 mapper - 健壮性', () => {
  it('三项文本全空的行返回 null', () => {
    assert.equal(mapMarketFlashEmRow({ 发布时间: '2026-11-10' }), null);
    assert.equal(mapMarketFlashSinaRow({}), null);
    assert.equal(mapCctvRow({}), null);
  });

  it('非对象输入返回 null，不抛错', () => {
    assert.equal(mapMarketFlashClsRow(null), null);
    assert.equal(mapMarketFlashEmRow('x'), null);
    assert.equal(mapCaixinRow(42), null);
  });

  it('mapper 是全字段缺列也不崩（模拟上游改版）', () => {
    const mapped = mapMarketFlashClsRow({ 未知列: 'x' });
    assert.equal(mapped, null);
  });

  it('mapNewsRows 过滤无效行并保持顺序', () => {
    const rows = [
      { 标题: '一', 发布时间: '2026-11-10 10:00:00' },
      { 发布时间: '2026-11-10 10:01:00' },
      { 标题: '三', 发布时间: '2026-11-10 10:02:00' }
    ];
    const items = mapNewsRows(rows, mapMarketFlashEmRow);
    assert.deepEqual(
      items.map((i) => i.title),
      ['一', '三']
    );
  });

  it('mapNewsRows 对非数组安全', () => {
    assert.deepEqual(mapNewsRows(null, mapMarketFlashEmRow), []);
    assert.deepEqual(mapNewsRows(undefined, mapMarketFlashEmRow), []);
  });

  it('id 稳定：同一内容两次映射得到同一个 id', () => {
    const row = { 标题: '同一标题', 内容: '同一内容', 发布时间: '2026-11-10 10:00:00' };
    assert.equal(mapMarketFlashEmRow(row).id, mapMarketFlashEmRow(row).id);
  });
});
