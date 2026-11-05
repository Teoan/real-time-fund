'use client';

import { useDeferredValue, useEffect, useState } from 'react';
import { CalendarDays, HelpCircle, List, RefreshCw, SearchIcon, Settings } from 'lucide-react';
import { isArray } from 'lodash';

import { searchFunds } from '@/app/api/fund';
import { useModalStore } from '@/app/stores';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from '@/components/ui/command';

const SEARCH_DEBOUNCE_MS = 250;
// 命令面板关闭到下一个弹框打开之间留出退出动画/焦点回归时间，否则非模态 Dialog 会被 focus-outside 立即关闭
const ACTION_DELAY_MS = 250;

/**
 * 全局命令面板（⌘K / Ctrl+K）。
 *
 * - 基金搜索：复用 searchFunds（东方财富 suggest），选中后走 page.jsx 的
 *   handleCommandAddFund → 现有 ScanImportConfirmModal 流程。
 * - 快捷操作：设置 / 我的收益 / 使用帮助 / 更新日志 / 同步。
 *
 * 状态归 modalStore（commandOpen），本组件只负责渲染与快捷键。
 */
export default function CommandPalette({ open, onOpenChange, callbacksRef }) {
  const [term, setTerm] = useState('');
  const deferredTerm = useDeferredValue(term);
  const [funds, setFunds] = useState([]);
  const [searching, setSearching] = useState(false);

  // ⌘K / Ctrl+K 全局切换
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (String(event.key || '').toLowerCase() !== 'k') return;
      event.preventDefault();
      const { commandOpen } = useModalStore.getState();
      useModalStore.setState({ commandOpen: !commandOpen });
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 关闭后清空，避免下次打开残留旧搜索
  useEffect(() => {
    if (open) return;
    setTerm('');
    setFunds([]);
    setSearching(false);
  }, [open]);

  // 基金搜索（防抖 + 取消过期请求）
  useEffect(() => {
    const keyword = String(deferredTerm || '').trim();
    if (keyword.length < 2) {
      setFunds([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      searchFunds(keyword)
        .then((list) => {
          if (!cancelled) setFunds(isArray(list) ? list : []);
        })
        .catch(() => {
          if (!cancelled) setFunds([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deferredTerm]);

  const handleAddFund = (fund) => {
    const code = String(fund?.CODE ?? fund?.code ?? '').trim();
    if (!code) return;
    const name = String(fund?.NAME ?? fund?.name ?? '').trim();
    onOpenChange?.(false);
    setTimeout(() => {
      if (useModalStore.getState().commandOpen) return;
      callbacksRef.current?.handleCommandAddFund?.({ code, name });
    }, ACTION_DELAY_MS);
  };

  const runQuickAction = (action) => {
    onOpenChange?.(false);
    setTimeout(() => {
      if (useModalStore.getState().commandOpen) return;
      if (action.id === 'sync') {
        callbacksRef.current?.handleSyncLocalConfig?.();
        return;
      }
      action.run?.();
    }, ACTION_DELAY_MS);
  };

  const quickActions = [
    {
      id: 'settings',
      label: '打开设置',
      hint: '偏好、数据与显示',
      icon: Settings,
      run: () => useModalStore.setState({ settingsOpen: true })
    },
    {
      id: 'earnings',
      label: '我的收益',
      hint: '收益日历',
      icon: CalendarDays,
      run: () => useModalStore.setState({ portfolioEarningsOpen: true })
    },
    {
      id: 'tutorial',
      label: '使用帮助',
      hint: '教程与常见问题',
      icon: HelpCircle,
      run: () => useModalStore.setState({ tutorialDrawerOpen: true })
    },
    {
      id: 'update-log',
      label: '更新日志',
      hint: '版本变更',
      icon: List,
      run: () => useModalStore.setState({ updateLogOpen: true })
    },
    {
      id: 'sync',
      label: '同步数据',
      hint: '与云端同步',
      icon: RefreshCw
    }
  ];

  const keyword = String(term || '').trim();
  const showSearchHint = keyword.length > 0 && keyword.length < 2;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="命令面板"
      description="搜索基金或执行快捷操作"
      overlayClassName="!z-[13000]"
      className="glass command-palette !z-[13010] max-w-[560px] border-[var(--border)]"
    >
      <CommandInput placeholder="搜索基金名称/代码，或输入操作…" value={term} onValueChange={setTerm} autoFocus />
      <CommandList>
        <CommandEmpty>
          {showSearchHint ? '输入至少 2 个字符搜索基金' : searching ? '搜索中…' : '未找到相关基金'}
        </CommandEmpty>

        {funds.length > 0 && (
          <CommandGroup heading="基金">
            {funds.slice(0, 8).map((fund) => {
              const code = String(fund?.CODE ?? fund?.code ?? '');
              const name = String(fund?.NAME ?? fund?.name ?? '');
              const type = String(fund?.TYPE ?? fund?.CATEGORYDESC ?? '');
              return (
                <CommandItem key={code || name} value={`${code} ${name} ${type}`} onSelect={() => handleAddFund(fund)}>
                  <SearchIcon />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{name || code}</span>
                    <span className="text-[11px] text-muted-foreground">
                      #{code}
                      {type ? ` · ${type}` : ''}
                    </span>
                  </div>
                  <CommandShortcut>添加</CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {searching && funds.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">搜索中…</div>}

        {funds.length > 0 && <CommandSeparator />}

        <CommandGroup heading="快捷操作">
          {quickActions.map((action) => {
            const Icon = action.icon;
            return (
              <CommandItem
                key={action.id}
                value={`${action.label} ${action.hint}`}
                onSelect={() => runQuickAction(action)}
              >
                <Icon />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{action.label}</span>
                  <span className="text-[11px] text-muted-foreground">{action.hint}</span>
                </div>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>

      <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        <span>↑↓ 选择 · ↵ 打开 · esc 关闭</span>
        <span>⌘K / Ctrl+K</span>
      </div>
    </CommandDialog>
  );
}
