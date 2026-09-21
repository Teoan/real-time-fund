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

| 业务能力                  | 实现        | 真实 TopK 联调                  |
| ------------------------- | ----------- | ------------------------------- |
| searchFund                | ✅          | ❌ 待联调                       |
| getFundDetail             | ✅          | ✅ 2026-09-13                   |
| getFundLatestNav          | ✅          | ❌ 待联调                       |
| getFundNavHistory         | ✅          | ❌ 待联调                       |
| getFundHoldings           | ✅          | ❌ 待联调                       |
| getStockFundamentals      | ✅          | ✅ 2026-09（stock_value_em）    |
| getStockRoe               | ✅          | ✅ 2026-09-19（新浪财务指标）   |
| getStockHkFinancial       | ✅          | ✅ 2026-09-19（港股财务指标）   |
| getStockHkValueHistory    | ✅          | ✅ 2026-09-20（亿牛网估值历史） |
| 其它（manager / rank 等） | ❌ 暂未实现 | ❌                              |

## 港股持仓穿透（getStockHkFinancial / getStockHkValueHistory）

- **getStockHkFinancial**：AKShare `stock_hk_financial_indicator_em`，取「股东权益回报率(%)」作为港股 ROE。
  东财 F10 主要财务指标不覆盖港股，故这是港股 ROE 的唯一来源。
- **getStockHkValueHistory**：AKShare `stock_hk_indicator_eniu`（亿牛网），取市盈率 / 市净率历史序列，用于港股 PE/PB 历史分位。
  业务层只传领域字段名 `pe` / `pb`，上游中文指标名在 `topk-config.js` 的 `TOPK_HK_VALUATION_INDICATORS` 中映射；
  代码需补零为 5 位并加 `hk` 前缀（`00700` → `hk00700`）。
- **实测（2026-09-20）**：financial 200 / ~0.7KB / ~0.15s；indicator_eniu 200 / ~140~190KB / 6~18s（较慢）。

### ⚠️ 已知限制：eniu 港股数据止于 2022-07-13

亿牛网已下线港股个股页面（`eniu.com/gu/hk00700` 返回「未收录此股票」），AKShare 只能返回存档数据 ——
实测 00700 / 09988 / 00939 / 03690 的 PE、PB 序列**最后日期均为 2022-07-13**。

配合「近 5 年」分位窗口，港股 PE/PB 分位实际基于 **2021-09 ~ 2022-07** 的区间，
即用 2026 年的当前值与 4 年前的估值窗口比较，存在系统性偏差（这是选型时已知并接受的取舍）。

- 若需要新鲜数据，应改用 `stock_hk_valuation_baidu`（数据到当日，但 2004 起仅 ~626 行、密度低）。
  两源口径一致（304 个重合交易日，相关系数 0.967，均值 41.95 vs 41.45），也可合并使用。
- `stock_hk_indicator_eniu` 的「市销率」返回字段实为 `market_value`（市值）而非 PS 比率，不可用于 `psPercentile`。
- 该接口单次 6~18s，`app/api/fund.js` 的 `calculateHoldingsPercentiles` 已用 `asyncPool(4)` 并发预取，
  且序列经 `topk-daily-cache.js` 做**天级 localStorage 缓存**（键 `topk:hkValueHistory:{symbol}:{pe|pb}`）：
  首次加载约 20~30s，当日再次打开直接命中缓存、不再发请求。
  缓存只写入参与分位计算的近 5 年窗口（~200 行/指标），避免 4000 行全量（约 2.8MB）占满 localStorage 配额。

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

未设置时使用 `http://topk.xyz/api/public`（占位默认值，生产前必须替换）。

## 运行测试

```
node --test app/providers/topk/__tests__/
```

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
