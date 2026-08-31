'use client';
import { useIsMobile } from '@/app/hooks/useIsMobile';

import { useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { AnimatePresence, motion } from 'framer-motion';
import { HelpCircle } from 'lucide-react';
import { CalendarIcon, SettingsIcon, ListIcon } from './Icons';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

export default function UserMenu({
  navbarHeight,
  lastSyncTime,
  isSyncing,
  onSync,
  onOpenSettings,
  onOpenPortfolioEarnings,
  onTutorial,
  onUpdateLog
}) {
  const isMobile = useIsMobile();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target)) {
        setUserMenuOpen(false);
      }
    };
    if (userMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [userMenuOpen]);

  return (
    <>
      <div className="user-menu-container" ref={userMenuRef}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="icon-button user-menu-trigger"
              aria-label="用户菜单"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
            >
              <SettingsIcon width="18" height="18" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>用户菜单</p>
          </TooltipContent>
        </Tooltip>

        <AnimatePresence>
          {userMenuOpen && (
            <motion.div
              className="user-menu-dropdown glass"
              initial={{ opacity: 0, y: -10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              style={{ transformOrigin: 'top right', top: navbarHeight + (isMobile ? -20 : 10) }}
            >
              <div className="user-menu-header">
                <div className="user-info">
                  <span className="user-email">本地用户</span>
                  <span className="user-status">未登录</span>
                  {lastSyncTime && (
                    <span className="muted" style={{ fontSize: '10px', marginTop: 2 }}>
                      同步于 {dayjs(lastSyncTime).format('MM-DD HH:mm')}
                    </span>
                  )}
                </div>
              </div>
              <div className="user-menu-divider" />
              <button
                className="user-menu-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  onOpenPortfolioEarnings?.();
                }}
              >
                <CalendarIcon width="16" height="16" />
                <span>我的收益</span>
              </button>
              <button
                className="user-menu-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  onTutorial?.();
                }}
              >
                <HelpCircle width="16" height="16" />
                <span>使用帮助</span>
              </button>
              <button
                className="user-menu-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  onUpdateLog?.();
                }}
              >
                <ListIcon width="16" height="16" />
                <span>更新日志</span>
              </button>
              <button
                className="user-menu-item"
                disabled={isSyncing}
                onClick={async () => {
                  setUserMenuOpen(false);
                  await onSync?.();
                }}
              >
                {isSyncing ? (
                  <span
                    className="loading-spinner"
                    style={{
                      width: 16,
                      height: 16,
                      border: '2px solid var(--muted)',
                      borderTopColor: 'var(--primary)',
                      borderRadius: '50%',
                      animation: 'spin 1s linear infinite',
                      flexShrink: 0
                    }}
                  />
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0 }}
                  >
                    <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 0 1 1 2.5 8.242" stroke="var(--primary)" />
                    <path d="M12 12v9" stroke="var(--accent)" />
                    <path d="m16 16-4-4-4 4" stroke="var(--accent)" />
                  </svg>
                )}
                <span>{isSyncing ? '同步中...' : '同步'}</span>
              </button>
              <button
                className="user-menu-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  onOpenSettings?.();
                }}
              >
                <SettingsIcon width="16" height="16" />
                <span>设置</span>
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}
