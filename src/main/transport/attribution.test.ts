import { describe, expect, it } from 'vitest'
import { userInfo } from 'node:os'
import { classifySshExit } from './attribution'

describe('classifySshExit（ 退出归因）', () => {
  it('鉴权失败 → auth（含 stderr 证据）', () => {
    // ssh 的鉴权失败提示形如 `<user>@<host>: Permission denied`;用户名取自当前环境。
    const result = classifySshExit(
      255,
      `${userInfo().username}@dsh.internal: Permission denied (publickey).`
    )
    expect(result.kind).toBe('auth')
    expect(result.message).toContain('鉴权失败')
    expect(result.message).toContain('Permission denied')
  })

  it('主机名解析失败 → resolve', () => {
    const result = classifySshExit(
      255,
      'ssh: Could not resolve hostname no-such-host: nodename nor servname provided'
    )
    expect(result.kind).toBe('resolve')
    expect(result.message).toContain('主机名解析失败')
  })

  it('连接拒绝 → connect', () => {
    const result = classifySshExit(255, 'ssh: connect to host 10.0.0.1 port 22: Connection refused')
    expect(result.kind).toBe('connect')
    expect(result.message).toContain('连接被拒绝')
  })

  it('连接超时 → timeout', () => {
    const result = classifySshExit(
      255,
      'ssh: connect to host 10.0.0.1 port 22: Operation timed out'
    )
    expect(result.kind).toBe('timeout')
  })

  it('端口转发失败 → forward', () => {
    const result = classifySshExit(
      255,
      'Warning: remote port forwarding failed for listen port 3080'
    )
    expect(result.kind).toBe('forward')
    expect(result.message).toContain('端口转发失败')
  })

  it('本地 -L 绑定失败 → forward（）', () => {
    expect(classifySshExit(255, 'Could not request local forwarding.').kind).toBe('forward')
    expect(classifySshExit(255, 'bind [127.0.0.1]:30000: Address already in use').kind).toBe(
      'forward'
    )
  })

  it('远端关闭 → closed', () => {
    const result = classifySshExit(0, 'Connection to dsh.internal closed by remote host.')
    expect(result.kind).toBe('closed')
  })

  it('code=0 无特征 → closed 正常退出', () => {
    const result = classifySshExit(0, '')
    expect(result.kind).toBe('closed')
  })

  it('code=255 无特征 → unknown（保留 code 与证据）', () => {
    const result = classifySshExit(255, '')
    expect(result.kind).toBe('unknown')
    expect(result.message).toContain('code=255')
  })

  it('stderr 证据截断到 280 字符', () => {
    const long = `x\n${'y'.repeat(400)}`
    const result = classifySshExit(255, `Permission denied (publickey).\n${long}`)
    expect(result.message.length).toBeLessThanOrEqual(320)
  })
})
