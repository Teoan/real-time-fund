/**
 * TopK (AKTools) HTTP Client
 *
 * 单一职责：构造 fetch、注入超时/重试、把 AKTools 返回的 DataFrame JSON
 * 标准化为合法 JSON（NaN/NaT → null、numpy 数字 → number）。
 *
 * 业务层不直接调用 fetch，统一走 client.call(fn, params)。
 */

import {
  FundNotFoundError,
  TopKApiError,
  TopKError,
  TopKParseError,
  TopKRateLimitError,
  TopKTimeoutError,
  TopKUnavailableError
} from './topk-errors.js';
import { TOPK_BASE_URL, TOPK_REQUEST_RETRIES, TOPK_REQUEST_TIMEOUT_MS } from './topk-config.js';

const _isNil = (v) => v == null;

/**
 * 规范化 AKShare DataFrame → JSON 过程中出现的非法值。
 *
 * @param {*} value
 * @returns {*}
 */
const sanitizeAkShareValue = (value) => {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'string') {
    if (value === '' || value.toLowerCase() === 'nan' || value.toLowerCase() === 'nat') {
      return null;
    }
    // TopK / AKShare 响应偶发包含控制字符（实测 fund_open_fund_daily_em ~3.5MB 后出现），
    // 直接 JSON.parse 会抛 Invalid control character；这里 strip 掉除 \n \r \t 之外的控制字符。
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) {
      return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeAkShareValue);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeAkShareValue(v);
    }
    return out;
  }
  return value;
};

/**
 * 递归深拷贝（处理 Date / RegExp / 自定义对象），便于后续序列化为纯 JSON。
 */
const deepCloneJsonSafe = (value) => {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(deepCloneJsonSafe);
  if (value instanceof RegExp) return value.toString();
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = deepCloneJsonSafe(v);
  }
  return out;
};

/**
 * 构造带超时的 fetch。
 */
const fetchWithTimeout = async (url, { timeoutMs, signal, ...rest } = {}) => {
  if (typeof fetch === 'undefined') {
    throw new TopKUnavailableError('当前环境无 fetch', { code: 'NO_FETCH' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: signal || controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new TopKTimeoutError(`TopK 请求超时 (${timeoutMs}ms): ${url}`);
    }
    throw new TopKUnavailableError(`TopK 网络错误: ${e?.message || e}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 在重试失败时抛出归一化的 TopK 错误。
 */
const wrapFinalError = (err, url) => {
  if (err instanceof TopKError) return err;
  return new TopKUnavailableError(`TopK 调用失败: ${err?.message || err}`, { cause: err });
};

const buildUrl = (baseUrl, fn, params) => {
  const cleanParams = {};
  if (_isNil(params)) {
    return `${baseUrl.replace(/\/+$/, '')}/${fn}`;
  }
  for (const [k, v] of Object.entries(params)) {
    if (_isNil(v)) continue;
    if (typeof v === 'boolean') {
      cleanParams[k] = v ? 'true' : 'false';
    } else {
      cleanParams[k] = String(v);
    }
  }
  const qs = new URLSearchParams(cleanParams).toString();
  const base = `${baseUrl.replace(/\/+$/, '')}/${fn}`;
  return qs ? `${base}?${qs}` : base;
};

/**
 * 创建 TopK 客户端。
 * 可注入 baseUrl 以便测试（默认从环境变量 / 常量读取）。
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries]
 * @returns {{ call: (fn: string, params?: object) => Promise<any>, healthCheck: () => Promise<object> }}
 */
export function createTopKClient(options = {}) {
  const baseUrl = options.baseUrl || TOPK_BASE_URL;
  const timeoutMs = options.timeoutMs ?? TOPK_REQUEST_TIMEOUT_MS;
  const retries = options.retries ?? TOPK_REQUEST_RETRIES;

  const call = async (fn, params) => {
    if (!fn || typeof fn !== 'string') {
      throw new TopKApiError('TopK 调用必须提供 AKShare 函数名', { status: 0 });
    }
    const url = buildUrl(baseUrl, fn, params);
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchWithTimeout(url, { timeoutMs });
        if (res.status === 429) {
          throw new TopKRateLimitError(`TopK 限流: ${url}`);
        }
        if (res.status === 404) {
          throw new FundNotFoundError(`TopK 接口不存在或基金不存在: ${url}`);
        }
        if (!res.ok) {
          throw new TopKApiError(`TopK HTTP ${res.status}: ${url}`, { status: res.status });
        }

        let json;
        try {
          json = await res.json();
        } catch (e) {
          throw new TopKParseError(`TopK 响应不是合法 JSON: ${url}`, { cause: e });
        }

        // AKTools 返回顶层通常为 { success: true, data: [...] }，部分接口直接返回数组。
        const payload = Array.isArray(json) ? json : (json?.data ?? json);
        const sanitized = sanitizeAkShareValue(payload);

        // 空数组不抛错，让调用方按业务决定（搜索返回 [] / 详情抛 FundNotFound）。
        return deepCloneJsonSafe(sanitized);
      } catch (e) {
        lastErr = e;
        // 不可重试的错误：超时/限流/能力不支持/接口不存在/解析失败
        if (
          e instanceof TopKTimeoutError ||
          e instanceof TopKRateLimitError ||
          e instanceof FundNotFoundError ||
          e instanceof TopKParseError
        ) {
          throw e;
        }
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    throw wrapFinalError(lastErr, url);
  };

  /**
   * 简单健康检查：调用 AKShare 通用 list 接口测量延迟。
   */
  const healthCheck = async () => {
    const start = Date.now();
    try {
      await call('fund_name_em');
      return { available: true, latency: Date.now() - start, checkedAt: new Date().toISOString() };
    } catch (e) {
      return {
        available: false,
        latency: Date.now() - start,
        checkedAt: new Date().toISOString(),
        error: e instanceof TopKError ? e.message : String(e?.message || e)
      };
    }
  };

  return { call, healthCheck, baseUrl };
}

export const __test__ = {
  sanitizeAkShareValue,
  buildUrl
};
