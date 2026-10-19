import { describe, expect, it } from 'vitest'
import type { SshInstance } from '@shared/contracts'
import { buildSshArgs } from './ssh-args'

const ISO = '2026-09-15T00:00:00.000Z'

function sshInstance(overrides: Partial<SshInstance> = {}): SshInstance {
  return {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    name: '隧道实例',
    transport: 'ssh',
    authMode: 'auto',
    host: 'dsh.internal',
    port: 22,
    username: 'dev',
    remotePort: 3080,
    localPort: null,
    identityFile: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides
  }
}

describe('buildSshArgs（ 参数库）', () => {
  const ctx = {
    controlPath: '/data/ssh/inst-x.sock',
    knownHostsPath: '/data/ssh/known_hosts'
  }

  it('默认形态：-N -L 转发 + 全显式保活/复用/TOFU 参数', () => {
    const args = buildSshArgs(sshInstance(), 30123, ctx)
    // 核心转发：-N -L <local>:127.0.0.1:<remote>
    const lIndex = args.indexOf('-L')
    expect(args[lIndex + 1]).toBe('30123:127.0.0.1:3080')
    expect(args).toContain('-N')
    const options = args.filter(
      (arg) =>
        arg === '-o' ||
        arg.startsWith('ExitOnForward') ||
        arg.startsWith('ServerAlive') ||
        arg.startsWith('ConnectTimeout') ||
        arg.startsWith('Control') ||
        arg.startsWith('StrictHostKeyChecking') ||
        arg.startsWith('UserKnownHostsFile')
    )
    const optionValues = options.join(' ')
    expect(optionValues).toContain('ExitOnForwardFailure=yes')
    expect(optionValues).toContain('ServerAliveInterval=15')
    expect(optionValues).toContain('ServerAliveCountMax=3')
    expect(optionValues).toContain('ConnectTimeout=10')
    expect(optionValues).toContain('ControlMaster=auto')
    expect(optionValues).toContain('ControlPath=/data/ssh/inst-x.sock')
    // 必须显式 ControlPersist=no:否则用户 ~/.ssh/config 的 controlpersist yes 会注入,

    expect(optionValues).toContain('ControlPersist=no')
    expect(optionValues).toContain('StrictHostKeyChecking=yes')
    expect(optionValues).toContain('UserKnownHostsFile=/data/ssh/known_hosts')
    // 目标主机在队尾
    expect(args[args.length - 1]).toBe('dsh.internal')
  })

  it('默认 22 端口且未指定密钥时省略 -p/-i（交给 ~/.ssh/config，别名模式可用）', () => {
    const args = buildSshArgs(sshInstance(), 30123, ctx)
    expect(args).not.toContain('-p')
    expect(args).not.toContain('-i')
  })

  it('显式非默认端口 / 用户名 / 密钥路径 → 带 -p/-l/-i', () => {
    // 用户真实输入形态:argv 不经 shell,`~` 由 ssh 自己展开(已实测 OpenSSH 支持)。
    const args = buildSshArgs(
      sshInstance({ port: 2222, identityFile: '~/.ssh/id_ed25519' }),
      30123,
      ctx
    )
    expect(args).toContain('-p')
    expect(args[args.indexOf('-p') + 1]).toBe('2222')
    expect(args).toContain('-l')
    expect(args[args.indexOf('-l') + 1]).toBe('dev')
    expect(args).toContain('-i')
    expect(args[args.indexOf('-i') + 1]).toBe('~/.ssh/id_ed25519')
  })

  it('ControlPath 和私有 known_hosts 路径含空格时按 OpenSSH 配置语法转义', () => {
    const args = buildSshArgs(sshInstance(), 30123, {
      controlPath: '/tmp/DSH Hub/ctl-x.sock',
      knownHostsPath: '/tmp/DSH Hub/known_hosts'
    })
    expect(args).toContain('ControlPath=/tmp/DSH\\ Hub/ctl-x.sock')
    expect(args).toContain('UserKnownHostsFile=/tmp/DSH\\ Hub/known_hosts')
  })

  it('argv 不经 shell：host 含特殊字符时仍为单参数（输入已限定字符集）', () => {
    const args = buildSshArgs(sshInstance({ host: 'my-host' }), 30123, ctx)
    expect(args).not.toContain('&&')
    expect(args[args.length - 1]).toBe('my-host')
  })

  it('IPv6 主机（[v6] 剥离后）与方括号内嵌端口不被误拆', () => {
    const args = buildSshArgs(sshInstance({ host: '2001:db8::1', port: 2222 }), 30123, ctx)
    expect(args[args.length - 1]).toBe('2001:db8::1')
    expect(args[args.indexOf('-p') + 1]).toBe('2222')
  })
})
