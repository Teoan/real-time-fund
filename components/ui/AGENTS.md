# components/ui/ — shadcn/ui Primitives

## OVERVIEW

26 shadcn/ui components (new-york style, JSX, CSS variables). Low-level primitives — several are locally customized, so treat them as vendored forks.

## WHERE TO LOOK

```
accordion.jsx    alert.jsx        badge.jsx        button.jsx
calendar.jsx     command.jsx      dialog.jsx       drawer.jsx
empty.jsx        field.jsx       field.jsx        input.jsx
label.jsx        pagination.jsx   popover.jsx      progress.jsx
radio-group.jsx  select.jsx       separator.jsx    skeleton.jsx
sonner.jsx       spinner.jsx      switch.jsx       tabs.jsx
toggle.jsx       toggle-group.jsx tooltip.jsx
```

## CONVENTIONS

- **Add via CLI**: `npx shadcn@latest add <component>` — new components only; do not overwrite existing files blindly.
- **Style**: new-york, CSS variables enabled, neutral base color (`components.json`, `tsx: false`).
- **Icons**: lucide-react (`aria-hidden` by default since v1).
- **Path aliases**: `@/components/ui/*`, `@/lib/utils` (cn helper).
- **Styling**: tailwind-merge via `cn()` in `lib/utils.js`.
- **本地定制**：`dialog.jsx`（自定义 context / lodash 判断 / CloseIcon）、`drawer.jsx`、`button.jsx`（渐变按钮与 xs/icon-xs）、`sonner.jsx`（直接读 `data-theme`）、`calendar.jsx`（DayPicker v10 的 `month_grid`）均与上游模板不同。

## ANTI-PATTERNS (THIS DIRECTORY)

- **Do not run `shadcn add --overwrite`** — 会覆盖上面的本地定制；升级前先 `git diff` 对照上游。
- **No custom components here** — app-specific components belong in `app/components/`.
- **Do not drop `input-otp` back in** — 已确认全站未使用，2026-11 移除。
