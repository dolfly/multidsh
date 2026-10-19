import { describe, expect, it } from 'vitest'
import { redactLine, redactSecret, redactUrl } from './redact'

describe('redactUrl（凭据脱敏）', () => {
  it('剥离 ?token= 查询串，只保留 origin 与路径', () => {
    expect(redactUrl('http://127.0.0.1:52300/?token=abc123')).toBe('http://127.0.0.1:52300/')
  })

  it('保留路径但去掉其余查询参数', () => {
    expect(redactUrl('http://127.0.0.1:3080/deep/path?token=xyz&page=2')).toBe(
      'http://127.0.0.1:3080/deep/path'
    )
  })

  it('无查询串的 URL 原样保留', () => {
    expect(redactUrl('http://127.0.0.1:3080/jobs')).toBe('http://127.0.0.1:3080/jobs')
  })

  it('https 与自定义端口同样处理', () => {
    expect(redactUrl('https://gw.example.com:8443/dsh?token=sec')).toBe(
      'https://gw.example.com:8443/dsh'
    )
  })

  it('剥离 URL userinfo、查询串与锚点', () => {
    expect(redactUrl('https://user:s3cr3t@gw.example.com/dsh?token=sec#fragment')).toBe(
      'https://gw.example.com/dsh'
    )
  })

  it('空串与非 URL 文本不变', () => {
    expect(redactUrl('')).toBe('')
    expect(redactUrl('已断开接管')).toBe('已断开接管')
  })

  it('锚点一并剥离', () => {
    expect(redactUrl('http://127.0.0.1:3080/?token=abc#section')).toBe('http://127.0.0.1:3080/')
  })
})

describe('redactLine（日志行脱敏）', () => {
  it('把行内就绪 URL 的 token 打掉', () => {
    expect(redactLine('dsh web: http://127.0.0.1:52300/?token=sec123 已就绪')).toBe(
      'dsh web: http://127.0.0.1:52300/ 已就绪'
    )
  })

  it('多 URL 行全部脱敏', () => {
    expect(redactLine('a http://x/?token=1 b http://y/?token=2 c')).toBe(
      'a http://x/ b http://y/ c'
    )
  })

  it('不含 URL 的行原样返回', () => {
    expect(redactLine('普通日志行，无凭据')).toBe('普通日志行，无凭据')
  })

  it('URL 后紧跟标点也能正确截断（?token= 属于 URL 一部分）', () => {
    expect(redactLine('就绪：http://127.0.0.1:52300/?token=abc。')).toBe(
      '就绪：http://127.0.0.1:52300/。'
    )
  })
})

describe('redactSecret（文件日志凭据形态脱敏）', () => {
  it('键值对形态的密码/OTP/令牌替换值，保留键名', () => {
    expect(redactSecret('login failed password=secret123')).toBe('login failed password=***')
    expect(redactSecret('otp_code=123456 校验失败')).toBe('otp_code=*** 校验失败')
    expect(redactSecret('token: eyJhbGciOi')).toBe('token: ***')
    expect(redactSecret('_authToken=abc123 写入')).toBe('_authToken=*** 写入')
  })

  it('Cookie / Set-Cookie 值被掩掉', () => {
    expect(redactSecret('cookie: dsh_auth=secret-value')).toBe('cookie: ***')
    expect(redactSecret('set-cookie: dsh_auth=abc; path=/')).toBe('set-cookie: ***; path=/')
  })

  it('Authorization 头（Bearer/Basic）值被掩掉', () => {
    expect(redactSecret('request headers Authorization: Bearer xyz.abc')).toBe(
      'request headers Authorization: [REDACTED]'
    )
  })

  it('PEM 私钥块整块替换为占位', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADAN\n-----END PRIVATE KEY-----'
    expect(redactSecret(`颁发失败 ${pem}`)).toBe(
      '颁发失败 -----BEGIN PRIVATE KEY----- [REDACTED] -----END PRIVATE KEY-----'
    )
  })

  it('普通文本与排查信息（状态码/exit code）不受影响', () => {
    expect(redactSecret('HTTP 500 状态码，exit code=1')).toBe('HTTP 500 状态码，exit code=1')
    expect(redactSecret('普通日志行，无凭据')).toBe('普通日志行，无凭据')
  })
})
