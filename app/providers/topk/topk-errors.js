/**
 * TopK Provider 错误模型
 *
 * 业务层只感知这些错误类，绝不直接接触 fetch/JSON.parse 抛出的原始异常。
 *
 * - TopKUnavailableError: 网络失败 / DNS / CORS / 服务不可达
 * - TopKTimeoutError:    请求超时
 * - TopKRateLimitError:  429 / 上游限流
 * - TopKParseError:      响应解析失败（DataFrame → JSON 中 NaN/NaT 已转 null）
 * - TopKUnsupportedError: Provider 不支持该能力
 * - TopKApiError:        HTTP 4xx/5xx 或 AKTools 返回业务失败
 * - FundNotFoundError:   接口返回 200 但内容为空（基金代码不存在）
 */

export class TopKError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    if (options.cause) this.cause = options.cause;
    if (options.code) this.code = options.code;
  }
}

export class TopKUnavailableError extends TopKError {}
export class TopKTimeoutError extends TopKError {}
export class TopKRateLimitError extends TopKError {}
export class TopKParseError extends TopKError {}
export class TopKUnsupportedError extends TopKError {}
export class TopKApiError extends TopKError {
  constructor(message, options = {}) {
    super(message, options);
    if (options.status != null) this.status = options.status;
  }
}
export class FundNotFoundError extends TopKError {}

export { TopKError as default };
