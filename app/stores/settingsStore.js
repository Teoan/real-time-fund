import { isBoolean, isFunction, isObject, isString } from 'lodash';
import { create } from 'zustand';

/**
 * 本地配置状态 Zustand Store
 */
export const useSettingsStore = create((set) => ({
  tempSeconds: 60,
  containerWidth: 1200,
  showMarketIndexPc: true,
  showMarketIndexMobile: true,
  showGroupFundSearchPc: true,
  showGroupFundSearchMobile: true,
  dynamicStylePc: true,
  dynamicStyleMobile: true,
  showGroupDropdownPc: false,
  showGroupDropdownMobile: false,
  isGroupSummarySticky: false,
  // AKTools 数据源：A 股单股估值走 AKTools (AKShare stock_value_em) 而非东财 push2。
  // 默认 true —— 使用 AKTools 数据源，push2 作为 fallback。
  aktoolsStockFundamentalsEnabled: true,
  // AKTools 服务地址运行时覆盖（设置页可改）。空串 = 用构建期 AKTOOLS_BASE_URL。
  // 校验在 aktools-client.js 的 resolveEffectiveBaseUrl 做（必须 http(s):// 开头），
  // 这里只存原值，避免 store 与 client 各持一份校验逻辑而漂移。
  aktoolsBaseUrl: '',

  setTempSeconds: (val) => set({ tempSeconds: isFunction(val) ? val(useSettingsStore.getState().tempSeconds) : val }),
  setContainerWidth: (val) =>
    set({ containerWidth: isFunction(val) ? val(useSettingsStore.getState().containerWidth) : val }),
  setShowMarketIndexPc: (val) =>
    set({ showMarketIndexPc: isFunction(val) ? val(useSettingsStore.getState().showMarketIndexPc) : val }),
  setShowMarketIndexMobile: (val) =>
    set({
      showMarketIndexMobile: isFunction(val) ? val(useSettingsStore.getState().showMarketIndexMobile) : val
    }),
  setShowGroupFundSearchPc: (val) =>
    set({
      showGroupFundSearchPc: isFunction(val) ? val(useSettingsStore.getState().showGroupFundSearchPc) : val
    }),
  setShowGroupFundSearchMobile: (val) =>
    set({
      showGroupFundSearchMobile: isFunction(val) ? val(useSettingsStore.getState().showGroupFundSearchMobile) : val
    }),
  setDynamicStylePc: (val) =>
    set({ dynamicStylePc: isFunction(val) ? val(useSettingsStore.getState().dynamicStylePc) : val }),
  setDynamicStyleMobile: (val) =>
    set({ dynamicStyleMobile: isFunction(val) ? val(useSettingsStore.getState().dynamicStyleMobile) : val }),
  setShowGroupDropdownPc: (val) =>
    set({
      showGroupDropdownPc: isFunction(val) ? val(useSettingsStore.getState().showGroupDropdownPc) : val
    }),
  setShowGroupDropdownMobile: (val) =>
    set({
      showGroupDropdownMobile: isFunction(val) ? val(useSettingsStore.getState().showGroupDropdownMobile) : val
    }),
  setIsGroupSummarySticky: (val) =>
    set({
      isGroupSummarySticky: isFunction(val) ? val(useSettingsStore.getState().isGroupSummarySticky) : val
    }),
  setAktoolsStockFundamentalsEnabled: (val) =>
    set({
      aktoolsStockFundamentalsEnabled: isFunction(val)
        ? val(useSettingsStore.getState().aktoolsStockFundamentalsEnabled)
        : val
    }),
  setAktoolsBaseUrl: (val) =>
    set({
      aktoolsBaseUrl: isFunction(val) ? val(useSettingsStore.getState().aktoolsBaseUrl) : val
    }),

  /**
   * 从 customSettings 解析并同步配置到 Zustand 状态
   */
  syncFromCustomSettings: (customSettings) => {
    if (!customSettings || !isObject(customSettings)) return;
    try {
      const patch = {};
      const w = customSettings.pcContainerWidth;
      const num = Number(w);
      if (Number.isFinite(num)) {
        const maxWidth =
          typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
            ? 99999
            : typeof window !== 'undefined'
              ? Math.max(window.innerWidth, 2000)
              : 1200;
        patch.containerWidth = Math.min(maxWidth, Math.max(600, num));
      }
      if (isBoolean(customSettings.showMarketIndexPc)) patch.showMarketIndexPc = customSettings.showMarketIndexPc;
      if (isBoolean(customSettings.showMarketIndexMobile))
        patch.showMarketIndexMobile = customSettings.showMarketIndexMobile;
      if (isBoolean(customSettings.showGroupFundSearchPc))
        patch.showGroupFundSearchPc = customSettings.showGroupFundSearchPc;
      if (isBoolean(customSettings.showGroupFundSearchMobile))
        patch.showGroupFundSearchMobile = customSettings.showGroupFundSearchMobile;
      if (isBoolean(customSettings.dynamicStylePc)) patch.dynamicStylePc = customSettings.dynamicStylePc;
      if (isBoolean(customSettings.dynamicStyleMobile)) patch.dynamicStyleMobile = customSettings.dynamicStyleMobile;
      if (isBoolean(customSettings.showGroupDropdownPc)) patch.showGroupDropdownPc = customSettings.showGroupDropdownPc;
      if (isBoolean(customSettings.showGroupDropdownMobile))
        patch.showGroupDropdownMobile = customSettings.showGroupDropdownMobile;
      if (isBoolean(customSettings.aktoolsStockFundamentalsEnabled))
        patch.aktoolsStockFundamentalsEnabled = customSettings.aktoolsStockFundamentalsEnabled;
      // 服务地址按字符串原样同步（trim 与校验都在 client 侧做，避免两处逻辑漂移）
      if (isString(customSettings.aktoolsBaseUrl)) patch.aktoolsBaseUrl = customSettings.aktoolsBaseUrl;

      if (Object.keys(patch).length > 0) {
        set(patch);
      }
    } catch (e) {
      // ignore
    }
  }
}));
