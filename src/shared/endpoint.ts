/**
 * 端点地址解析与归一化。
 *
 * transport（local / ssh / http）与 auth（none / gateway / browser-auth）是正交的两维，
 * 无论选哪种传输，最终都会归约到一个端点 URL —— 本模块只负责「用户输入 → 归一化端点」，
 * 不涉及传输与认证，因此不 import electron，主进程 / 渲染进程 / 测试三处复用同一份实现。
 */

export type EndpointScheme = 'http' | 'https'

/** 解析失败的原因码；UI 据此选择文案，不直接展示本模块的 message。 */
export type EndpointErrorCode =
  | 'empty'
  | 'unsupported-scheme'
  | 'missing-host'
  | 'malformed'
  | 'credentials-not-allowed'
  | 'query-not-supported'
  | 'hash-not-supported'
  | 'invalid-port'

const DEFAULT_PORT: Record<EndpointScheme, number> = { http: 80, https: 443 }

export class EndpointParseError extends Error {
  readonly code: EndpointErrorCode
  readonly input: string

  /**
   * `message` 一律为**静态文案**，绝不回显 `input`：
   * 消息会经 IPC 错误信封 / 表单校验进入渲染层，可被展示、复制或写进日志；
   * 而用户可能把 `http://user:s3cr3t@` 这类内嵌凭据的地址粘进来。
   * 原始输入只保留在结构化字段 `input`（内部排查用），原因由稳定 `code` 表达。
   */
  constructor(code: EndpointErrorCode, input: string, message: string) {
    super(message)
    this.name = 'EndpointParseError'
    this.code = code
    this.input = input
  }
}

export interface Endpoint {
  /** 完整来源，如 `http://127.0.0.1:3080`；不含路径、不含结尾斜杠 */
  origin: string
  scheme: EndpointScheme
  /** 主机名；IPv6 去掉方括号，已小写 */
  host: string
  /** 主机 + 非默认端口；IPv6 保留方括号。用于 `ssh -L` 的远端目标拼接 */
  hostport: string
  /** 端口；显式写出默认端口时会被 WHATWG URL 归一化掉 */
  port: number
  /** 归一化路径，根路径为 `/`；反代到子路径时非 `/` */
  pathname: string
  /** origin + pathname，无结尾斜杠；所有请求与隧道的基准地址 */
  baseUrl: string
}

/**
 * 解析用户输入的端点地址。
 *
 * 接受的形态：`127.0.0.1:3080`、`dsh.internal`、`https://gw.example.com/dsh/`、`http://[::1]:3080`。
 * 省略协议时按 `http://` 补全（dsh 本地与内网部署默认明文，加密交给 SSH 隧道）。
 *
 * 判定顺序：先协议、后主机 —— `ftp://x` 报 unsupported-scheme 而不是 missing-host；
 * 形如 `host:port`（冒号后为 1–5 位数字）不视为协议前缀。
 *
 * @throws {EndpointParseError} 输入非法时抛出，`code` 为稳定原因码
 */
