# TopK / AKTools Provider

> 通过 [TopK](https://topk.xyz/) 部署的 AKTools 服务访问 [AKShare](https://akshare.akfamily.xyz/) 基金数据。

本目录实现了一个完整的、可独立测试、可注入缓存的 Provider 抽象，**不直接接入 UI / 业务数据源选择器**。当真实 TopK 服务可访问后，将 `topk-capabilities.js` 中的能力标记从 `false` 改为 `true` 即可启用。

## 目录结构

```
app/providers/topk/
├── index.js                 公共入口（业务层只引用这里）
├── topk-capabilities.js     能力矩阵
├── topk-config.js           baseUrl / 端点 / TTL 集中管理
├── topk-errors.js           错误模型
├── topk-client.js           HTTP Client（sanitize + 超时 + 重试）
├── topk-mappers.js          AKShare 字段 → Domain Model
├── topk-provider.js         Provider 主类（含 TanStack Query 缓存）
└── __tests__/
    ├── client.test.js
    ├── mappers.test.js
    └── provider.test.js
```

## 当前状态

| 业务能力                  | 实现        | 真实 TopK 联调                      |
| ------------------------- | ----------- | ----------------------------------- |
| searchFund                | ✅          | ❌ 待联调                           |
| getFundDetail             | ✅          | ✅ 2026-09-13                       |
| getFundLatestNav          | ✅          | ❌ 待联调                           |
| getFundNavHistory         | ✅          | ❌ 待联调                           |
| getFundHoldings           | ✅          | ❌ 待联调                           |
| getStockFundamentals      | ✅          | ✅ 2026-09（stock_value_em）        |
| getStockRoe               | ✅          | ✅ 2026-09-19（新浪财务指标）       |
| getStockHkFinancial       | ✅          | ✅ 2026-09-19（港股财务指标）       |
| getStockHkValueHistory    | ✅          | ✅ 2026-09-26（百度股市通估值历史） |
| getStockUsFinancial       | ✅          | ✅ 2026-09-26（美股财务指标）       |
| 其它（manager / rank 等） | ❌ 暂未实现 | ❌                                  |

## 港股持仓穿透（getStockHkFinancial / getStockHkValueHistory）

- **getStockHkFinancial**：AKShare `stock_hk_financial_indicator_em`，取「股东权益回报率(%)」作为港股 ROE。
  东财 F10 主要财务指标不覆盖港股，故这是港股 ROE 的唯一来源。
- **getStockHkValueHistory**：AKShare `stock_hk_valuation_baidu`（百度股市通），取市盈率(TTM) / 市净率历史序列，
  用于港股 PE/PB 历史分位**与近 1/3 月区间走势**。
  业务层只传领域字段名 `pe` / `pb`，上游中文指标名在 `topk-config.js` 的 `TOPK_HK_VALUATION_INDICATORS` 中映射；
  代码补零为 5 位（`0700` → `00700`，**不加** `hk` 前缀），并固定带 `period=近五年`。
- **实测（2026-09-26）**：financial 200 / ~0.7KB / ~0.15s；valuation_baidu 200 / ~17~45KB，数据到当日。

### 数据源变更：eniu → baidu（2026-09-26）

原先用 `stock_hk_indicator_eniu`（亿牛网），但亿牛网已下线港股个股页（`eniu.com/gu/hk00700` 返回「未收录此股票」），
AKShare 只能返回存档数据 —— 实测 00700 / 09988 / 00939 / 03690 的 PE、PB 序列**最后日期均为 2022-07-13**。

这意味着「近 5 年分位」实际是拿 **2021-09 ~ 2022-07** 的区间与**今天的值**比较，存在系统性偏差。
改用 `stock_hk_valuation_baidu` 后数据到当日（实测末点即当天），分位口径恢复正常，
同时其尾部数据直接用于区间走势，无需二次请求。

⚠️ 指标名必须精确：`市盈率` → 500，只有 `市盈率(TTM)` 可用；`市销率` → 500（故港股无 `psPercentile`）。

### 缓存

序列经 `topk-daily-cache.js` 做**天级 localStorage 缓存**（键 `topk:hkValueHistory:{symbol}:{pe|pb}`），
只写入近 5 年窗口（约 914 行/指标）。切换到 baidu 后 `HK_CACHE_VERSION` 已从 1 提升到 2，
使旧的 eniu 陈旧缓存自动失效（否则会继续用 4 年前的区间算分位）。

## 估值区间走势（近 1 月 ~ 成立来）

`app/lib/valuationHistory.js` 把当前时点的评分流程在区间内的每个日期上重放，得到评分走势与区间统计。
区间档位与「业绩走势」一致：**近 1 月 / 近 3 月 / 近 6 月 / 近 1 年 / 近 3 年 / 成立来**。

- **A 股**：复用 `stock_value_em` 的近端估值点。分位窗口缓存新增 `recent` 字段
  （**带日期**的 {pe,pb,ps} 序列）——原有的 `values` 数组刻意不带日期且按指标过滤，
  无法按日对齐，故必须单独保留。
- **港股**：直接复用上面的 baidu 序列（`period=近五年`，约 913 点，同时满足分位窗口与 5 年走势）。
- **美股**：无可用估值历史源，不参与区间走势（UI 会提示）。

### 体积控制（`recent` 序列）

区间扩展到 5 年后需要覆盖整个分位窗口（A 股约 1210 行）。按日频整段落盘约 67KB/只，
因此 `buildTrendSeries` 做两级压缩：

1. **抽稀**：近端 130 行保留日频（近 1~6 月精度不受影响），远端按需抽稀，总点数封顶 320。
2. **降精度**：`roundMetric` 把 PE/PB/PS 保留 4 位小数。
   `stock_value_em` 返回全精度浮点（`18.98901221999999`），JSON 里每个数要占 12+ 字符，
   而 4 位小数对分位排序毫无影响 —— 仅此一项就把分位数值数组 + 走势序列的体积砍掉约三分之一。

效果：约 **45KB/只**（与扩展前基本持平，但走势覆盖从 3 个月提升到 5 年）。
缓存按 `symbol` 索引，多只基金持有同一只股票只存一份。

### 已知近似

区间内各日期的分位统一使用「当前时点的近 5 年分布」作为参照，而非每个历史日各自回看的窗口。
区间越短影响越小（1~3 个月该窗口仅平移约 1~5%）；区间越长，其含义越偏向
「该历史估值在**当前 5 年分布**中的位置」——好处是全区间用同一把尺子、各点可比，
代价是早期点位带入后验信息。

「成立来」取「全部可用数据（最多近 5 年）」，**不是基金成立日**：本模块用的是持仓股票的估值历史，
不是基金自身净值。A 股虽可取到 8.5 年（2018 起），但港股百度只到 5 年，
且超过 5 年的点位无法与「当前 5 年分布」同尺度比较。UI 会显示实际覆盖区间并给出上限提示。

长区间下的分位计算用 `createRanker`（先排序参照分布、再二分求秩）代替逐点线性扫描，
把每个点位的复杂度从 O(n) 降到 O(log n)：实测近 3 年 / 成立来（约 650~1030 个点）单次计算 3~6ms。

## 美股持仓穿透（getStockUsFinancial）

- **数据源**：AKShare `stock_financial_us_analysis_indicator_em`（东财美股财务指标），取最新报告期一行：
  `ROE_AVG` → `roe`、`PARENT_HOLDER_NETPROFIT_YOY` → `epsGrowth`、`OPERATE_INCOME_YOY` → `revenueGrowth`、
  `GROSS_PROFIT_RATIO` → `grossMargin`（仅备用，跨行业不可比，不参与打分）。
- **定位**：东财 push2 不提供美股 ROE，且其 `f185`（净利润同比）对美股恒为 `0.0`（缺失哨兵值），
  因此本接口是美股 ROE 与成长性指标的唯一来源。业务层 `app/api/fund.js` 的 `fetchStockUsFinancial`
  合并到 push2 拿到的 PE/PB/PS 上。
- **实测（2026-09-26）**：HTTP 200 / 单只 7~38KB / ~0.5s。⚠️ 该接口**只接受 `symbol`**，
  附加 `indicator` / `period` 会返回 500。
- 数据量小、耗时短，因此只走 TanStack 24h 缓存，**不做** localStorage 天级缓存
  （与港股估值序列需按天缓存的情况不同）。

### 美股估值倍数走东财 push2（非 TopK）

美股当前 PE/PB/PS/股息率由东财 `push2delay` 提供，业务层在 `normalizeSecid` 中解析 secid：

- `105.` = 纳斯达克、`106.` = 纽交所。解析时先用 `105.`，失败后用 `usSecidFallback` 回退 `106.`
  （实测 `105.JPM` / `105.V` / `105.XOM` 无数据，`106.*` 正常）。
- 带点/带横线代码在东财口径中写作下划线：`BRK.B` → `106.BRK_B`
  （`106.BRK.B` 无数据；此前代码截断成 `105.BRK`，必然失败）。
- 美股 `f185` 归一为 `null`（缺失哨兵值），`f126` 为 `"-"` 时同样归一为 `null`。

### ⚠️ 已知限制：不存在可用的美股估值历史源

2026-09-26 实测结论（区分「404 = 接口未暴露」与「500 = 接口存在但上游报错」）：

| 接口                                                                                                                                         | 结果                                |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `stock_financial_us_analysis_indicator_em`                                                                                                   | ✅ 200                              |
| `stock_us_daily`                                                                                                                             | ✅ 200，但仅 OHLCV 价格，无估值比率 |
| `index_us_stock_sina`                                                                                                                        | ✅ 200（美股指数）                  |
| `stock_us_spot_em` / `stock_us_famous_spot_em` / `stock_us_hist` / `stock_us_hist_min_em`                                                    | ❌ 500                              |
| `stock_us_valuation_baidu`（市盈率(TTM)/市净率/市销率/市盈率(静)/总市值 × 近一年/近五年）                                                    | ❌ 500                              |
| `stock_financial_us_report_em` / `stock_individual_basic_info_us_xq`                                                                         | ❌ 500                              |
| `stock_us_min` / `stock_us_fund_flow_em` / `stock_us_zh_index_daily` / `stock_us_profile` / `stock_us_fundamental` / `stock_us_indicator_lg` | ❌ 404（未暴露）                    |

⇒ 美股**无法计算 PE/PB/PS 历史分位**。业务层的处置：
`app/lib/valuationRules.js` 的 `US_STOCK` 规则给 PE/PB/PS 标记 `absolute: true`，
在分位缺失时回退到 `valuationEngine.js` 的绝对阈值评分（`peToScore` / `pbToScore` / `psToScore`）；
若将来出现可用历史源，分位会自动优先生效（`absolute` 仅在分位为 null 时兜底）。

未采用「价格 × EPS 反推估值历史」：美股拆股频繁，且回购使部分公司股东权益为负
（实测 AAPL `ROE_AVG` 171%、NVDA 101%），反推结果失真风险高。

## stock_value_em 全量调用降本

`stock_value_em` 单只返回 **~2117 行 / ~708KB**，且上游只接受 `symbol`（加 `start_date`/`limit` 等一律 500），
无法服务端裁剪。项目原先把它当作两个接口使用，导致同一只股票被完整拉取两次：

| 消费者                 | 需要的部分       | 原缓存                                 |
| ---------------------- | ---------------- | -------------------------------------- |
| `getStockFundamentals` | 最新 1 行        | 内存 + localStorage 天级（只存最新行） |
| `getStockValueHistory` | 全序列（算分位） | 仅内存 → 每次刷新重放全量              |

现在改为三层：

1. **Provider 共用一份原始行**：两个方法都走同一个缓存条目（key `topk:stockValueEm:{symbol}`），各自只做映射。
   该条目内存 TTL 仅 10 分钟（`STOCK_VALUE_ROWS_CACHE_TTL`）—— ~708KB/只长期驻留不划算，
   而两个消费者在同一次估值流程内先后调用，10 分钟绰绰有余。
2. **业务层天级缓存「分位窗口」**：`topk:stockValueWindow:{symbol}` 只存近 5 年窗口的各指标数值数组 + 窗口最后一行
   （`buildStockValueWindow`），刷新时不再重放全量；A 股预取同时改用 `asyncPool(4)` 并发。
3. **Provider 默认缓存不再是 no-op**：`createTopKProvider` 现在默认按实例注入内存缓存
   （in-flight 去重 + TTL 取 `staleTime` + 32 条上限）。此前 `defaultTopKProvider` 完全没有缓存、
   而 `createTopKProviderForApp` 从未被调用，等于所有 TopK 请求都不缓存。

效果（10 只 A 股持仓）：当天首次打开 **20 次 → 10 次**（≈14MB → ≈7MB），之后每次刷新 **10 次 → 0 次**。

## 单股 ROE 兜底（getStockRoe）

- **数据源**：AKShare `stock_financial_analysis_indicator`（新浪财经-财务指标），取最近一期报告的「加权净资产收益率(%)」。
- **定位**：业务层 `app/api/fund.js` 中 ROE 以「东方财富 F10（JSONP 直连）主源 → TopK 兜底」的顺序获取，仅当 F10 不可用时才调用本方法。
- **实测（2026-09-19）**：HTTP 200 / 约 30KB（`start_year` 限制近两年报告期）/ 约 2.4s。
  东财口径的 `stock_financial_analysis_indicator_em` 在同一实例返回 500，未采用；`stock_financial_abstract`、`stock_zh_dupont_comparison_em` 亦可用但字段口径不如前者直接。

⚠️ **topk.xyz 域名当前并非 AKTools 服务**（验证日期 2026-08-31，主页为无关 LNMP 演示页，`/api/public/*` 全部 404）。在用户/部署方提供正确的 AKTools baseUrl 之前，所有方法调用都会通过单元测试中模拟的 fetch 通过。

## 配置环境变量

```
NEXT_PUBLIC_TOPK_BASE_URL=https://your-aktools-host/api/public
```

未设置时使用 `http://100.68.218.28:18081/api/public`（自建 AKTools 实例默认值）。

## 运行测试

```
node --test app/providers/topk/__tests__/*.test.js
```

注：Node 25 下 `node --test <目录>` 会把目录当作模块解析并报 `MODULE_NOT_FOUND`，
需显式传文件或以 glob 展开。

## 设计原则

1. **Provider 不在业务层写 URL**：业务层只 `import { defaultTopKProvider } from '@/app/providers/topk'`，baseUrl 完全在 `topk-config.js` 中。
2. **AKShare 字段不得泄漏**：所有 AKShare 中文列名（如 `单位净值`）必须经过 `topk-mappers.js` 转换，业务层只看到 `unitNav`。
3. **错误归一化**：UI 层不会直接收到 `fetch` 或 `JSON.parse` 异常，只会收到 `TopKError` 家族。
4. **不绑定 UI**：本目录故意**不修改** `app/api/fund.js`、`FundDataSourceSelector.jsx`、`page.jsx`。是否接入数据源切换 UI 由后续 PR 决定。

## 接入 UI 的最小后续步骤

```js
// 1) 在 fetchFundValuationBySource 中加入 source=5 路由（暂不推荐，先做 fallback）
// 2) 在 settingsStore 中加入 TopK 启用开关与 baseUrl 配置项
// 3) 在 FundDataSourceSelector.jsx 中展示健康状态（healthCheck 结果）
// 4) 用 topk-capabilities 中真实联调结果更新能力矩阵
```
