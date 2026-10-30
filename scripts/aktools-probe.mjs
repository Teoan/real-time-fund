#!/usr/bin/env node
/**
 * AKTools / AKShare 基金接口联调探针
 *
 * 用途：新增 AKTools 能力前，先用真实实例验证「接口是否存在 / 返回体积 / 耗时 / 关键中文列名」。
 * 这是 aktools-capabilities.js 里某项能力从 false 改成 true 的唯一依据。
 *
 * 用法：
 *   node scripts/aktools-probe.mjs                     # 跑默认基金接口清单（样本 110022）
 *   node scripts/aktools-probe.mjs --symbol 000001     # 换样本基金
 *   node scripts/aktools-probe.mjs --only fund_fee_em,fund_overview_em
 *   node scripts/aktools-probe.mjs --json              # 输出机器可读 JSON（写联调文档用）
 *
 * 约定：
 *   - 只读脚本，不写任何业务文件；不引入项目依赖（只用 node --test 同款的纯 ESM）
 *   - 出口必须显式通过 AKTOOLS_BASE_URL 环境变量或 --base 指定，默认取 config 里的默认地址
 */

const DEFAULT_BASE_URL = 'http://100.68.218.28:18081/api/public';
const TIMEOUT_MS = 15000;

/**
 * 待联调接口清单。params 里的占位符 SYMBOL 会被样本基金代码替换。
 * why 说明该接口在当前项目里要解决什么缺口（写进联调记录）。
 */
const PROBES = [
  { fn: 'fund_overview_em', params: { symbol: 'SYMBOL' }, why: '档案-基本概况：管理费/托管费/销售服务费/规模/成立日' },
  { fn: 'fund_fee_em', params: { symbol: 'SYMBOL', indicator: '申购费率' }, why: '档案-购买信息：申购费率阶梯/起购金额' },
  { fn: 'fund_fee_em', params: { symbol: 'SYMBOL', indicator: '赎回费率' }, why: '档案-购买信息：赎回费率阶梯（按持有天数）' },
  { fn: 'fund_individual_detail_info_xq', params: { symbol: 'SYMBOL' }, why: '雪球-交易规则：确认日/限购/单日限额' },
  { fn: 'fund_individual_achievement_xq', params: { symbol: 'SYMBOL' }, why: '雪球-业绩详情：同类排名/同类平均' },
  { fn: 'fund_individual_profit_probability_xq', params: { symbol: 'SYMBOL' }, why: '雪球-盈利概率：持有 1/3/5 年盈利概率' },
  { fn: 'fund_portfolio_industry_allocation_em', params: { symbol: 'SYMBOL', date: '' }, why: '档案-行业配置：基金自身披露的行业占比' },
  { fn: 'fund_portfolio_bond_hold_em', params: { symbol: 'SYMBOL', date: '' }, why: '档案-债券持仓：债券型基金可展示持仓' },
  { fn: 'fund_portfolio_change_em', params: { symbol: 'SYMBOL', indicator: '累计买入', date: '' }, why: '档案-重大变动：本季调仓' },
  { fn: 'fund_announcement_dividend_em', params: { symbol: 'SYMBOL', date: '' }, why: '档案-分红配送公告：结构化分红' },
  { fn: 'fund_announcement_report_em', params: { symbol: 'SYMBOL', date: '' }, why: '档案-定期报告公告' },
  { fn: 'fund_announcement_personnel_em', params: { symbol: 'SYMBOL', date: '' }, why: '档案-人事调整公告：经理变更风险' },
  { fn: 'fund_etf_spot_em', params: {}, why: 'ETF 实时行情：场内折溢价率（全市场表，需谨慎）' },
  { fn: 'fund_info_index_em', params: { symbol: '沪深指数', indicator: '被动指数型' }, why: '指数型基本信息：跟踪标的指数（全市场表）' }
];

const parseArgs = (argv) => {
  const out = { symbol: '110022', only: null, json: false, base: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--symbol') out.symbol = argv[++i];
    else if (a === '--only') out.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--base') out.base = argv[++i];
  }
  return out;
};

