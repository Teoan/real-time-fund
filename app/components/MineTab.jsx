'use client';

import Image from 'next/image';
import { ChevronRight, QrCode } from 'lucide-react';

export default function MineTab({
  visible = true,
  lastSyncDisplay,
  onMyEarnings,
  onTutorial,
  onUpdateLog,
  onFeedback,
  onSponsorSupport,
  onOpenWeChat
}) {
  return (
    <div className="mine-tab" style={{ display: visible ? undefined : 'none' }} aria-hidden={!visible || undefined}>
      <section className="mine-profile-card glass" aria-label="个人信息" style={{ position: 'relative' }}>
        <div className="mine-profile-row">
          <div className="mine-profile-avatar">
            <span className="mine-profile-avatar-fallback muted">?</span>
          </div>
          <div className="mine-profile-text">
            <>
              <div className="mine-profile-title">本地用户</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                数据保存在本机
              </div>
            </>
          </div>
        </div>
        <a
          className="ocr-quota-badge"
          style={{
            position: 'absolute',
            bottom: 12,
            right: 12,
            cursor: 'pointer',
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4
          }}
          onClick={onOpenWeChat}
        >
          <QrCode size={14} />
          加入微信用户支持群
        </a>
      </section>

      <ul className="mine-menu-list" role="list">
        <li>
          <button type="button" className="mine-menu-row glass" onClick={onMyEarnings}>
            <span className="mine-menu-label">我的收益</span>
            <ChevronRight className="mine-menu-chevron" aria-hidden strokeWidth={2} />
          </button>
        </li>
        <li>
          <button type="button" className="mine-menu-row glass" onClick={onTutorial}>
            <span className="mine-menu-label">使用帮助</span>
            <ChevronRight className="mine-menu-chevron" aria-hidden strokeWidth={2} />
          </button>
        </li>
        <li>
          <button type="button" className="mine-menu-row glass" onClick={onUpdateLog}>
            <span className="mine-menu-label">更新日志</span>
            <ChevronRight className="mine-menu-chevron" aria-hidden strokeWidth={2} />
          </button>
        </li>
        <li>
          <button type="button" className="mine-menu-row glass" onClick={onFeedback}>
            <span className="mine-menu-label">问题反馈</span>
            <ChevronRight className="mine-menu-chevron" aria-hidden strokeWidth={2} />
          </button>
        </li>
        <li>
          <button type="button" className="mine-menu-row glass" onClick={onSponsorSupport}>
            <span className="mine-menu-label">赞助支持</span>
            <ChevronRight className="mine-menu-chevron" aria-hidden strokeWidth={2} />
          </button>
        </li>
      </ul>
    </div>
  );
}
