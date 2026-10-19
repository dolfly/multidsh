import { readFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bareHost,
  evaluateHostTrust,
  formatKnownHostsLines,
  hostTargetLabel,
  knownHostsHostField,
  parseResolvedSshTarget,
  parseKeyscan,
  parseKnownHosts,
  publicKeyFingerprint,
  recordHostTrust,
  toFingerprints
} from './host-trust'

const ED25519_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIL/GqayzeH4ALFQzq7BrQ4lodGaiDICVgULWk7rQZ4iw'
const OTHER_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-trust-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('host-trust（TOFU 纯逻辑）', () => {
  it('known_hosts 主机字段:22 端口用裸主机,其他端口用 [host]:port', () => {
    expect(knownHostsHostField('dsh.internal', 22)).toBe('dsh.internal')
    expect(knownHostsHostField('dsh.internal', 2222)).toBe('[dsh.internal]:2222')
  })

  it('SHA256 指纹与 ssh-keygen 一致', () => {
    expect(publicKeyFingerprint(ED25519_BLOB)).toBe(
      'SHA256:WVEaUHwlYk84FEWb7QvPJ5ptvpPwIbrN3GIrwvt32RM'
    )
    expect(publicKeyFingerprint('not-base64')).toMatch(/^SHA256:/)
  })

  it('解析 SSH 别名的实际主机和端口，供 TOFU 与 ssh 保持一致', () => {
    const target = parseResolvedSshTarget(
      ['host vsgp', 'hostname 108.61.187.89', 'port 2222'].join('\n'),
      { host: 'vsgp', port: 22 }
    )
    expect(target).toEqual({ host: '108.61.187.89', port: 2222 })
  })

  it('实际目标解析异常字段时回退到实例输入', () => {
    expect(parseResolvedSshTarget('hostname\nport invalid', { host: 'vsgp', port: 22 })).toEqual({
      host: 'vsgp',
      port: 22
    })
  })

  it('解析 ssh-keyscan 输出(跳过注释行,去重)', () => {
    const stdout = [
      '# 127.0.0.1:32222 SSH-2.0-OpenSSH_10.3',
      `[127.0.0.1]:32222 ssh-ed25519 ${ED25519_BLOB}`,
      `[127.0.0.1]:32222 ssh-ed25519 ${ED25519_BLOB}`,
      ''
    ].join('\n')
    const parsed = parseKeyscan(stdout)
    expect(parsed).toEqual([{ type: 'ssh-ed25519', blob: ED25519_BLOB }])
  })

  it('解析 known_hosts 条目(支持逗号多主机名,忽略注释)', () => {
    const content = [
      '# comment',
      `[dsh.internal]:2222 ssh-ed25519 ${ED25519_BLOB}`,
      `other.host ssh-rsa AAAAother`,
      ''
    ].join('\n')
    const parsed = parseKnownHosts(content, '[dsh.internal]:2222')
    expect(parsed).toEqual([{ type: 'ssh-ed25519', blob: ED25519_BLOB }])
    expect(parseKnownHosts(content, 'not-there')).toEqual([])
  })

  it('信任判定:命中=trusted;未见过=unknown;同类型不同值=changed', () => {
    const scanned = [{ type: 'ssh-ed25519', blob: ED25519_BLOB }]
    expect(evaluateHostTrust(scanned, scanned).verdict).toBe('trusted')
    expect(evaluateHostTrust([], scanned).verdict).toBe('unknown')
    const changed = evaluateHostTrust([{ type: 'ssh-ed25519', blob: OTHER_BLOB }], scanned)
    expect(changed.verdict).toBe('changed')
    expect(changed.mismatched).toEqual([{ type: 'ssh-ed25519', blob: OTHER_BLOB }])
    // 已信任密钥「不再出示」(类型消失/轮换)同样告警,并给出旧条目供 UI 展示
    const rotated = evaluateHostTrust([{ type: 'ssh-rsa', blob: 'AAAA' }], scanned)
    expect(rotated.verdict).toBe('changed')
    expect(rotated.mismatched).toEqual([{ type: 'ssh-rsa', blob: 'AAAA' }])
  })

  it('formatKnownHostsLines 生成可写入的 known_hosts 行', () => {
    expect(
      formatKnownHostsLines('[h]:2222', [{ type: 'ssh-ed25519', blob: ED25519_BLOB }])
    ).toEqual([`[h]:2222 ssh-ed25519 ${ED25519_BLOB}`])
  })

  it('toFingerprints 输出 UI 展示用类型+指纹', () => {
    const fps = toFingerprints([{ type: 'ssh-ed25519', blob: ED25519_BLOB }])
    expect(fps[0]?.typeLabel).toBe('ED25519')
    expect(fps[0]?.fingerprint).toBe(publicKeyFingerprint(ED25519_BLOB))
  })

  // Windows 文件系统没有 POSIX mode 位;known_hosts 的 0600 语义仅 POSIX 可验证
  it.skipIf(process.platform === 'win32')(
    'recordHostTrust:append 追加并去重,replace 轮换旧行',
    async () => {
      const path = join(dir, 'known_hosts')
      const hostField = '[h]:2222'
      await recordHostTrust(
        path,
        hostField,
        [{ type: 'ssh-ed25519', blob: ED25519_BLOB }],
        'append'
      )
      // 幂等追加
      await recordHostTrust(
        path,
        hostField,
        [{ type: 'ssh-ed25519', blob: ED25519_BLOB }],
        'append'
      )
      let content = await readFile(path, 'utf8')
      expect(content.trim().split('\n')).toHaveLength(1)

      // 轮换:旧行被替换
      await recordHostTrust(path, hostField, [{ type: 'ssh-ed25519', blob: OTHER_BLOB }], 'replace')
      content = await readFile(path, 'utf8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(OTHER_BLOB)
      // 权限 0600(仅当前用户可读)
      const mode = (await stat(path)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  )

  it('hostTargetLabel:22 端口不显示端口号', () => {
    expect(hostTargetLabel('h', 22)).toBe('h')
    expect(hostTargetLabel('h', 2222)).toBe('h:2222')
  })

  it('bracketed IPv6 的裸主机/known_hosts 字段一致性(两端口形态)', () => {
    expect(bareHost('[::1]')).toBe('::1')
    expect(bareHost('[2001:db8::1]')).toBe('2001:db8::1')
    // 22 端口写裸主机;非 22 端口写 [host]:port(known_hosts 规范形态)
    expect(knownHostsHostField('[::1]', 22)).toBe('::1')
    expect(knownHostsHostField('[::1]', 2222)).toBe('[::1]:2222')
    // keyscan 输出解析后的查询字段与写入字段一致(bareHost 先去括号再组装)
    expect(knownHostsHostField(bareHost('[2001:db8::1]'), 22)).toBe('2001:db8::1')
    expect(knownHostsHostField(bareHost('[2001:db8::1]'), 2222)).toBe('[2001:db8::1]:2222')
  })
})
