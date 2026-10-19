import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REGISTRY_SCHEMA_VERSION } from '@shared/contracts'
import type { InstanceRecord } from '@shared/contracts'
import { normalizeSettings, DEFAULT_SETTINGS } from '@shared/settings'
import { createInstanceStore } from '../../src/main/registry/instance-store'
import { REGISTRY_MIGRATIONS } from '../../src/main/registry/migrations'
import { createSettingsStore } from '../../src/main/settings/settings-store'

/**
 * 升级路径测试。
 *
 * 「升级不丢数据」在桌面应用里没有 CI 之外的验证手段:用户机器上只有一份注册表,
 * 升级时被静默重置 = 数据资产直接消失。这里把三件事变成可执行断言:
 *
 * 1. **历史夹具可读**:0.1.0 真实写出的 `instances.json` / `settings.json` 必须逐字段还原。
 * 2. **版本号不能空转**:提高 `REGISTRY_SCHEMA_VERSION` 却没配迁移链时,本文件直接失败。
 * 3. **拒绝未知 schema**:版本号高于当前支持范围的文件会被保留原字节并隔离。
 *
 * 夹具纪律见 `tests/fixtures/upgrade/README.md`(不许改夹具来迁就实现)。
 */

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'upgrade')
const TEST_BASE = join(process.cwd(), 'hub-data', 'test-tmp')

