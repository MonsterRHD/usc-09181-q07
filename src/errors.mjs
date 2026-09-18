/**
 * 业务规则冲突时抛出的错误。code 用于 HTTP 状态映射与审计，detail 给审核员/调用方解释依据。
 */
export class DomainError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.detail = detail;
  }
}

export const fail = (code, message, detail) => {
  throw new DomainError(code, message, detail);
};
