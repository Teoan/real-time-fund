import { create } from 'zustand';

/**
 * 本地用户状态 store。
 * 登录功能已移除，user 恒为 null；保留 store 仅供 useSyncManager 等历史代码引用，
 * userId 由 CloudConfigModal 手动输入，不再依赖 session。
 */
export const useUserStore = create((set) => ({
  user: null,
  setUser: (next) => set({ user: next }),
  clearUser: () => set({ user: null })
}));
