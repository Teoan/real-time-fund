/**
 * 带指数退避的 fetch 封装：自动重试 transient 网络错误。
 *
 * 应用场景：浏览器 fetch 偶发 ERR_EMPTY_RESPONSE / ERR_CONNECTION_RESET /
 * ERR_CONNECTION_CLOSED 等。Chrome 在 HTTP/1.1 keep-alive 长连接下偶发在
 * response body 阶段 RST 而上抛 net::ERR_EMPTY_RESPONSE；浏览器层抛
 * TypeError("Failed to fetch")，真实原因挂在 cause.message。
 *
 * 设计：
 *  - 仅识别 transient 错误并重试；业务错误（HTTP 4xx/5xx）不重试
 *  - AbortError 由 timeout 主动终止，不重试以避免雪崩
 *  - 指数退避：base * 2^attempt（200ms → 400ms → 800ms by default）
 *
 * 用法：
 *   const res = await fetchWithRetry(url, {
 *     timeoutMs: 8000,
 *     retries: 2,
 *     fetchOptions: { method: 'GET, headers: {...} }
 *   });
 */

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 判定 fetch 抛出的异常是否为可重试的瞬时网络错误。
 *
 * @param {unknown} e
 * @returns {boolean}
 */
export const isTransientFetchError = (e) => {
  if (!e || typeof e !== 'object') return false;
  if (e.name === 'AbortError') return false;

  const msg = String(e.message || '');
  if (msg.includes('Failed to fetch')) return true;
  if (msg.includes('NetworkError')) return true;
  if (msg.toLowerCase().includes('network request failed')) return true;

  const causeMsg = String(e.cause?.message || '');
  return (
    causeMsg.includes('ERR_EMPTY_RESPONSE') ||
    causeMsg.includes('ERR_CONNECTION_RESET') ||
    causeMsg.includes('ERR_CONNECTION_CLOSED') ||
    causeMsg.includes('ERR_NETWORK_CHANGED') ||
    causeMsg.includes('ERR_INTERNET_DISCONNECTED') ||
    causeMsg.includes('ERR_NAME_NOT_RESOLVED') ||
    causeMsg.includes('ERR_CONNECTION_TIMED_OUT') ||
    causeMsg.includes('ERR_PROXY_CONNECTION') ||
    causeMsg.includes('ERR_TUNNEL_CONNECTION_FAILED')
  );
};

/**
 * 带超时 + 指数退避重试的 fetch。
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries]
 * @param {number} [options.baseDelayMs]
 * @param {RequestInit} [options.fetchOptions]
 * @param {(attempt:number, error:unknown) => void} [options.onRetry]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_MS;
  const fetchOptions = options.fetchOptions || {};
  const onRetry = typeof options.onRetry === 'function' ? options.onRetry : null;

  if (typeof fetch === 'undefined') {
    throw new TypeError('fetch is not available in this environment');
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
      clearTimeout(timer);
      // 任何 HTTP 响应（含 4xx/5xx）直接返回，不重试
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const transient = isTransientFetchError(e);
      if (!transient || attempt >= retries) {
        break;
      }
      if (onRetry) onRetry(attempt + 1, e);
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

export const __test__ = { DEFAULT_TIMEOUT_MS, DEFAULT_RETRIES, DEFAULT_BASE_MS, sleep };
