/**
 * 日志脱敏：**"绝不打印凭据"这条铁律的最后一道防线**。
 *
 * 用法：任何要写进日志/异常信息的对象，先过一遍 `redactForLog`。
 * 为什么用**键名黑名单**而不是值匹配：值匹配要猜格式（AK 前缀、长度），
 * 而"这个字段叫 accessKeySecret"是确定的；两者都做会互相掩盖，只留确定的那个。
 */

/**
 * 敏感键判定。两条规则合起来用，缺一个都会出问题：
 * - **长词按子串**（`secret`/`token`/`credential`… 拼在 `appSecret`、`security_token` 里也认）
 * - **短词按分段精确匹配**（`ak`/`sk`/`pwd` 这类两字母缩写只能整段比）
 *
 * 为什么必须分段：早期实现把 `sk` 当子串，结果 `skipped`/`tasks`/`skew` 全被打成 `***REDACTED***`
 * —— 脱敏过度会把正常数据藏起来（2026-10-02 在 sync 日志里实测踩到：`"skipped":"***REDACTED***"`）。
 */
const LONG_SENSITIVE_RE = /(secret|token|password|passwd|credential|signature|privatekey|private_key|accesskey|access_key)/i;
const SHORT_SENSITIVE_SEGMENTS = new Set(['ak', 'sk', 'pwd', 'key', 'secret', 'token', 'sign', 'sig']);

function isSensitiveKey(key: string): boolean {
  if (LONG_SENSITIVE_RE.test(key)) return true;
  return key
    .split(/[^A-Za-z0-9]+/)
    .filter((seg) => seg !== '')
    .some((seg) => SHORT_SENSITIVE_SEGMENTS.has(seg.toLowerCase()));
}

/** 命中敏感键名时替换成的占位符（保留长度信息，便于排查"配了没配"） */
export const REDACTED = '***REDACTED***';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 递归脱敏：敏感键 → `***REDACTED***`（但保留 `null`/空串的原样，便于区分"没配"）。
 * 深度上限 8，防环（日志脱敏不能把进程拖死）。
 */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return '***MAX_DEPTH***';
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveKey(k)) {
      out[k] = v === '' || v === null || v === undefined ? v : REDACTED;
    } else {
      out[k] = redactForLog(v, depth + 1);
    }
  }
  return out;
}

/** 日志里序列化上下文：脱敏 + 单行 + 失败兜底（日志本身绝不能抛） */
export function logSafeJson(value: unknown): string {
  try {
    return JSON.stringify(redactForLog(value));
  } catch (err) {
    return `"<unserializable: ${err instanceof Error ? err.message : String(err)}>"`;
  }
}

/** 文本脱敏：把 URL 里的签名参数、明显的 AK 形态抹掉（用于把第三方 stderr 塞进日志前） */
export function redactText(text: string): string {
  return text
    .replace(/(Signature|Expires|OSSAccessKeyId|security-token)=[^&\s"']+/gi, '$1=***REDACTED***')
    .replace(/\bLTAI[0-9A-Za-z]{6,}\b/g, 'LTAI***REDACTED***');
}