function fixture(name: string): Promise<string> {
  return readFile(join(FIXTURES, name), 'utf8')
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

let dir: string

beforeEach(async () => {
  await mkdir(TEST_BASE, { recursive: true })
  dir = await mkdtemp(join(TEST_BASE, 'upgrade-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('注册表跨版本升级路径', () => {
  it('0.1.0 夹具逐字段还原(三种 transport 全部保真)', async () => {
    const registryDir = join(dir, 'registry')
    await mkdir(registryDir, { recursive: true })
    await writeFile(join(registryDir, 'instances.json'), await fixture('registry-v1.json'), 'utf8')

    const store = createInstanceStore({ dir: registryDir, migrations: REGISTRY_MIGRATIONS })
    const list = await store.list()

    expect(list).toHaveLength(3)
    const byId = new Map(list.map((item) => [item.id, item]))
    expect([...byId.keys()].sort()).toEqual([
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
      '3f2504e0-4f89-41d3-9a0c-0305e82c3303'
    ])

    const local = byId.get('3f2504e0-4f89-41d3-9a0c-0305e82c3301')
    expect(local?.transport).toBe('local')
    expect(local).toMatchObject({
      name: '本地开发',
      authMode: 'auto',
      notes: 'v0.1.0 升级夹具:本地实例',
      dshVersion: '0.1.5-rc.1',
      port: 8002,
      profile: 'dev',
      autoStart: true,
      createdAt: '2026-01-05T02:14:33.000Z',
      updatedAt: '2026-01-06T07:41:02.000Z'
    })

    const ssh = byId.get('3f2504e0-4f89-41d3-9a0c-0305e82c3302')
    expect(ssh?.transport).toBe('ssh')
    expect(ssh).toMatchObject({
      name: '远程构建机',
      host: 'build.example.internal',
      port: 22,
      username: 'xbzbing',
      remotePort: 3080,
      // 隧道本地端口是最容易在升级中被丢弃的字段(它决定已授权的隧道能否复用)
      localPort: 32222,
      identityFile: null
    })

    const http = byId.get('3f2504e0-4f89-41d3-9a0c-0305e82c3303')
    expect(http?.transport).toBe('http')
    expect(http).toMatchObject({
      name: '云端网关',
      endpointUrl: 'https://dsh.example.com/hub'
    })

    // 读取不应产生任何隔离/备份垃圾
    const names = await readdir(registryDir)
    expect(names.filter((name) => name.includes('.corrupt-'))).toEqual([])
    // 夹具本身不得被读取路径改写(读路径只读)
    expect(JSON.parse(await fixture('registry-v1.json'))).toMatchObject({ schemaVersion: 1 })
  })

  it('schemaVersion 提升后必须存在迁移链(否则本用例失败)', async () => {
    const registryDir = join(dir, 'registry')
    await mkdir(registryDir, { recursive: true })
    const raw = await fixture('registry-v1.json')
    await writeFile(join(registryDir, 'instances.json'), raw, 'utf8')
    const fixtureVersion = (JSON.parse(raw) as { schemaVersion: number }).schemaVersion

    // 这条断言就是「版本号不能空转」的守门人:谁把 REGISTRY_SCHEMA_VERSION 提到
    // fixtureVersion 之上,就必须同时给出 v{fixtureVersion} → v+1 的迁移器,
    // 否则 createInstanceStore 会把夹具当作「缺少迁移器」隔离,list() 变空 → 本用例红。
    const store = createInstanceStore({ dir: registryDir, migrations: REGISTRY_MIGRATIONS })
    const list = await store.list()

    if (REGISTRY_SCHEMA_VERSION > fixtureVersion) {
      expect(
        list,
        `REGISTRY_SCHEMA_VERSION=${REGISTRY_SCHEMA_VERSION} 已高于夹具版本 ${fixtureVersion},` +
          `但 tests/fixtures/upgrade/registry-v1.json 未被成功迁移 —— 请补 ${fixtureVersion} → ${fixtureVersion + 1} 迁移器,` +
          `不要修改夹具(见 tests/fixtures/upgrade/README.md)`
      ).toHaveLength(3)
    } else {
      expect(REGISTRY_SCHEMA_VERSION).toBe(fixtureVersion)
      expect(list).toHaveLength(3)
    }

    // 迁移/恢复后落盘形态必须是当前版本
    const file = (await readJson(join(registryDir, 'instances.json'))) as { schemaVersion: number }
    expect(file.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
  })

  it('高于当前 schema 的文件会被隔离且保留原字节', async () => {
    const registryDir = join(dir, 'registry')
    await mkdir(registryDir, { recursive: true })
    const raw = await fixture('registry-v1.json')
    const future = {
      ...(JSON.parse(raw) as { instances: InstanceRecord[] }),
      schemaVersion: REGISTRY_SCHEMA_VERSION + 7
    }
    await writeFile(join(registryDir, 'instances.json'), JSON.stringify(future, null, 2), 'utf8')

    const store = createInstanceStore({ dir: registryDir, migrations: REGISTRY_MIGRATIONS })
    // 拒绝降级读取:内存里是空的(不猜测语义),但**不得**销毁用户数据
    expect(await store.list()).toEqual([])

    const names = await readdir(registryDir)
    const quarantined = names.filter((name) => name.startsWith('instances.json.corrupt-'))
    expect(quarantined).toHaveLength(1)

    // 关键断言:被隔离的是**原始内容的完整副本**(3 条实例一条不少),
    // 否则「先降级一次、再升级回来」就永久丢数据。
    const preserved = (await readJson(join(registryDir, quarantined[0]!))) as {
      schemaVersion: number
      instances: unknown[]
    }
    expect(preserved.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION + 7)
    expect(preserved.instances).toHaveLength(3)

    // 主路径被重置为当前版本的合法空文件(可继续使用),而不是留在损坏态
    const current = (await readJson(join(registryDir, 'instances.json'))) as {
      schemaVersion: number
      instances: unknown[]
    }
    expect(current.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
    expect(current.instances).toEqual([])
  })

  it('夹具加载后做一次写入,其余实例的变体字段不被抹平', async () => {
    const registryDir = join(dir, 'registry')
    await mkdir(registryDir, { recursive: true })
    await writeFile(join(registryDir, 'instances.json'), await fixture('registry-v1.json'), 'utf8')

    const store = createInstanceStore({ dir: registryDir, migrations: REGISTRY_MIGRATIONS })
    await store.update('3f2504e0-4f89-41d3-9a0c-0305e82c3301', { name: '本地开发(改名)' })

    const after = (await readJson(join(registryDir, 'instances.json'))) as {
      schemaVersion: number
      instances: InstanceRecord[]
    }
    expect(after.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
    expect(after.instances).toHaveLength(3)
    const ssh = after.instances.find((item) => item.id === '3f2504e0-4f89-41d3-9a0c-0305e82c3302')
    expect(ssh).toMatchObject({ transport: 'ssh', localPort: 32222, remotePort: 3080 })
    const renamed = after.instances.find(
      (item) => item.id === '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    )
    expect(renamed?.name).toBe('本地开发(改名)')
  })

  it('v1→v2 迁移:历史方括号主机与非法 dshVersion 归一化,合法值与其余字段保真', async () => {
    const registryDir = join(dir, 'registry')
    await mkdir(registryDir, { recursive: true })
    // 关键回归:这些值在 v1 下合法、v2 收紧后会被拒。若无迁移，整表会被隔离、实例全部消失。
    await writeFile(
      join(registryDir, 'instances.json'),
      await fixture('registry-v1-legacy.json'),
      'utf8'
    )

    const store = createInstanceStore({ dir: registryDir, migrations: REGISTRY_MIGRATIONS })
    const list = await store.list()

    // 三条一条不少（不是整表隔离）
    expect(list).toHaveLength(3)
    const byId = new Map(list.map((item) => [item.id, item]))

    // 含空格的 dshVersion → null（未固定），其余本地字段保真
    const local = byId.get('5f2504e0-4f89-41d3-9a0c-0305e82c3401')
    expect(local).toMatchObject({
      transport: 'local',
      name: '本地遗留版本号',
      dshVersion: null,
      port: 8010,
      profile: 'dev'
    })

    // 方括号非 IPv6 主机 → 剥括号；端口/用户名/隧道端口等保真
    const ssh = byId.get('5f2504e0-4f89-41d3-9a0c-0305e82c3402')
    expect(ssh).toMatchObject({
      transport: 'ssh',
      host: 'build.example.internal',
      port: 22,
      username: 'xbzbing',
      remotePort: 3080,
      localPort: 32223
    })

    // 合法 IPv6 方括号：迁移不得改动它（记录里保持 [::1]，schema 接受方括号 IPv6 形态）
    const ipv6 = byId.get('5f2504e0-4f89-41d3-9a0c-0305e82c3403')
    expect(ipv6).toMatchObject({ transport: 'ssh', host: '[::1]', port: 2222 })

    // 迁移路径不产生隔离垃圾，且落盘已重写为当前版本
    const names = await readdir(registryDir)
    expect(names.filter((name) => name.includes('.corrupt-'))).toEqual([])
    const file = (await readJson(join(registryDir, 'instances.json'))) as { schemaVersion: number }
    expect(file.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
  })
})

describe('设置跨版本升级路径', () => {
  it('0.1.0 夹具的五个偏好全部保留(升级不重置用户口味)', async () => {
    const settingsDir = join(dir, 'settings')
    await mkdir(settingsDir, { recursive: true })
    await writeFile(join(settingsDir, 'settings.json'), await fixture('settings-v1.json'), 'utf8')

    const store = createSettingsStore({ dir: settingsDir, onError: () => undefined })
    const settings = store.read()

    // 夹具刻意让每个字段都**不等于**默认值,否则「被重置」在断言下不可见
    expect(settings).toEqual({
      language: 'en',
      theme: 'dark',
      tray: true,
      autoStart: true,
      notifications: false,
      preventSleepWhenRunning: false, // 夹具无此字段,回落默认
      workspaceCacheSize: 3, // 夹具无此字段,回落默认
      inheritShellEnv: true, // 夹具无此字段,回落默认
      npmRegistry: '' // 夹具无此字段,回落默认
    })
    for (const [key, value] of Object.entries(settings).filter(
      ([key]) =>
        key !== 'preventSleepWhenRunning' &&
        key !== 'workspaceCacheSize' &&
        key !== 'inheritShellEnv' &&
        key !== 'npmRegistry'
    )) {
      expect(value, `字段 ${key} 恰好等于默认值,夹具失去检出能力`).not.toEqual(
        DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS]
      )
    }
  })

  it('设置读写往返后偏好不变', async () => {
    const settingsDir = join(dir, 'settings')
    await mkdir(settingsDir, { recursive: true })
    await writeFile(join(settingsDir, 'settings.json'), await fixture('settings-v1.json'), 'utf8')

    const store = createSettingsStore({ dir: settingsDir, onError: () => undefined })
    const before = store.read()
    await store.update({ tray: false })
    const after = store.read()

    expect(after).toEqual({ ...before, tray: false })
    const onDisk = (await readJson(join(settingsDir, 'settings.json'))) as Record<string, unknown>
    expect(onDisk).toMatchObject({
      language: 'en',
      theme: 'dark',
      tray: false,
      autoStart: true,
      notifications: false
    })
  })

  it('来自更高版本的设置文件:未知字段忽略,非法字段逐字段回落,不影响合法字段', async () => {
    const settingsDir = join(dir, 'settings')
    await mkdir(settingsDir, { recursive: true })
    await writeFile(
      join(settingsDir, 'settings.json'),
      await fixture('settings-future.json'),
      'utf8'
    )

    let errorSeen: unknown = null
    const store = createSettingsStore({
      dir: settingsDir,
      onError: (error) => {
        errorSeen = error
      }
    })
    const settings = store.read()

    expect(settings).toEqual({
      // 合法值保留
      language: 'en',
      tray: true,
      notifications: false,
      // 'neon' / 'yes' 不是合法取值 → 各自回落默认值,而不是整份重置
      theme: 'system',
      autoStart: false,
      preventSleepWhenRunning: false, // 未来文件无此字段,回落默认
      workspaceCacheSize: 3, // 未来文件无此字段,回落默认
      inheritShellEnv: true, // 未来文件无此字段,回落默认
      npmRegistry: '' // 未来文件无此字段,回落默认
    })
    // 逐字段收敛是**静默**的(设置坏了不该拦住启动),不产出噪音错误
    expect(errorSeen).toBeNull()
  })

  it('normalizeSettings 对历史/未来形态都不抛异常(纯函数级)', async () => {
    for (const name of ['settings-v1.json', 'settings-future.json']) {
      const parsed = JSON.parse(await fixture(name)) as unknown
      expect(() => normalizeSettings(parsed)).not.toThrow()
    }
    // 极端输入不得让应用起不来
    for (const hostile of [null, undefined, 42, 'x', [], true]) {
      expect(() => normalizeSettings(hostile)).not.toThrow()
      expect(normalizeSettings(hostile)).toEqual(DEFAULT_SETTINGS)
    }
  })
})