const buildUrl = (base, fn, params, symbol) => {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    qs.set(k, String(v).replaceAll('SYMBOL', symbol));
  });
  const q = qs.toString();
  return `${base}/${fn}${q ? `?${q}` : ''}`;
};

/**
 * 取返回体的「结构摘要」：形状（array/object）、行数、前 N 行字段名/前两行值。
 * 中文列名是 mapper 的输入契约，必须打出来。
 */
const summarizePayload = (payload) => {
  if (Array.isArray(payload)) {
    const first = payload[0];
    const keys = first && typeof first === 'object' ? Object.keys(first) : [];
    return {
      shape: 'array',
      rows: payload.length,
      keys: keys.slice(0, 24),
      sample: payload.slice(0, 2)
    };
  }
  if (payload && typeof payload === 'object') {
    const keys = Object.keys(payload);
    return { shape: 'object', rows: 1, keys: keys.slice(0, 24), sample: [payload] };
  }
  return { shape: typeof payload, rows: 0, keys: [], sample: [payload] };
};

const probeOne = async ({ base, symbol, spec }) => {
  const url = buildUrl(base, spec.fn, spec.params, symbol);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    const elapsedMs = Date.now() - startedAt;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!res.ok) {
      return { fn: spec.fn, params: spec.params, url, status: res.status, ok: false, bytes, elapsedMs, why: spec.why, error: text.slice(0, 160).replace(/\s+/g, ' ') };
    }
    let payload = null;
    let parseError = null;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      parseError = String(e && e.message ? e.message : e);
    }
    const summary = parseError ? null : summarizePayload(payload);
    return {
      fn: spec.fn,
      params: spec.params,
      url,
      status: res.status,
      ok: !parseError,
      bytes,
      elapsedMs,
      why: spec.why,
      parseError,
      ...(summary || {})
    };
  } catch (e) {
    return {
      fn: spec.fn,
      params: spec.params,
      url,
      status: 0,
      ok: false,
      bytes: 0,
      elapsedMs: Date.now() - startedAt,
      why: spec.why,
      error: String((e && e.message) || e).slice(0, 200)
    };
  }
};

const humanLine = (r) => {
  const paramStr = Object.entries(r.params || {}).map(([k, v]) => `${k}=${v}`).join('&');
  const head = `${r.ok ? '✅' : '❌'} ${r.fn}${paramStr ? `?${paramStr}` : ''}`;
  const size = r.bytes > 1024 ? `${(r.bytes / 1024).toFixed(1)}KB` : `${r.bytes}B`;
  const shape = r.shape === 'array' ? `${r.rows} 行` : r.shape === 'object' ? '对象' : (r.shape || '?');
  const keys = r.keys && r.keys.length ? ` 列: ${r.keys.slice(0, 10).join(' / ')}` : '';
  const err = r.ok ? '' : `  ${r.error || r.parseError || ''}`;
  return `${head} | ${r.status} | ${size} | ${r.elapsedMs}ms | ${shape}${keys}${err}`;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const base = (args.base || process.env.AKTOOLS_BASE_URL || process.env.NEXT_PUBLIC_AKTOOLS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const specs = args.only ? PROBES.filter((p) => args.only.includes(p.fn)) : PROBES;
  if (!args.json) {
    console.log(`AKTools 探针: ${base}  样本基金: ${args.symbol}  接口数: ${specs.length}\n`);
  }
  const results = [];
  for (const spec of specs) {
    // 串行：AKTools 是单机服务，并发会互相拖慢，且探测耗时不敏感
    const r = await probeOne({ base, symbol: args.symbol, spec });
    results.push(r);
    if (!args.json) console.log(humanLine(r));
  }
  const okCount = results.filter((r) => r.ok).length;
  if (args.json) {
    console.log(JSON.stringify({ base, symbol: args.symbol, okCount, total: results.length, results }, null, 2));
  } else {
    console.log(`\n可用 ${okCount}/${results.length}`);
  }
  // 全不可达 → 退出码 2，便于 CI/脚本区分「实例不可达」与「个别接口失败」
  if (okCount === 0) process.exit(2);
};

main().catch((e) => {
  console.error('探针执行失败:', e);
  process.exit(1);
});
