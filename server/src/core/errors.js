export class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (msg = '请求参数有误', code = 'bad_request') => new AppError(400, code, msg);
export const unauthorized = (msg = '登录状态已失效，请重新登录', code = 'unauthorized') => new AppError(401, code, msg);
export const forbidden = (msg = '没有权限执行该操作', code = 'forbidden') => new AppError(403, code, msg);
export const notFound = (msg = '资源不存在', code = 'not_found') => new AppError(404, code, msg);
export const conflict = (msg = '资源冲突', code = 'conflict') => new AppError(409, code, msg);
export const tooMany = (msg = '操作过于频繁，请稍后再试', code = 'rate_limited') => new AppError(429, code, msg);
export const upstream = (msg = '上游服务异常', code = 'upstream_error', extra) => new AppError(502, code, msg, extra);

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
