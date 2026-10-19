import { describe, expect, it } from 'vitest'
import {
  EndpointParseError,
  isLoopbackHost,
  isSameEndpoint,
  parseEndpointUrl,
  tryParseEndpoint,
  type EndpointErrorCode
} from './endpoint'

/** 取失败原因码；成功则让测试失败并给出可读原因 */
function codeOf(input: string): string {
  try {
    parseEndpointUrl(input)
  } catch (error) {
    if (error instanceof EndpointParseError) return error.code
    throw error
  }
  throw new Error(`期望解析失败，但 ${JSON.stringify(input)} 解析成功了`)
}

/** 取解析失败的错误对象；成功则让测试失败并给出可读原因 */
function parseErrorOf(input: string): EndpointParseError {
  try {
    parseEndpointUrl(input)
  } catch (error) {
    if (error instanceof EndpointParseError) return error
    throw error
  }
  throw new Error(`期望解析失败，但 ${JSON.stringify(input)} 解析成功了`)
}

/**
 * 覆盖每一类解析失败的输入。
 * 类型是 `Record<EndpointErrorCode, string>`：新增错误码而不补样例会直接编译失败。
 */
const BRANCH_INPUTS: Record<EndpointErrorCode, string> = {
  empty: '   ',
  'unsupported-scheme': 'ftp://user:s3cr3t@dsh.example.com',
  'missing-host': 'http:///user:s3cr3t@',
  malformed: 'http://user:s3cr3t@',
  'credentials-not-allowed': 'http://user:s3cr3t@127.0.0.1:3080',
  'query-not-supported': 'http://127.0.0.1:3080/?token=s3cr3t',
  'hash-not-supported': 'http://127.0.0.1:3080/#s3cr3t',
  'invalid-port': 'http://127.0.0.1:0'
}

describe('parseEndpointUrl / 正常输入', () => {
  it('解析带显式端口与协议的地址', () => {
    expect(parseEndpointUrl('http://127.0.0.1:3080')).toEqual({
      origin: 'http://127.0.0.1:3080',
      scheme: 'http',
      host: '127.0.0.1',
      hostport: '127.0.0.1:3080',
      port: 3080,
      pathname: '/',
      baseUrl: 'http://127.0.0.1:3080'
    })
  })

  it('省略协议时按 http 补全', () => {
    expect(parseEndpointUrl('127.0.0.1:3080').baseUrl).toBe('http://127.0.0.1:3080')
  })

  it('省略协议的主机名（内网域名）按 http 补全', () => {
    const endpoint = parseEndpointUrl('dsh.internal:3080')
    expect(endpoint.scheme).toBe('http')
    expect(endpoint.host).toBe('dsh.internal')
    expect(endpoint.port).toBe(3080)
  })

  it('host:port 带尾斜杠或子路径时不被误判为协议', () => {
    expect(parseEndpointUrl('localhost:3000/').baseUrl).toBe('http://localhost:3000')
    const withPath = parseEndpointUrl('dsh.internal:3080/path')
    expect(withPath.host).toBe('dsh.internal')
    expect(withPath.port).toBe(3080)
    expect(withPath.pathname).toBe('/path')
    expect(withPath.baseUrl).toBe('http://dsh.internal:3080/path')
  })

  it('https 未写端口时补 443，且不写进 hostport', () => {
    const endpoint = parseEndpointUrl('https://dsh.example.com')
    expect(endpoint.port).toBe(443)
    expect(endpoint.hostport).toBe('dsh.example.com')
    expect(endpoint.origin).toBe('https://dsh.example.com')
  })

  it('显式写出的默认端口被归一化掉（不产生两种写法）', () => {
    expect(parseEndpointUrl('http://dsh.example.com:80').baseUrl).toBe('http://dsh.example.com')
    expect(parseEndpointUrl('https://dsh.example.com:443').baseUrl).toBe('https://dsh.example.com')
  })

  it('协议与主机名大小写归一化', () => {
    const endpoint = parseEndpointUrl('HTTP://DSH.Example.COM:3080')
    expect(endpoint.scheme).toBe('http')
    expect(endpoint.host).toBe('dsh.example.com')
    expect(endpoint.baseUrl).toBe('http://dsh.example.com:3080')
  })

  it('去掉首尾空白与结尾斜杠', () => {
    expect(parseEndpointUrl('  http://dsh.example.com:3080  ').baseUrl).toBe(
      'http://dsh.example.com:3080'
    )
    expect(parseEndpointUrl('http://dsh.example.com:3080///').pathname).toBe('/')
  })

  it('保留反代子路径并去掉其结尾斜杠', () => {
    const endpoint = parseEndpointUrl('https://gw.example.com/dsh/')
    expect(endpoint.pathname).toBe('/dsh')
    expect(endpoint.baseUrl).toBe('https://gw.example.com/dsh')
  })

  it('IPv6 字面量：host 去方括号，hostport 保留', () => {
    const withPort = parseEndpointUrl('http://[::1]:3080')
    expect(withPort.host).toBe('::1')
    expect(withPort.hostport).toBe('[::1]:3080')
    expect(withPort.origin).toBe('http://[::1]:3080')

    const withoutPort = parseEndpointUrl('https://[2001:db8::1]')
    expect(withoutPort.port).toBe(443)
    expect(withoutPort.hostport).toBe('[2001:db8::1]')
  })
})

