import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VAULT_POLICY, createVault } from './vault'
import type { StoredSession, VaultCrypto } from './vault'

/** 可用的假加密后端(可逆的 base64 标记,便于断言「落盘不是明文」) */
function fakeCrypto(available = true): VaultCrypto {
  return {
    isAvailable: () => available,
    encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (payload) => {
      if (!payload.startsWith('enc:')) throw new Error('密文损坏')
      return Buffer.from(payload.slice(4), 'base64').toString('utf8')
    }
  }
}

const SESSION: StoredSession = {
  name: 'dsh_auth',
  value: 'sess-secret',
  expiresAt: 1_790_000_000_000
}

const BOTH = { rememberPassword: true, rememberSession: true }

let dir: string
let filePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-vault-'))
  filePath = join(dir, 'vault', 'credentials.json')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

async function optIn(
  overrides: Partial<typeof BOTH> = {},
  available = true
): Promise<ReturnType<typeof createVault>> {
  const vault = createVault({ filePath, crypto: fakeCrypto(available) })
  await vault.setPolicy('i1', { ...BOTH, ...overrides })
  return vault
}

describe('vault（ 凭据存储策略）', () => {
  it('默认不存条目，但默认策略会保存密码并复用会话', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto() })
    expect(vault.status()).toEqual({ available: true, degraded: false, instanceCount: 0 })
    expect(vault.getPolicy('i1')).toEqual({ rememberPassword: true, rememberSession: true })
    expect(DEFAULT_VAULT_POLICY).toEqual({ rememberPassword: true, rememberSession: true })
    expect(vault.getPassword('i1')).toBeNull()
    expect(vault.getSession('i1')).toBeNull()
    expect(vault.rememberedIds()).toEqual([])
  })

  it('默认策略可保存凭据；显式取消后拒绝落盘', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto() })
    await vault.rememberPassword('i-default', 'hunter2')
    expect(vault.getPassword('i-default')).toBe('hunter2')
    await vault.setPolicy('i1', { rememberPassword: false, rememberSession: false })
    await expect(vault.rememberPassword('i1', 'hunter2')).rejects.toThrow()
    await expect(vault.rememberSession('i1', SESSION)).rejects.toThrow()
    expect(vault.rememberedIds()).toEqual(['i-default'])
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).toContain('i-default')
  })

  it('勾选后:密码 记住 → 读回 → 清除', async () => {
    const vault = await optIn()
    expect(vault.hasPassword('i1')).toBe(false)
    await vault.rememberPassword('i1', 'hunter2')
    expect(vault.hasPassword('i1')).toBe(true)
    expect(vault.getPassword('i1')).toBe('hunter2')
    await vault.forgetPassword('i1')
    expect(vault.hasPassword('i1')).toBe(false)
    expect(vault.getPassword('i1')).toBeNull()
  })

  it('勾选后:会话 Cookie 记住 → 读回(含 expiresAt)→ 清除', async () => {
    const vault = await optIn()
    await vault.rememberSession('i1', SESSION)
    expect(vault.hasSession('i1')).toBe(true)
    expect(vault.getSession('i1')).toEqual(SESSION)
    await vault.forgetSession('i1')
    expect(vault.getSession('i1')).toBeNull()
  })

  it('落盘内容是密文(绝不出现明文密码/会话值)', async () => {
    const vault = await optIn()
    await vault.rememberPassword('i1', 'hunter2')
    await vault.rememberSession('i1', SESSION)

    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('sess-secret')
    expect(raw).toContain('enc:')
    const parsed = JSON.parse(raw) as { version: number; items: Record<string, unknown> }
    expect(parsed.version).toBe(1)
    expect(Object.keys(parsed.items)).toEqual(['i1'])
  })

  // Windows 文件系统没有 POSIX mode 位,0600 语义仅在 POSIX 平台可验证
  it.skipIf(process.platform === 'win32')('落盘文件权限为 0600', async () => {
    const vault = await optIn()
    await vault.rememberPassword('i1', 'hunter2')
    const info = await stat(filePath)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('重启后:条目与勾选策略都还在(落盘 → 新实例加载)', async () => {
    const first = await optIn()
    await first.rememberPassword('i1', 'hunter2')
    await first.rememberSession('i1', SESSION)

    const second = createVault({ filePath, crypto: fakeCrypto() })
    expect(second.getPassword('i1')).toBe('hunter2')
    expect(second.getSession('i1')).toEqual(SESSION)
    expect(second.getPolicy('i1')).toEqual(BOTH)
  })

  it('外部本机 dsh token 加密落盘并在重启后可读，且不依赖网关密码策略', async () => {
    const first = createVault({ filePath, crypto: fakeCrypto() })
    await first.rememberExternalAccessToken('i1', 'external-token')
    expect(first.getExternalAccessToken('i1')).toBe('external-token')
    expect(await readFile(filePath, 'utf8')).not.toContain('external-token')

    const restarted = createVault({ filePath, crypto: fakeCrypto() })
    expect(restarted.getExternalAccessToken('i1')).toBe('external-token')
    await restarted.forgetExternalAccessToken('i1')
    expect(restarted.getExternalAccessToken('i1')).toBeNull()
  })

  it('取消勾选必须真的忘掉(不只是停止「继续记住」)', async () => {
    const vault = await optIn()
    await vault.rememberPassword('i1', 'hunter2')
    await vault.rememberSession('i1', SESSION)

    await vault.setPolicy('i1', { rememberPassword: false, rememberSession: true })
    expect(vault.getPassword('i1')).toBeNull()
    expect(vault.getSession('i1')).toEqual(SESSION)

    await vault.setPolicy('i1', { rememberPassword: false, rememberSession: false })
    expect(vault.getSession('i1')).toBeNull()
    expect(vault.getPolicy('i1')).toEqual({ rememberPassword: false, rememberSession: false })
    expect(DEFAULT_VAULT_POLICY).toEqual({ rememberPassword: true, rememberSession: true })
    expect(vault.rememberedIds()).toEqual([])

    // 落盘文件里也不再有密文
    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain('enc:')
  })

  it('safeStorage 不可用 → 降级为纯内存且不落盘', async () => {
    const vault = await optIn({}, false)
    expect(vault.status()).toEqual({ available: false, degraded: true, instanceCount: 0 })
    await vault.rememberPassword('i1', 'hunter2')
    expect(vault.getPassword('i1')).toBe('hunter2') // 本会话可用
    // 关键:降级模式绝不把明文写到磁盘
    await expect(readFile(filePath, 'utf8')).rejects.toThrow()
  })

  it('降级模式下另一实例(模拟重启)读不到内容', async () => {
    const vault = await optIn({}, false)
    await vault.rememberPassword('i1', 'hunter2')
    const restarted = createVault({ filePath, crypto: fakeCrypto(false) })
    expect(restarted.getPassword('i1')).toBeNull()
  })

  it('解密失败只丢该条目,不影响其它实例', async () => {
    const vault = await optIn()
    await vault.setPolicy('i2', BOTH)
    await vault.rememberPassword('i1', 'p1')
    await vault.rememberPassword('i2', 'p2')

    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      items: Record<string, { password: string }>
    }
    parsed.items['i1']!.password = 'garbage'
    await writeFile(filePath, JSON.stringify(parsed))

    const errors: unknown[] = []
    const reopened = createVault({
      filePath,
      crypto: fakeCrypto(),
      onError: (error) => errors.push(error)
    })
    expect(reopened.getPassword('i1')).toBeNull()
    expect(errors).toHaveLength(1)
    expect(reopened.getPassword('i2')).toBe('p2')
    expect(reopened.rememberedIds()).toEqual(['i2'])

    // 读路径不写盘:坏条目只是从内存里丢掉,文件由下一次显式写入收敛
    const stillTampered = JSON.parse(await readFile(filePath, 'utf8')) as {
      items: Record<string, { password: string }>
    }
    expect(stillTampered.items['i1']?.password).toBe('garbage')
    await reopened.forgetPassword('i2')
    const converged = JSON.parse(await readFile(filePath, 'utf8')) as {
      items: Record<string, unknown>
    }
    expect(converged.items).toEqual({})
  })

  it('坏文件(非 JSON / 版本不符)视为空,不抛异常', async () => {
    await mkdir(join(dir, 'vault'), { recursive: true })
    await writeFile(filePath, 'not json at all')
    const errors: unknown[] = []
    const vault = createVault({
      filePath,
      crypto: fakeCrypto(),
      onError: (error) => errors.push(error)
    })
    expect(vault.rememberedIds()).toEqual([])
    expect(errors).toHaveLength(1)

    await writeFile(filePath, JSON.stringify({ version: 99, items: { i1: {} } }))
    const other = createVault({ filePath, crypto: fakeCrypto(), onError: () => undefined })
    expect(other.rememberedIds()).toEqual([])
  })

  it('JSON 损坏文件被隔离后下次写盘重建干净文件', async () => {
    // 且 vault 永远起不来 —— 现在坏文件必须被改名隔离、随后由下一次 persist 重建
    await mkdir(join(dir, 'vault'), { recursive: true })
    const corrupt = '{"version":1,"items":{"i1":{"session":"enc:abc"}}}\n{"version":1,"items":{}}\n'
    await writeFile(filePath, corrupt)
    const errors: unknown[] = []
    const vault = createVault({
      filePath,
      crypto: fakeCrypto(),
      onError: (error) => errors.push(error)
    })
    // load 是惰性的:首次读取才触发解析与隔离
    expect(vault.rememberedIds()).toEqual([])
    expect(errors.length).toBeGreaterThanOrEqual(1)

    // 损坏文件已隔离(不再占用正式路径),目录里留有 corrupt- 隔离件
    const quarantined = (await readdir(join(dir, 'vault'))).filter((name) =>
      name.includes('corrupt-')
    )
    expect(quarantined).toHaveLength(1)
    expect(await readFile(join(dir, 'vault', quarantined[0] ?? ''), 'utf8')).toBe(corrupt)

    // 下一次显式写入 → 正式路径上是干净 JSON,重新加载可用
    await vault.setPolicy('i1', BOTH)
    await vault.rememberSession('i1', SESSION)
    const reloaded = createVault({ filePath, crypto: fakeCrypto(), onError: () => undefined })
    expect(reloaded.getSession('i1')).toEqual(SESSION)
    // 新实例再读(触发 load)不再产生新错误 —— 损坏已被隔离干净
    const errors2: unknown[] = []
    createVault({ filePath, crypto: fakeCrypto(), onError: (e) => errors2.push(e) })
    expect(errors2).toHaveLength(0)
  })

  it('并发 persist 保持最后一次写入', async () => {
    // 压测:同一 vault 上 20 个并发 remember/forget,全部 resolve 且终态可读回。
    const vault = await optIn()
    const rounds = Array.from({ length: 20 }, (_, i) => i)
    await Promise.all(
      rounds.map((i) =>
        i % 2 === 0
          ? vault.rememberSession('i1', { ...SESSION, value: `sess-${i}` })
          : vault.forgetSession('i1')
      )
    )
    expect(vault.getSession('i1')).toBeNull()
    // 文件存在且为合法 JSON、无残留 tmp
    const raw = await readFile(filePath, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    const leftovers = (await readdir(join(dir, 'vault'))).filter((name) => name.includes('.tmp'))
    expect(leftovers).toEqual([])
    // 并发写后的文件没有损坏:新实例读到的终态一致
    const reloaded = createVault({ filePath, crypto: fakeCrypto(), onError: () => undefined })
    expect(reloaded.getSession('i1')).toBeNull()
  })

  it('磁盘被篡改的 policy 垃圾值在重开时收敛为默认(不勾选)', async () => {
    // 但磁盘文件可被外部篡改,重开时必须收敛而不是抛异常或误信垃圾值
    const vault = await optIn()
    await vault.setPolicy('i1', BOTH)
    expect(vault.getPolicy('i1')).toEqual(BOTH)

    // 模拟磁盘篡改:字符串/数字/null 三类垃圾形态
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      policy: Record<string, unknown>
    }
    parsed.policy['i1'] = { rememberPassword: 'yes', rememberSession: 1, extra: 'x' }
    parsed.policy['i2'] = 'garbage'
    parsed.policy['i3'] = null
    await writeFile(filePath, JSON.stringify(parsed))

    const reopened = createVault({ filePath, crypto: fakeCrypto(), onError: () => undefined })
    expect(reopened.getPolicy('i1')).toEqual({ rememberPassword: false, rememberSession: false })
    expect(reopened.getPolicy('i2')).toEqual({ rememberPassword: false, rememberSession: false })
    expect(reopened.getPolicy('i3')).toEqual({ rememberPassword: false, rememberSession: false })
    // 从未存在过的实例使用默认勾选策略。
    expect(reopened.getPolicy('i4')).toEqual({ rememberPassword: true, rememberSession: true })
    // 垃圾值收敛为显式禁用策略;下一次写入会把它们保留在落盘文件中，避免重启后恢复默认。
    await reopened.setPolicy('i9', BOTH)
    await reopened.rememberPassword('i9', 'p9')
    const convergedFile = JSON.parse(await readFile(filePath, 'utf8')) as {
      policy: Record<string, unknown>
    }
    expect(convergedFile.policy['i1']).toEqual({ rememberPassword: false, rememberSession: false })
    expect(convergedFile.policy['i2']).toEqual({ rememberPassword: false, rememberSession: false })
    expect(convergedFile.policy['i3']).toEqual({ rememberPassword: false, rememberSession: false })
    expect(Object.keys(convergedFile.policy ?? {}).sort()).toEqual(['i1', 'i2', 'i3'])
  })

  it('空密码/空会话被拒绝(即便已勾选)', async () => {
    const vault = await optIn()
    await expect(vault.rememberPassword('i1', '')).rejects.toThrow()
    await expect(vault.rememberSession('i1', { ...SESSION, value: '' })).rejects.toThrow()
    expect(vault.rememberedIds()).toEqual([])
  })

  it('forgetInstance 清某实例条目+策略;clearAll 一键清空', async () => {
    const vault = await optIn()
    await vault.rememberPassword('i1', 'p1')
    await vault.rememberSession('i1', SESSION)
    await vault.setPolicy('i2', BOTH)
    await vault.rememberPassword('i2', 'p2')

    await vault.forgetInstance('i1')
    expect(vault.getPassword('i1')).toBeNull()
    expect(vault.getSession('i1')).toBeNull()
    expect(vault.getPolicy('i1')).toEqual({ rememberPassword: true, rememberSession: true })
    expect(DEFAULT_VAULT_POLICY).toEqual({ rememberPassword: true, rememberSession: true })
    expect(vault.getPassword('i2')).toBe('p2')
    expect(vault.getPolicy('i2')).toEqual(BOTH)

    await vault.clearAll()
    expect(vault.rememberedIds()).toEqual([])
    expect(vault.getPolicy('i2')).toEqual({ rememberPassword: false, rememberSession: false })
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      items: unknown
      policy: Record<string, unknown>
    }
    expect(parsed.items).toEqual({})
    expect(parsed.policy['i2']).toEqual({ rememberPassword: false, rememberSession: false })
    // 一键清除后,没重新勾选就不能再落盘
    await expect(vault.rememberPassword('i2', 'p2')).rejects.toThrow()
  })

  it('会话载荷不是合法 JSON 时:丢弃且**不把解密后的内容**交给 onError', async () => {
    // 默认 onError 会 console.error(error),而 JSON.parse 的报错消息内嵌输入 ——
    // 即解密后的会话 Cookie。凭据纪律:日志只记事件,不记内容。
    const encryption = fakeCrypto()
    const vault = createVault({ filePath, crypto: encryption })
    await vault.setPolicy('i1', BOTH)
    // 直接写一个「能解密但不是 JSON」的会话载荷
    await vault.rememberSession('i1', { ...SESSION, value: 'x' })
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      items: Record<string, { session: string }>
    }
    parsed.items['i1']!.session = encryption.encrypt('sess-secret-not-json')
    await writeFile(filePath, JSON.stringify(parsed))

    const errors: unknown[] = []
    const reopened = createVault({
      filePath,
      crypto: encryption,
      onError: (error) => errors.push(error)
    })
    expect(reopened.getSession('i1')).toBeNull()
    expect(errors).toHaveLength(1)
    // 关键断言:错误对象里不得出现解密后的内容
    const serialized =
      String(errors[0]) + JSON.stringify(errors[0], Object.getOwnPropertyNames(errors[0]))
    expect(serialized).not.toContain('sess-secret-not-json')
  })

  it('hasPassword/hasSession 不触发解密(损坏条目的存在性判断不受影响)', async () => {
    const vault = await optIn()
    await vault.rememberPassword('i1', 'p1')
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      items: Record<string, { password: string }>
    }
    parsed.items['i1']!.password = 'garbage'
    await writeFile(filePath, JSON.stringify(parsed))

    const reopened = createVault({ filePath, crypto: fakeCrypto(), onError: () => undefined })
    expect(reopened.hasPassword('i1')).toBe(true)
  })
})
