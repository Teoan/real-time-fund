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

| 业务能力                  | 实现        | 真实 TopK 联调 |
| ------------------------- | ----------- | -------------- |
| searchFund                | ✅          | ❌ 待联调      |
| getFundDetail             | ✅          | ❌ 待联调      |
| getFundLatestNav          | ✅          | ❌ 待联调      |
| getFundNavHistory         | ✅          | ❌ 待联调      |
| getFundHoldings           | ✅          | ❌ 待联调      |
| 其它（manager / rank 等） | ❌ 暂未实现 | ❌             |

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