describe('parseEndpointUrl / 非法输入', () => {
  it('空输入与纯空白判为 empty', () => {
    expect(codeOf('')).toBe('empty')
    expect(codeOf('   ')).toBe('empty')
  })

  it('非 http(s) 协议判为 unsupported-scheme', () => {
    expect(codeOf('ftp://dsh.example.com')).toBe('unsupported-scheme')
    expect(codeOf('file:///tmp/dsh')).toBe('unsupported-scheme')
    expect(codeOf('mailto:x')).toBe('unsupported-scheme')
  })

  it('缺主机判为 missing-host', () => {
    expect(codeOf('http://')).toBe('missing-host')
    expect(codeOf('http:///only-path')).toBe('missing-host')
  })

  it('内嵌用户名密码判为 credentials-not-allowed', () => {
    expect(codeOf('http://user:secret@127.0.0.1:3080')).toBe('credentials-not-allowed')
    expect(codeOf('http://token@127.0.0.1:3080')).toBe('credentials-not-allowed')
  })

  it('查询参数与锚点一律拒绝', () => {
    expect(codeOf('http://127.0.0.1:3080/?token=abc')).toBe('query-not-supported')
    expect(codeOf('http://127.0.0.1:3080/#/home')).toBe('hash-not-supported')
  })

  it('端口 0 判为 invalid-port', () => {
    expect(codeOf('http://127.0.0.1:0')).toBe('invalid-port')
  })

  it('超长端口与带路径的超界端口交给 URL 判定为 malformed', () => {
    expect(codeOf('dsh.internal:3080123')).toBe('malformed')
    expect(codeOf('example.com:65536/x')).toBe('malformed')
  })

  it('端口越界与畸形地址判为 malformed', () => {
    expect(codeOf('http://127.0.0.1:70000')).toBe('malformed')
    expect(codeOf('http://[::1')).toBe('malformed')
  })

  it('抛出的错误携带稳定 code 与原始输入', () => {
    try {
      parseEndpointUrl('ftp://dsh.example.com')
      throw new Error('期望抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(EndpointParseError)
      const parseError = error as EndpointParseError
      expect(parseError.code).toBe('unsupported-scheme')
      expect(parseError.input).toBe('ftp://dsh.example.com')
      expect(parseError.name).toBe('EndpointParseError')
    }
  })
})

describe('parseEndpointUrl / 错误消息不回显输入', () => {
  it('内嵌凭据的地址不会把用户名/密码带进 message', () => {
    const hostile = [
      'http://user:s3cr3t@',
      'http://user:s3cr3t@/',
      'http:///user:s3cr3t@',
      'http://user:s3cr3t@127.0.0.1:3080'
    ]
    for (const input of hostile) {
      const error = parseErrorOf(input)
      expect(error.message, input).not.toContain('s3cr3t')
      expect(error.message, input).not.toContain('user:')
      expect(error.message, input).not.toContain(input.trim())
      // 结构化字段保留（内部排查用），只有 message 停止回显
      expect(error.input, input).toBe(input.trim())
    }
    // 稳定的 code 不因「不回显」而改变
    expect(parseErrorOf('http://user:s3cr3t@').code).toBe('malformed')
    expect(parseErrorOf('http://user:s3cr3t@/').code).toBe('malformed')
    expect(parseErrorOf('http:///user:s3cr3t@').code).toBe('missing-host')
    expect(parseErrorOf('http://user:s3cr3t@127.0.0.1:3080').code).toBe('credentials-not-allowed')
  })

  it('穷尽枚举：每一个解析失败分支的 message 都不含该分支的输入', () => {
    for (const [code, input] of Object.entries(BRANCH_INPUTS)) {
      const error = parseErrorOf(input)
      expect(error.code, input).toBe(code)
      expect(error.input, input).toBe(input.trim())
      expect(error.message, input).not.toContain('s3cr3t')
      const trimmed = input.trim()
      // 空输入的 trim 是 ''（includes('') 恒真），无片段可回显，跳过该断言
      if (trimmed !== '') expect(error.message, input).not.toContain(trimmed)
    }
  })

  it('同一错误码的 message 与输入无关（静态文案）', () => {
    // malformed：正常畸形输入与内嵌凭据输入给出同一句静态文案
    expect(parseErrorOf('http://user:s3cr3t@').message).toBe(parseErrorOf('http://[::1').message)
    // missing-host：同上（`http:///…` 与 `http://`）
    expect(parseErrorOf('http:///s3cr3t@').message).toBe(parseErrorOf('http://').message)
    // unsupported-scheme：协议位上的任意 token（可能恰是用户口令）同样不进 message
    expect(parseErrorOf('ftp://a').message).toBe(parseErrorOf('mysecret:x').message)
    expect(parseErrorOf('mysecret:x').message).not.toContain('mysecret')
  })

  it('tryParseEndpoint（Wizard 表单直接展示 message）同样不回显输入', () => {
    const result = tryParseEndpoint('http://user:s3cr3t@')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('malformed')
      expect(result.message).not.toContain('s3cr3t')
      expect(result.message).not.toContain('user:')
    }
  })
})

