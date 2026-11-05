# AKShare 基金接口接入说明

> 记录「基估宝」如何用 AKShare 的**单基金粒度**接口做能力补充，以及每个接口的联调实测结论。
> 最后更新：2026-10-30（样本基金 110022 易方达消费行业股票）

## 1. 为什么不能直连 AKShare

本项目是 **纯静态导出**（`output: 'export'`），所有外部数据靠 JSONP / `<script>` 注入绕开 CORS，浏览器里没有 Python 运行时，无法 `import akshare`。

因此数据链路是：

```
浏览器（本项目）
  └─ fetch → AKTools（自建转发服务，HTTP/JSON）→ AKShare → 天天基金 / 东方财富 / 雪球
```

- 转发地址：`NEXT_PUBLIC_AKTOOLS_BASE_URL`（默认 `http://100.68.218.28:18081/api/public`）
- 接入层：`app/providers/aktools/`（config / capabilities / client / mappers / provider）
- 业务封装：`app/api/fund.js` 末尾的 `fetchFundProfile*` 系列薄封装
- 自建 AKTools（或换地址）时**只需改环境变量**，业务代码不用动。

## 2. 已接入的接口

| AKShare 接口                             | 能力开关                    | 缓存 TTL                     | 用途                                           | UI 落点                                               |
| ---------------------------------------- | --------------------------- | ---------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| `fund_overview_em`                       | `getFundOverview`           | 24h                          | 管理费/托管费/销售服务费/规模/成立日/业绩基准  | 基金档案·概况 / 调研报告「基金档案」段                |
| `fund_individual_detail_info_xq`         | `getFundFeeTiers`           | 24h                          | 申购（按金额）/赎回（按持有期）费率阶梯        | 基金档案·费率 / 交易弹框费率提示                      |
| `fund_open_fund_info_em`（分红送配详情） | `getFundDividendDetail`     | 24h                          | 分红记录（除息日/每份分红）                    | 基金档案·分红                                         |
| `fund_individual_achievement_xq`         | `getFundAchievement`        | 6h                           | 区间收益/最大回撤/同类排名                     | 基金档案·同业 / 调研报告「同业位置」段                |
| `fund_individual_profit_probability_xq`  | `getFundProfitProbability`  | 24h                          | 持有 6 月/1/2/3 年的历史盈利概率               | 基金档案·同业                                         |
| `fund_portfolio_industry_allocation_em`  | `getFundIndustryAllocation` | 24h                          | 基金自身披露的行业配置                         | 基金档案·组合                                         |
| `fund_portfolio_bond_hold_em`            | `getFundBondHoldings`       | 24h                          | 债券持仓（债券型/固收+ 的实际敞口）            | 基金档案·组合                                         |
| `fund_portfolio_change_em`               | `getFundPortfolioChange`    | 24h                          | 本季累计买入/卖出明细                          | 基金档案·组合                                         |
| `fund_open_fund_rank_em`                 | `getFundRank`               | 1h（内存）/ 24h（IndexedDB） | 全市场跨周期业绩排行（近1周~成立来 + 手续费）  | 行情·榜单栏「业绩排行」tab                            |
| `fund_value_estimation_em`               | `getFundValuationRank`      | 1min                         | 全市场盘中估值表（估算涨幅/实际涨幅/估算偏差） | 行情·榜单栏 估值涨幅 / 估值跌幅 / 实际涨幅 / 估值偏差 |
| `stock_board_industry_name_em`           | `getSectorBoard`            | 5min                         | 行业板块行情（涨跌幅/领涨股/换手率）           | 行情·热门板块（行业）                                 |
| `stock_board_concept_name_em`            | `getSectorBoard`            | 5min                         | 概念板块行情                                   | 行情·热门板块（概念）                                 |
| `stock_sector_fund_flow_rank`            | `getSectorBoard`            | 5min                         | 板块今日主力净流入（按板块名合并进上两行）     | 行情·热门板块（按资金流入排序）                       |

**设计边界（重要）**：这些数据**只做展示与提示，不参与估值、盈亏、持仓计算**，也**不参与指标画像评分**。任何接口挂了都只影响自己那一屏。

**唯一例外**：`fund_open_fund_rank_em` 是**全市场快照**（一次返回整个分类），不遵循下面的「单基金粒度」原则 —— 理由见 §4 的说明。

## 3. 联调实测（2026-10-30）

复现命令（无副作用，只读探测）：

```bash
node scripts/aktools-probe.mjs                          # 默认样本 110022
node scripts/aktools-probe.mjs --symbol 161725          # 换基金
node scripts/aktools-probe.mjs --only fund_overview_em  # 只测一个接口
node scripts/aktools-probe.mjs --json                   # 机器可读，便于贴进 issue
```

实测 10/14 可用：