export function parseEndpointUrl(raw: string): Endpoint {
  const input = typeof raw === 'string' ? raw.trim() : ''
  if (input === '') {
    throw new EndpointParseError('empty', input, '端点地址不能为空')
  }

  // ---- 1) 协议判定 ----
  let scheme: EndpointScheme | null = null
  let rest = input
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(input)
  if (schemeMatch) {
    scheme = normalizeScheme(input, schemeMatch[1] ?? '')
    rest = input.slice(schemeMatch[0].length)
  } else {
    const colon = input.indexOf(':')
    if (colon !== -1) {
      const candidate = input.slice(0, colon)
      const after = input.slice(colon + 1)
      // `dsh.internal:3080`、`localhost:3000/path` 的冒号前缀不是协议：
      // 冒号后以数字开头（可能带路径/尾斜杠）一律按 host:port 处理，
      // 端口合法性交给 WHATWG URL 与后续边界检查判定；
      // 冒号后非数字开头（如 `mailto:x`）按协议处理，报 unsupported-scheme。
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(candidate) && !/^\d/.test(after)) {
        scheme = normalizeScheme(input, candidate)
        rest = after
      }
    }
  }
  if (scheme === null) scheme = 'http'

  // ---- 2) 主机判空 ----
  // 不能交给 `new URL` 报错：`http://` 抛的是笼统的 ERR_INVALID_URL，
  // 而 `http:///p` 会被它悄悄解析成主机 `p`。这里统一判为缺主机，更可预测。
  const authority = /^([^/?#]*)/.exec(rest)?.[1] ?? ''
  if (authority === '') {
    // 不回显 input：`http:///user:s3cr3t@` 会把凭据片段带进消息。
    throw new EndpointParseError('missing-host', input, '端点地址缺少主机名')
  }

  // ---- 3) 交给 WHATWG URL 做最终解析与归一 ----
  let url: URL
  try {
    url = new URL(`${scheme}://${rest}`)
  } catch {
    // 同上：`http://user:s3cr3t@` 会走这里，绝不能回显 input。
    throw new EndpointParseError('malformed', input, '无法解析端点地址')
  }

  if (url.username !== '' || url.password !== '') {
    throw new EndpointParseError('credentials-not-allowed', input, '端点地址不能内嵌用户名或密码')
  }
  if (url.search !== '') {
    throw new EndpointParseError('query-not-supported', input, '端点地址不支持查询参数')
  }
  if (url.hash !== '') {
    throw new EndpointParseError('hash-not-supported', input, '端点地址不支持锚点')
  }

  const bracketed = url.hostname.startsWith('[') && url.hostname.endsWith(']')
  const host = (bracketed ? url.hostname.slice(1, -1) : url.hostname).toLowerCase()
  if (host === '') {
    throw new EndpointParseError('missing-host', input, '端点地址缺少主机名')
  }

  const defaultPort = DEFAULT_PORT[scheme]
  const port = url.port === '' ? defaultPort : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    // 同理不回显：`url.port` 虽是纯数字，仍属用户输入的一部分，统一按静态文案处理
    throw new EndpointParseError('invalid-port', input, '端口不合法')
  }

  const shownHost = bracketed ? `[${host}]` : host
  const hostport = port === defaultPort ? shownHost : `${shownHost}:${port}`
  const origin = `${scheme}://${hostport}`
  const pathname = normalizePathname(url.pathname)

  return {
    origin,
    scheme,
    host,
    hostport,
    port,
    pathname,
    baseUrl: pathname === '/' ? origin : `${origin}${pathname}`
  }
}

function normalizeScheme(input: string, raw: string): EndpointScheme {
  const scheme = raw.toLowerCase()
  if (scheme === 'http' || scheme === 'https') return scheme
  // `raw` 是用户在协议位写下的任意 token（如 `mysecret:` 会被当协议），
  // 因此消息不回显它，只给静态文案。
  throw new EndpointParseError('unsupported-scheme', input, '仅支持 http / https 协议')
}

export type ParseEndpointResult =
  { ok: true; endpoint: Endpoint } | { ok: false; code: EndpointErrorCode; message: string }

/** 表单校验用的不抛异常版本。 */
export function tryParseEndpoint(raw: string): ParseEndpointResult {
  try {
    return { ok: true, endpoint: parseEndpointUrl(raw) }
  } catch (error) {
    if (error instanceof EndpointParseError) {
      return { ok: false, code: error.code, message: error.message }
    }
    throw error
  }
}

/** 实例判重：归一化后 baseUrl 相同即视为同一端点 */
export function isSameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.baseUrl === b.baseUrl
}

/**
 * 直连 HTTP 端点使用明文数据连接，调用方据此显示警告。
 * 省略协议的地址按 http 补全，同样视为明文；
 * HTTPS 与解析失败一律返回 false（失败不告警，避免误报）。
 */
export function isCleartextEndpoint(endpointUrl: string): boolean {
  const parsed = tryParseEndpoint(endpointUrl)
  return parsed.ok && parsed.endpoint.scheme === 'http'
}

/**
 * 是否为回环地址（即「就在本机」）。
 * 用于判断 http 传输是否指向本地、以及是否该提示「本机实例更适合用 local 传输」。
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost')) return true
  // 127.0.0.0/8，含 `127.1` 这类省略写法
  return /^127(\.\d{1,3}){1,3}$/.test(h)
}

function normalizePathname(pathname: string): string {
  const stripped = pathname.replace(/\/+$/, '')
  if (stripped === '') return '/'
  return stripped.startsWith('/') ? stripped : `/${stripped}`
}
