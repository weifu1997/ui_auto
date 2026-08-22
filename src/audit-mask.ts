const SENSITIVE_KEY = /secret|url|token|password|keyword|signature|credential|api[-_]?key|access[-_]?key|private[-_]?key|authorization|cookie|session/i;

/** 审计详情脱敏：键名命中敏感词（secret/url/token/password/keyword/signature/credential/apiKey/accessKey/privateKey/authorization/cookie/session 等）的值一律替换为星号；数组/对象递归处理。 */
export function maskAuditDetail(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => maskAuditDetail(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, maskAuditDetail(childValue, childKey)]));
  }
  return SENSITIVE_KEY.test(key) ? "******" : value;
}