| 状态    | 接口                                                             | 结论                                                    |
| ------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| ✅ 200  | `fund_overview_em`                                               | 838B / 1 行，费率与规模齐全                             |
| ✅ 200  | `fund_fee_em`（赎回费率）                                        | 4 行，但**申购费率返回 0 行**（故改用 detail_info_xq）  |
| ✅ 200  | `fund_individual_detail_info_xq`                                 | 913B / 10 行，一次给出买入阶梯 + 卖出阶梯 + 其他费用    |
| ✅ 200  | `fund_individual_achievement_xq`                                 | 3.5KB / 24 行，注意上游列名「最大回**撒**」是错别字     |
| ✅ 200  | `fund_individual_profit_probability_xq`                          | 267B / 4 行                                             |
| ✅ 200  | `fund_portfolio_industry_allocation_em`                          | 2.2KB / 18 行，**一次返回多个报告期，必须只取最新一期** |
| ✅ 200  | `fund_portfolio_bond_hold_em`                                    | 1.7KB / 11 行                                           |
| ✅ 200  | `fund_portfolio_change_em`                                       | 3.8KB / 20 行                                           |
| ✅ 200  | `fund_info_index_em`                                             | 682KB / 1791 行（全市场指数基金表，未接入）             |
| ❌ 500  | `fund_announcement_dividend_em` / `_report_em` / `_personnel_em` | 服务端 500，能力开关保持 `false`                        |
| ❌ 超时 | `fund_etf_spot_em`                                               | 15s 超时（全市场 ETF 快照，与单基金粒度不符，不接入）   |

### 全市场排行补测（2026-10-31）

`fund_open_fund_rank_em` 是唯一接入的全市场接口，必须先看清体量 —— 上游**没有分页/排序参数**（AKShare 源码硬编码 `pn=30000`，东财的 `sc` 排序参数不透传），每次调用都是该分类全量：

| symbol | 行数  | 响应体 | 耗时  |
| ------ | ----- | ------ | ----- |
| 股票型 | 1101  | 413 KB | 0.70s |
| QDII   | 225   | 85 KB  | 0.28s |
| FOF    | 1033  | 398 KB | 0.67s |
| 指数型 | 4643  | 1.7 MB | 2.03s |
| 债券型 | 5068  | 1.8 MB | 2.02s |
| 混合型 | 8614  | 3.2 MB | 3.38s |
| 全部   | 20689 | 7.8 MB | 8.16s |

⇒ 因此：默认分类取体量最小的「股票型」；只在用户打开「业绩排行」tab 时才请求；不做预取、不并发多分类；排序与分页全部在前端（全量已在内存）。

**为什么不复用东财 JSONP**：`fund.eastmoney.com/data/rankhandler.aspx` 有 Referer 白名单 —— 无 Referer 或 `teoan.github.io` 都返回 `ErrCode:-999 无访问权限`，只有 `Referer: https://fund.eastmoney.com/...` 才 200。项目现有的 `<script>` 注入无法伪造 Referer，所以这类接口只能走 AKTools 服务端通道。

### 行情页榜单数据源迁移（2026-11-05）

行情页的「估值涨幅 / 估值跌幅 / 实际涨幅」三个榜单原先走 **Supabase Edge Function `fund-valuation-ranking`**，而该函数内部代理的是
`api.fund.eastmoney.com/FundGuZhi/GetFundGZList`。两条链路同时断了：

| 环节                                   | 现状                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GetFundGZList`（东财估值榜 JSONP）    | 已下线。带 `Referer: https://fund.eastmoney.com/` 也返回 `ErrCode: -1「暂无数据」`，不带 Referer 返回 `-999 无访问权限` |
| Edge Function `fund-valuation-ranking` | 只是上面那个接口的转发壳，上游没数据它就没数据                                                                          |
| 项目对应的 Supabase 实例               | 域名 DNS 已 NXDOMAIN（项目被删除/改名），`functions.invoke` 与 `fund_topic` 表查询全部直接失败                          |
| `fund_topic` 表（热门板块卡片）        | 随实例一起不可用                                                                                                        |

因此这三类数据统一改由 AKTools 提供，UI 不再依赖登录态与云函数：

- **三个榜单** → `fund_value_estimation_em`（782 行 / 266KB / ~3.6s，一次整表，排序分页全在本地）
- **热门板块** → `stock_board_industry_name_em` / `stock_board_concept_name_em` + `stock_sector_fund_flow_rank`
  （行业 496 行 / 概念 531 行，净流入按板块名合并，资金流失败时只丢 `net_inflow` 不影响列表）

⚠️ `fund_value_estimation_em` 只支持 `symbol=全部`：`股票型/混合型/指数型/债券型/QDII` 传进去均返回 **0 行**，`FOF` 直接 400。
所以 Provider 方法不接受 symbol，避免把无效参数透传给上游。

**「成交热度」tab 已被替换为「估值偏差」**：原第 4 个 tab 依赖东财的成交量/热度字段，该字段随接口一起消失，
现无任何可信来源；而估值表自带「估算偏差」，按 `|估算偏差|` 排序能直接看出哪些基金今日估算与实际净值偏离最大
（通常是重仓调整或港股/QDII 仓位导致的估算失真），信息量高于一个永远为空的 tab。

