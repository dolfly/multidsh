/**
 * 凭据脱敏原语（纯函数，不 import electron）。
 *
 * 本机 dsh 的就绪 URL 形如 `http://127.0.0.1:<port>/?token=<secret>`，
 * `?token=` 是浏览器认证的会话级 bearer 凭据 —— 它只允许在主进程内经
 * `externalAccessUrls`/vault 注入视图，**不得**进入状态事件、系统通知、
 * DOM、日志或审计。本模块是所有「对外文本」的统一脱敏点：
 * - `redactUrl`：剥离完整 URL 的查询串与锚点（保留 origin/path，便于展示）；
 * - `redactLine`：逐行文本中查找内联 URL 并对其脱敏（日志缓冲/detail 用）。
 *
 * 字符串为空/非 URL 形态时原样返回，调用方无需判空。
 */

/** 剥掉查询串与锚点，只保留 `scheme://host[:port]path`。 */
export function redactUrl(raw: string): string {
  if (raw === '') return raw
  try {
    const parsed = new URL(raw)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    // 非完整 URL（相对路径/裸主机名/普通句子）：按最常见的查询串分隔截断。
    const queryIndex = raw.indexOf('?')
    return queryIndex === -1 ? raw : raw.slice(0, queryIndex)
  }
}

/** 行内所有 `http(s)://…` 均经 redactUrl 脱敏（日志行/detail 文案用）。 */
export function redactLine(line: string): string {
  // 句末标点不属于 URL：排除全/半角逗号、句号族、括号，避免「。，！」被吞进匹配。
  return line.replace(/https?:\/\/[^\s,。，；！？、()]+/gi, (match) => redactUrl(match))
}

/** PEM 私钥块 → 占位（落盘日志出现即整块替换） */
const PEM_PRIVATE_KEY =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g

/** Authorization 头（Bearer/Basic）发射值 → 占位 */
const AUTHORIZATION_HEADER = /(\bauthorization\b\s*:\s*)(?:bearer\s+\S+|basic\s+\S+)/gi

/**
 * 键值形态的凭据：`key=value` / `key: value`（key 为已知敏感名）。
 * 值替换为 `***`；key 集合只收录确定意义的凭据名，不收录 `code`，
 * 避免误掩 HTTP 状态码 / `exit code` 等排查信息。
 */
const CREDENTIAL_PAIR =
  /\b((?:password|passwd|pwd|secret|token|access_token|api[_ -]?key|authToken|_authToken|npmToken|otp|totp|otp_code|cookie|set-cookie|session|auth|credential|private_key|client_secret|refresh_token)\b\s*[=:]\s*)[^&\s"'<,;]+/gi

/**
 * 逐行文本中的凭据形态统一脱敏（文件日志用，防护兜底）：
 * 私钥块、Authorization 头、密码/OTP/Cookie/令牌等键值对。
 * 与 audit 的「白名单投影」是两条防线：主进程日志是自由文本，
 * 落盘前必须经本函数把敏感形态打掉（AGENTS.md：日志不得含密码/OTP/Cookie/私钥）。
 */
export function redactSecret(line: string): string {
  return line
    .replace(PEM_PRIVATE_KEY, '-----BEGIN PRIVATE KEY----- [REDACTED] -----END PRIVATE KEY-----')
    .replace(AUTHORIZATION_HEADER, '$1[REDACTED]')
    .replace(CREDENTIAL_PAIR, '$1***')
}
