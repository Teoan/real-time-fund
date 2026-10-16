# app/components/ — UI Components

## OVERVIEW

47 app-specific React components (all client-side). Modals dominate (~26). Core display: FundCard, PcFundTable, MobileFundTable.

## STRUCTURE

```
app/components/
├── Core Display (6)
│   ├── FundCard/index.jsx      # Individual fund card. `layoutMode='drawer'` renders the 基金详情
│   │                           #   dialog/drawer tabs: 前10重仓 / 估值分析 / 波动 / 指标 /
│   │                           #   业绩走势 / 估值走势 / 我的收益  (tab strip is overflow-x-auto)
│   ├── FundVolatilityPanel.jsx # 波动信号 panel (self-fetching; collapsed by default in card mode)
│   ├── FundMetricsPanel.jsx    # 指标 panel — 13 risk/return indicators; only mounted in the 指标 tab
│   │                           #   hosts the 调研初步报告 entry button (opens FundResearchReportModal)
│   ├── FundResearchReportModal.jsx # 调研初步报告 dialog — renders app/lib/fundReport.js output + copy Markdown
│   ├── PcFundTable.jsx         # Desktop table layout
│   ├── MobileFundTable.jsx     # Mobile list with swipe actions
│   ├── MobileFundCardDrawer.jsx# Mobile fund detail drawer
│   ├── GroupSummary.jsx        # Group portfolio summary
│   └── MarketIndexAccordion.jsx# Market indices (24 A/HK/US)
├── Modals (26)
│   ├── Fund ops: AddFundToGroupModal, GroupManageModal, GroupModal
│   ├── Trading: TradeModal, HoldingEditModal, HoldingActionModal, TransactionHistoryModal, PendingTradesModal, DcaModal, AddHistoryModal
│   ├── Settings: SettingsModal, MarketSettingModal, MobileSettingModal, PcTableSettingModal, SortSettingModal
│   ├── Auth: LoginModal, CloudConfigModal
│   ├── Scan: ScanPickModal, ScanProgressModal, ScanImportConfirmModal, ScanImportProgressModal
│   └── Misc: ConfirmModal, SuccessModal, DonateModal, FeedbackModal, WeChatModal, UpdatePromptModal, FundHistoryNetValueModal,
│             FundResearchReportModal (low-frequency → dynamic import, state in modalStore.fundReportModal)
├── Charts (3)
│   ├── FundIntradayChart.jsx   # Intraday valuation chart (localStorage data)
│   ├── FundTrendChart.jsx      # Fund trend chart (pingzhongdata)
│   └── FundHistoryNetValue.jsx # Historical NAV display
└── Utilities (7)
    ├── Icons.jsx               # Custom SVG icons (Close, Eye, Moon, Sun, etc.)
    ├── Common.jsx              # Shared UI helpers
    ├── FitText.jsx             # Auto-fit text sizing
    ├── RefreshButton.jsx       # Manual refresh control
    ├── EmptyStateCard.jsx      # Empty state placeholder
    ├── Announcement.jsx        # Banner announcement
    ├── ThemeColorSync.jsx      # Theme meta tag sync
    ├── PwaRegister.jsx         # Service worker registration
    └── AnalyticsGate.jsx       # Conditional GA loader
```

## CONVENTIONS

- **All client components** — `'use client'` at top, no server components
- **State from parent** — page.jsx manages ALL state; components receive props only
- **shadcn/ui primitives** — imported from `@/components/ui/*`
- **Mobile/Desktop switching** — parent passes `isMobile` prop; 640px breakpoint
- **Modals**: use `useBodyScrollLock(open)` hook for scroll prevention
- **Icons**: mix of custom SVG (Icons.jsx) + lucide-react
- **Styling**: glassmorphism via CSS variables (globals.css), no component-level CSS
- **Nested dialog over 基金详情**: when adding a dialog opened *from inside* the fund detail, register its `modalStore` key in `isAnySubModalOpen` (PcFundTable / MarketTab `FundDetailDialog`) so the detail dialog isn't closed along with it; the mobile drawer already ignores pointer-down on `[data-slot="dialog-content"], [data-slot="dialog-overlay"]`
- **Self-fetching enhancement panels**: `FundVolatilityPanel` / `FundMetricsPanel` / `FundValuationHistory` call their own hook (`useFundVolatility` / `useFundMetrics`) instead of receiving data through page.jsx props. Analytics panels inside FundCard drawer tabs need no `enabled` flag — Radix unmounts inactive `TabsContent`, so data loads only when the tab is opened

## ANTI-PATTERNS (THIS DIRECTORY)

- **No prop drilling avoidance** — all state flows from page.jsx via props (30+ prop holes in FundCard)
- **Modal sprawl** — 26 modals could benefit from a modal manager/context
- **Swipe gesture duplication** — MobileFundTable and MobileFundCardDrawer both implement swipe logic
- **No loading skeletons** — components show spinners, not skeleton placeholders