### 空数组 / 陈旧陷阱

- `date` 参数**必须显式传空串**：`{ symbol: code, date: '' }`。省略参数会落到 AKShare 的默认年份，静默返回上一年的数据。
- 行业/债券/调仓接口会把**多个报告期混在一个响应里**，`pickLatestDatedItems()` 负责只保留最新一期，否则会出现同一行业重复三行、权重互相矛盾。
- 货币基金 / C 类份额可能没有申赎阶梯，此时 `hasTiers=false`，UI 显示「未提供费率阶梯」而不是报错。

## 4. 评估过但没接入的接口

| 接口                                         | 不接入的原因                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `fund_name_em`（全市场基金名录）             | 项目已内置 `public/allFund.json`（26185 条），离线可用、无需联网；重复接入只会增加故障面 |
| `fund_etf_spot_em` / `fund_etf_category_ths` | 全市场快照型接口，与「单基金粒度」接入原则不符，且实测超时                               |
| `fund_announcement_*`                        | 当前 AKTools 实例 500                                                                    |
| `fund_purchase_em`                           | 内容是各销售渠道的申购状态/费率，粒度过细，先做费率阶梯已够用                            |
| `fund_aum_hist_em`                           | 规模历史与 `fund_overview_em` 的规模字段重复，价值低于成本                               |
| `fund_individual_analysis_xq` 等雪球系列     | 需要跨接口拼接，收益/回撤能由本地净值序列算出，口径反而更一致                            |
| `fund_rating_all`（评级榜）                  | 翻 78 页 / 34s，且评级是季度更新 —— 若接入必须落天级快照表，成本远高于收益，列为下一迭代 |

**为什么给 `fund_open_fund_rank_em` 开例外**（全市场快照但已接入）：

- 它补的是项目**唯一缺失**的能力：所有跨周期收益指标此前只有单基金维度（`fetchFundPeriodReturns` 一次一只），做不出全市场业绩榜；而现有榜单栏四个 tab 全是「当日口径」，看不到中长期。
- 与已有数据**零重叠**：估值榜来自 Supabase Edge Function（需登录、当日口径），业绩排行来自 AKTools（公开数据、跨周期）。
- 体量可控：默认分类 413KB/0.7s，且只在天级缓存（IndexedDB，`aktools:` 前缀不占 localStorage 配额）失效时才拉。

## 5. 降级与开关

三道闸，任一关闭都不影响主流程：

1. **能力开关**（`aktools-capabilities.js` 的 `DEFAULT_CAPABILITIES`）：`false` 时 Provider 抛 `AktoolsUnsupportedError`。
2. **业务封装**（`app/api/fund.js` 的 `fetchFundProfileCached`）：捕获异常后返回 `null`，UI 显示「暂未开放」而不是「加载失败」。
3. **UI 层**：每个弹框模块独立 `useQuery`，单个接口失败只影响自己那一屏；调研报告的四个增强段任一为 `null` 就不渲染该段。

业绩排行不走「业务封装吞异常」这一层：它本身就是一份榜单，取不到就该在榜单位置说清楚，`fetchFundRankOpen` 直接抛错，UI 显示「排行加载失败：…」+ 本地缓存命中提示，避免用户误以为是「没有基金经理跑赢」。

调 AKTools 实例时先用探针跑一遍，再决定开关 —— **不要凭文档开开关**。

## 6. 口径与风险（写在给用户的提示里）

- 这些是**披露口径**（季报/年报），天然滞后于行情；`staleNote()` 会在超过 120 天时提示「可能不是最新报告期」。
- 分红「每份金额」由上游「每 10 份派现金」除以 10 折算。
- 管理费/托管费/销售服务费**从基金资产按日计提**，体现在净值里，不是交易时另收的钱；申赎费才与单笔交易相关。
- 同类排名取上游披露的「周期收益同类排名」，仅做参考，不构成买卖建议。
- 持有盈利概率是基于该基金历史净值的统计频率，不是对未来收益的预测。

## 7. 新增一个 AKShare 接口的四步

1. `node scripts/aktools-probe.mjs --only <接口名>`：先确认可用、看到真实列名与行数。
2. `aktools-config.js`：加 `AKTOOLS_ENDPOINTS` 端点名 + `AKTOOLS_CACHE_TTL`。
3. `aktools-mappers.js`：加 mapper，**中文列名 → 领域字段**，缺失返回 `null` 而不是 `0`；顺手加单测。
4. `aktools-provider.js` + `aktools-capabilities.js`：加方法 + 开关（先 `false`，联调通过再 `true`）；最后在 `app/api/fund.js` 加 `fetchFundXxx` 薄封装。

不允许在组件里直接拼 URL 或解析中文列名 —— 那是 provider 的职责。
