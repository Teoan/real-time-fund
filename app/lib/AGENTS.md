# app/lib/ — Core Utilities

## OVERVIEW

Core utilities: Supabase client, React Query client factory + query keys, trading calendar, valuation time-series.

## WHERE TO LOOK

| File                       | Exports                                                                               | Purpose                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase.js`              | `supabase`, `isSupabaseConfigured`                                                    | Supabase client (or noop fallback). Auth + DB + realtime                                                                               |
| `get-query-client.js`      | `getQueryClient()`                                                                    | Browser singleton `QueryClient` (shared with `QueryClientProviderWrapper`)                                                             |
| `query-keys.js`            | `fundHistory()`, `pingzhongdata()`, …                                                 | Stable TanStack Query keys for `fund.js` / hooks                                                                                       |
| `tradingCalendar.js`       | `loadHolidaysForYear()`, `loadHolidaysForYears()`, `isTradingDay()`                   | Chinese stock market holiday detection via CDN                                                                                         |
| `valuationTimeseries.js`   | `recordValuation()`, `getValuationSeries()`, `clearFund()`, `getAllValuationSeries()` | Fund valuation time-series (localStorage)                                                                                              |
| `idb.js`                   | `idbGet/Set/Delete`, `IDB_STORES`                                                     | Minimal IndexedDB wrapper (stores: fundBasic / fundNav / fundRisk / fundSignal / fundBenchmark). Version bump only adds missing stores |
| `fundVolatility.js`        | `computeVolatilityMetrics()`, `analyzeFundVolatility()`, `normalizeNavSeries()`       | Volatility signal engine — pure math, no I/O (20-day vol, drawdowns, signals, risk score)                                              |
| `fundVolatilityService.js` | `loadFundVolatility()`, `loadNavSeriesWithCache()`                                    | NAV fetch orchestration shared by volatility + metrics panels                                                                          |
| `fundVolatilityCache.js`   | `createFundVolatilityCache()`, `NAV_CACHE_TTL_MS`                                     | Versioned IndexedDB cache for NAV / risk metrics / signals (metrics+signals reused by NAV fingerprint)                                 |
| `fundMetrics.js`           | `computeFundMetrics()`, `alignReturnsByDate()`                                        | 13 risk/return indicators (CAGR, vol, MDD, Sharpe, Sortino, Calmar, IR, Alpha, Beta, VaR, CVaR, win rate, P/L ratio) — pure math       |
| `fundMetricsService.js`    | `loadFundMetrics()`                                                                   | Indicator orchestration: NAV (shared cache) + benchmark → `computeFundMetrics`                                                         |
| `fundBenchmark.js`         | `resolveFundBenchmark()`                                                              | Fund name → benchmark index (CSI300 default / S&P500 / HSI / none for bond)                                                            |
| `fundBenchmarkCache.js`    | `createFundBenchmarkCache()`                                                          | Index daily-close cache keyed by **secid** (shared across funds)                                                                       |
| `fundReport.js`            | `buildFundResearchReport()`, `computeProfileScore()`, `buildReportMarkdown()`         | Rule-based 调研初步报告 from the 13 indicators: 判读分档 / 跨指标组合洞察 / 画像评分 / 数据局限 + Markdown 导出                        |

## CONVENTIONS

- **supabase.js**: creates `createNoopSupabase()` when env vars missing — all auth/DB methods return safe defaults
- **get-query-client.js**: imperative `fetchQuery` / `removeQueries` in `app/api/fund.js` share the same cache as UI `useQuery`
- **tradingCalendar.js**: downloads `chinese-days` JSON from cdn.jsdelivr.net; caches per-year in Map
- **valuationTimeseries.js**: localStorage **按基金分键** `fundValuationTimeseries:{code}`（旧单一大 key 首次读取时自动迁移并删除，见 `storageKeys.js`）；保留最近 5 个交易日、单日 300 点、单源 1200 点
- **fundMetrics.js / fundVolatility.js**: unit is **percent** for returns (0.54 = +0.54%); ratios are dimensionless. Metrics never emit NaN/Infinity — invalid inputs become `null` and the UI shows `--`. `METRICS_WINDOW_TRADING_DAYS` must equal `NAV_RETENTION_DAYS` (asserted in `__tests__/fundMetrics.test.js`)
- **Services take data fetchers by injection** (`fetchHistory` / `fetchBenchmark`) — `app/lib` never imports `app/api/fund.js`, so `node --test` can run the whole orchestration with fake fetchers
- **fundReport.js**: 只做「历史指标判读」，文案不出现买卖建议语义；缺失指标一律不判读（不补 0 分）；`limitations` 与免责声明是报告的固定组成部分。Scores use **ascending-sorted anchor interpolation** — anchors written descending (max drawdown, VaR) must be sorted before interpolating, otherwise deep drawdowns score as best (there is a regression test for this)
- **Tests**: `node --test "app/lib/__tests__/*.test.js"` (no npm script, not run by CI)
- **storageStore 持久层**: 读走内存镜像、写合并到下一个宏任务落盘（实现在 `storagePersist.js`，纯 lodash 依赖、可单测）。任何绕过 `storageStore` 直写 `localStorage` 的模块都拿不到这层收益，也可能读到滞后值——新增 key 必须走 `storageStore`
- **大对象存 IndexedDB**: 由 `storageAsyncKeys.js` 登记（`ASYNC_STORAGE_KEYS` + `ASYNC_STORAGE_KEY_PREFIXES`），经 `storagePersist.js` 的 `asyncBackend`（`idbStorageBackend.js` → `idb.js` 的 `kv` 仓库）落盘。`page.jsx` 必须在首屏那批 `initXxx()` 之前 `await hydrateStorage()`，否则同步读拿到空值；首屏同步读的键不能登记为异步键。后端不可用时自动退回 `localStorage`（行为与迁移前一致）。跨标签页写入由 `BroadcastChannel`（`rtf-storage-writes`，只发 key、不发值）通知，`useSyncManager` 据此 `scheduleSync()`

## ANTI-PATTERNS (THIS DIRECTORY)

- **No error reporting** — all modules silently fail (console.warn at most)
- **localStorage quota not handled** — valuationTimeseries writes without checking available space
- **React Query cache in-memory** — cleared on full page reload unless persisted elsewhere
- **No request cancellation** — JSONP scripts can't be aborted once injected