describe('tryParseEndpoint', () => {
  it('成功时返回 ok + endpoint', () => {
    const result = tryParseEndpoint('127.0.0.1:3080')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.endpoint.baseUrl).toBe('http://127.0.0.1:3080')
  })

  it('失败时返回 ok=false + code，不抛异常', () => {
    const result = tryParseEndpoint('ftp://dsh.example.com')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unsupported-scheme')
      expect(result.message).not.toBe('')
    }
  })
})

describe('isSameEndpoint', () => {
  it('默认端口与省略写法的端点视为同一个', () => {
    expect(
      isSameEndpoint(
        parseEndpointUrl('http://DSH.example.com:80'),
        parseEndpointUrl('dsh.example.com')
      )
    ).toBe(true)
  })

  it('不同端口或不同子路径视为不同端点', () => {
    expect(
      isSameEndpoint(
        parseEndpointUrl('http://dsh.example.com'),
        parseEndpointUrl('http://dsh.example.com:3080')
      )
    ).toBe(false)
    expect(
      isSameEndpoint(
        parseEndpointUrl('https://gw.example.com/dsh'),
        parseEndpointUrl('https://gw.example.com')
      )
    ).toBe(false)
  })
})

describe('isLoopbackHost', () => {
  it('识别回环写法', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.1.2.3',
      '127.1',
      '::1',
      '[::1]',
      'dsh.localhost'
    ]) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
  })

  it('不把远端地址与监听通配地址当作回环', () => {
    for (const host of [
      'dsh.example.com',
      '10.0.0.1',
      '192.168.1.9',
      '0.0.0.0',
      '::',
      '127.0.0.1.example.com'
    ]) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })
})
