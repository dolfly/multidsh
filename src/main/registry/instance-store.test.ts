import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CreateInstanceInput, InstanceRecord, PatchInstanceInput } from '@shared/contracts'
import { REGISTRY_SCHEMA_VERSION } from '@shared/contracts'
import { createInstanceStore, InstanceStoreError } from './instance-store'

/**
 * 注册表存储全场景测试。
 * 临时目录放在工作区 hub-data/test-tmp（已 gitignore）：沙箱与 CI 均可写。
 */

const TEST_BASE = join(process.cwd(), 'hub-data', 'test-tmp')

/** 按 transport 收窄判别联合（测试专用谓词） */
function asLocal(record: InstanceRecord): Extract<InstanceRecord, { transport: 'local' }> {
  if (record.transport !== 'local') throw new Error('期望 local 实例')
  return record
}
function asSsh(record: InstanceRecord): Extract<InstanceRecord, { transport: 'ssh' }> {
  if (record.transport !== 'ssh') throw new Error('期望 ssh 实例')
  return record
}
function asHttp(record: InstanceRecord): Extract<InstanceRecord, { transport: 'http' }> {
  if (record.transport !== 'http') throw new Error('期望 http 实例')
  return record
}

let dir: string
let store: ReturnType<typeof createInstanceStore>

function tmpRun(overrides?: object): ReturnType<typeof createInstanceStore> {
  return createInstanceStore({ dir, ...overrides })
}

function localInput(overrides: object = {}): CreateInstanceInput {
  return { transport: 'local', name: '本机主力', ...overrides } as CreateInstanceInput
}

function sshInput(overrides: object = {}): CreateInstanceInput {
  return {
    transport: 'ssh',
    name: '远程主力',
    host: 'dsh-server.example.com',
    username: 'xubz',
    ...overrides
  } as CreateInstanceInput
}

function httpInput(overrides: object = {}): CreateInstanceInput {
  return {
    transport: 'http',
    name: '网关远程',
    endpointUrl: 'https://gw.example.com/dsh/',
    ...overrides
  } as CreateInstanceInput
}

async function readRegistryFile(): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, 'instances.json'), 'utf8'))
}

/** 取文件权限位（掩掉文件类型位）；仅在文件已存在时调用，避免首次运行 ENOENT 抖动 */
async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}

beforeEach(async () => {
  await mkdir(TEST_BASE, { recursive: true })
  dir = await mkdtemp(join(TEST_BASE, 'store-'))
  store = tmpRun()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createInstanceStore / 基础 CRUD', () => {
  it('空目录首次查询返回空列表', async () => {
    expect(await store.list()).toEqual([])
    expect(await store.get(randomUUID())).toBeNull()
  })

  it('create local:默认值填充 + id/时间戳生成 + 落盘', async () => {
    const record = asLocal(await store.create(localInput()))
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(record.transport).toBe('local')
    expect(record.authMode).toBe('auto')
    expect(record.autoStart).toBe(false)
    expect(record.port).toBeNull()
    expect(record.dshVersion).toBeNull()
    expect(record.launcher).toBeNull()
    expect(record.useDefaultSpace).toBe(false)
    expect(record.runCommand).toBeNull()
    expect(record.createdAt).toBe(record.updatedAt)
    expect(new Date(record.createdAt).getTime()).not.toBeNaN()

    const file = (await readRegistryFile()) as { schemaVersion: number; instances: unknown[] }
    expect(file.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
    expect(file.instances).toHaveLength(1)
  })

  it('local 保存公共空间选择', async () => {
    const record = asLocal(await store.create(localInput({ useDefaultSpace: true })))
    expect(record.useDefaultSpace).toBe(true)
    expect(asLocal(await store.update(record.id, { useDefaultSpace: false })).useDefaultSpace).toBe(
      false
    )
  })

  it('local 保存并更新受限的启动器', async () => {
    const created = asLocal(await store.create(localInput({ launcher: 'dush' })))
    expect(created.launcher).toBe('dush')

    const duush = asLocal(await store.create(localInput({ name: 'duush 实例', launcher: 'duush' })))
    expect(duush.launcher).toBe('duush')

    const updated = asLocal(await store.update(created.id, { launcher: 'dsh' }))
    expect(updated.launcher).toBe('dsh')

    await expect(
      store.update(created.id, { launcher: 'node server.js' } as never)
    ).rejects.toMatchObject({
      code: 'invalid-input'
    })
  })

  it('local 保存最近一次启动命令(展示字段,可清空)', async () => {
    const record = asLocal(await store.create(localInput()))
    const command = '/tmp/dsh --profile web --port 3080 --no-open'
    expect(asLocal(await store.update(record.id, { runCommand: command })).runCommand).toBe(command)
    expect(asLocal(await store.update(record.id, { runCommand: null })).runCommand).toBeNull()
  })

  it('create ssh:默认端口与 host[:port] 拆分', async () => {
    const plain = asSsh(await store.create(sshInput()))
    expect(plain.port).toBe(22)
    expect(plain.remotePort).toBe(3080)
    expect(plain.localPort).toBeNull()
    expect(plain.identityFile).toBeNull()

    const split = asSsh(await store.create(sshInput({ name: '带端口', host: 'server:2222' })))
    expect(split.host).toBe('server')
    expect(split.port).toBe(2222)

    const v6 = asSsh(await store.create(sshInput({ name: 'IPv6', host: '[::1]:2222' })))
    expect(v6.host).toBe('::1')
    expect(v6.port).toBe(2222)

    // 裸 IPv6 保持原样(含冒号但非 host:port 形态),端口回落默认
    const bareV6 = asSsh(await store.create(sshInput({ name: '裸IPv6', host: '::1' })))
    expect(bareV6.host).toBe('::1')
    expect(bareV6.port).toBe(22)

    // host[:port] 与显式 port 并存时,host[:port] 优先(文档化的约定)
    const conflict = asSsh(
      await store.create(sshInput({ name: '冲突', host: 'server:2222', port: 24 }))
    )
    expect(conflict.host).toBe('server')
    expect(conflict.port).toBe(2222)
  })

  it('create http:端点归一化(去尾斜杠)', async () => {
    const record = asHttp(await store.create(httpInput()))
    expect(record.endpointUrl).toBe('https://gw.example.com/dsh')
  })

  it('create 非法输入一律 invalid-input,且文件不被写入', async () => {
    const cases: CreateInstanceInput[] = [
      localInput({ unknownField: 1 }),
      sshInput({ host: 'bad host' }),
      sshInput({ username: '  ' }),
      // host[:port] 形态但端口非法/非数字 —— 显式拒绝,不让整串进 host 字段
      sshInput({ host: 'server:99999' }),
      sshInput({ host: 'host:12ab' }),
      sshInput({ host: '[::1]:99999' }),
      // 方括号只允许包裹 IPv6 字面量:内部前导 '-' 会在 ssh-keyscan 剥括号后成为选项(argv 注入)
      sshInput({ host: '[-flist]' }),
      sshInput({ host: '[-t]' }),
      sshInput({ host: '[gg]' }),
      httpInput({ endpointUrl: 'ftp://x' }),
      httpInput({ endpointUrl: 'http://u:p@127.0.0.1:3080' }),
      // 版本号在写入边界即校验（防拼接目录名穿越），非法字符一律拒绝
      localInput({ dshVersion: '../evil' }),
      localInput({ dshVersion: '1.0 0' }),
      localInput({ port: 0 }),
      localInput({ port: 70000 })
    ]
    for (const input of cases) {
      await expect(store.create(input)).rejects.toMatchObject({ code: 'invalid-input' })
    }
    expect(await store.list()).toEqual([])
  })

  it('get / update / remove 组合流程', async () => {
    const created = await store.create(localInput())
    expect((await store.get(created.id))?.name).toBe('本机主力')

    const updated = await store.update(created.id, { name: '主力机', notes: '工位 3 楼' })
    expect(updated.name).toBe('主力机')
    expect(updated.notes).toBe('工位 3 楼')
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updatedAt).getTime()
    )

    expect(await store.remove(created.id)).toBe(true)
    expect(await store.get(created.id)).toBeNull()
    expect(await store.remove(created.id)).toBe(false)
  })

  it('reorder 重排生效且落盘', async () => {
    const a = await store.create(localInput({ name: '甲' }))
    const b = await store.create(sshInput({ name: '乙' }))
    const c = await store.create(httpInput({ name: '丙' }))
    const reordered = await store.reorder([c.id, a.id, b.id])
    expect(reordered.map((r) => r.name)).toEqual(['丙', '甲', '乙'])
    // 落盘顺序与重排一致（重启后读回同样顺序）
    const persisted = (await readRegistryFile()) as { instances: InstanceRecord[] }
    expect(persisted.instances.map((r) => r.name)).toEqual(['丙', '甲', '乙'])
  })

  it('reorder 负路径：长度不符 / 未知 id / 重复 id 一律拒绝且不落盘', async () => {
    const a = await store.create(localInput({ name: '甲' }))
    const b = await store.create(sshInput({ name: '乙' }))

    await expect(store.reorder([a.id])).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.reorder([a.id, b.id, randomUUID()])).rejects.toMatchObject({
      code: 'invalid-input'
    })
    // 重复 id：[a,a] 长度与集合均通过旧校验，会让实例 b 从注册表静默消失（数据丢失）
    await expect(store.reorder([a.id, a.id])).rejects.toMatchObject({ code: 'invalid-input' })

    // 三次拒绝都不改动已落盘数据
    const file = await readRegistryFile()
    expect((file as { instances: InstanceRecord[] }).instances.map((r) => r.name)).toEqual([
      '甲',
      '乙'
    ])
  })

  it('update ssh host[:port]、http 端点同样归一化', async () => {
    const ssh = asSsh(await store.create(sshInput()))
    const updatedSsh = asSsh(await store.update(ssh.id, { host: 'new-server:2202' }))
    expect(updatedSsh.host).toBe('new-server')
    expect(updatedSsh.port).toBe(2202)

    const http = asHttp(await store.create(httpInput()))
    const updatedHttp = asHttp(
      await store.update(http.id, { endpointUrl: 'https://other.example.com/dsh/' })
    )
    expect(updatedHttp.endpointUrl).toBe('https://other.example.com/dsh')
  })

  it('update 非法补丁被拒且实例保持原值', async () => {
    const created = await store.create(localInput({ name: '原样' }))
    await expect(store.update(created.id, { endpointUrl: 'mailto:x' })).rejects.toMatchObject({
      code: 'invalid-input'
    })
    await expect(
      store.update(created.id, { unknownField: 1 } as unknown as PatchInstanceInput)
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.update(created.id, { name: '' })).rejects.toMatchObject({
      code: 'invalid-input'
    })
    expect((await store.get(created.id))?.name).toBe('原样')
  })

  it('notes 可用 null 清空（与补丁输入一致）', async () => {
    const created = await store.create(localInput({ notes: '先记一笔' }))
    expect((await store.get(created.id))?.notes).toBe('先记一笔')

    const cleared = await store.update(created.id, { notes: null })
    expect(cleared.notes).toBeNull()
    expect(await readRegistryFile()).not.toBeNull() // 落盘正常
    const fresh = tmpRun()
    expect((await fresh.get(created.id))?.notes).toBeNull() // 重载依旧为空
  })

  it('update 的 host[:port] 拆分与 create 对称(显式 port 并存时拆分优先)', async () => {
    const ssh = asSsh(await store.create(sshInput({ host: 'server-a', port: 24 })))
    const updated = asSsh(await store.update(ssh.id, { host: 'server2:2202', port: 24 }))
    expect(updated.host).toBe('server2')
    expect(updated.port).toBe(2202)

    // 纯主机名更新不清掉已有显式端口
    const renamed = asSsh(await store.update(ssh.id, { host: 'server-b' }))
    expect(renamed.host).toBe('server-b')
    expect(renamed.port).toBe(2202)
  })

  it('方括号点分/IPv4-mapped 形态同样拆分端口(与 schema 字符集对齐)', async () => {
    const v4 = asSsh(await store.create(sshInput({ name: '括号点分', host: '[192.0.2.1]:2222' })))
    expect(v4.host).toBe('192.0.2.1')
    expect(v4.port).toBe(2222)

    const mapped = asSsh(
      await store.create(sshInput({ name: 'IPv4-mapped', host: '[::ffff:192.168.1.5]:3080' }))
    )
    expect(mapped.host).toBe('::ffff:192.168.1.5')
    expect(mapped.port).toBe(3080)
  })

  it('update 裸方括号 IPv6 不得注入默认端口(与无括号写法对称)', async () => {
    const withPort = asSsh(await store.create(sshInput({ name: '保持端口', port: 2222 })))
    const stripped = asSsh(await store.update(withPort.id, { host: '[::1]' }))
    expect(stripped.host).toBe('::1')
    expect(stripped.port).toBe(2222)

    const bare = asSsh(await store.update(withPort.id, { host: '::1' }))
    expect(bare.host).toBe('::1')
    expect(bare.port).toBe(2222)

    // 显式 port 与括号剥离并存:保留显式值
    const both = asSsh(await store.update(withPort.id, { host: '[::1]', port: 3333 }))
    expect(both.host).toBe('::1')
    expect(both.port).toBe(3333)
  })

  it('list/get 返回拷贝,外部改动不污染缓存', async () => {
    const created = await store.create(localInput({ name: '原始名' }))
    const list = await store.list()
    const first = list[0]
    if (first) first.name = 'HACK-l'
    const detail = await store.get(created.id)
    if (detail) detail.name = 'HACK-g'
    expect((await store.get(created.id))?.name).toBe('原始名')
    expect((await store.list())[0]?.name).toBe('原始名')
  })

  it('update 不存在的 id → not-found', async () => {
    await expect(store.update(randomUUID(), { name: 'x' })).rejects.toBeInstanceOf(
      InstanceStoreError
    )
    await expect(store.update(randomUUID(), { name: 'x' })).rejects.toMatchObject({
      code: 'not-found'
    })
  })
})

describe('createInstanceStore / 原子性与备份', () => {
  it('多次变更后无 .tmp-* 残留,备份随改动滚动', async () => {
    const record = await store.create(localInput())
    for (let i = 0; i < 3; i++) {
      await store.update(record.id, { name: `改名-${i}` })
    }
    const names = await readdir(dir)
    expect(names.some((name) => name.includes('.tmp-'))).toBe(false)
    const baks = names.filter((name) => name.startsWith('instances.json.bak-'))
    expect(baks.length).toBeGreaterThanOrEqual(3)
  })

  it('备份保留份数上限(默认 20)', async () => {
    const record = await store.create(localInput())
    for (let i = 0; i < 25; i++) {
      await store.update(record.id, { name: `改-${i}` })
    }
    const names = await readdir(dir)
    const baks = names.filter((name) => name.startsWith('instances.json.bak-'))
    expect(baks.length).toBeLessThanOrEqual(20)
  })

  it('并发写串行化:10 个并发 create 全部落盘且文件合法', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.create(localInput({ name: `并发-${i}` })))
    )
    expect(await store.list()).toHaveLength(10)
    const file = (await readRegistryFile()) as { instances: unknown[] }
    expect(file.instances).toHaveLength(10)
    const names = await readdir(dir)
    expect(names.some((name) => name.includes('.tmp-'))).toBe(false)
  })
})

describe('createInstanceStore / 损坏恢复与迁移', () => {
  it('JSON 垃圾文件:隔离到 .corrupt-* 并从空注册表继续', async () => {
    await store.create(localInput())
    await writeFile(join(dir, 'instances.json'), '{{{ 不是 JSON', 'utf8')
    const fresh = tmpRun()
    expect(await fresh.list()).toEqual([])
    const stats = await fresh.stats()
    expect(stats.lastRecoveryAt).not.toBeNull()
    expect(stats.corruptCount).toBeGreaterThanOrEqual(1)
    // 主文件被移走,可再正常写入
    const record = await fresh.create(localInput({ name: '恢复后' }))
    expect((await fresh.get(record.id))?.name).toBe('恢复后')
  })

  it('schema 不合法的文件(实例端口越界)同样隔离', async () => {
    await writeFile(
      join(dir, 'instances.json'),
      JSON.stringify({
        schemaVersion: 1,
        instances: [{ id: randomUUID(), name: '坏', transport: 'local', authMode: 'auto', port: 0 }]
      }),
      'utf8'
    )
    expect(await store.list()).toEqual([])
    expect((await store.stats()).corruptCount).toBe(1)
  })

  it('隔离副本保留上限(默认 5)', async () => {
    for (let i = 0; i < 6; i++) {
      await writeFile(join(dir, 'instances.json'), 'garbage', 'utf8')
      await tmpRun().list() // 每次触发一次恢复
    }
    const names = await readdir(dir)
    const corrupts = names.filter((name) => name.startsWith('instances.json.corrupt-'))
    expect(corrupts.length).toBeLessThanOrEqual(5)
  })

  it('v0 无版本号文件经注入迁移链升级到当前版本', async () => {
    const oldId = randomUUID()
    const migrated = tmpRun({
      // 逐版迁移：本用例只验证「迁移链被逐级调用」，各步仅提升版本号、不改记录。
      migrations: {
        0: (file: unknown) => ({ ...(file as object), schemaVersion: 1 }),
        1: (file: unknown) => ({ ...(file as object), schemaVersion: 2 })
      }
    })
    await writeFile(
      join(dir, 'instances.json'),
      JSON.stringify({
        instances: [
          {
            id: oldId,
            name: '旧实例',
            transport: 'local',
            authMode: 'auto',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      }),
      'utf8'
    )
    const list = await migrated.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe(oldId)
    // 迁移后文件被重写为当前版本
    const file = (await readRegistryFile()) as { schemaVersion: number }
    expect(file.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
  })

  it('缺少迁移器或文件来自未来版本 → 隔离', async () => {
    await writeFile(
      join(dir, 'instances.json'),
      JSON.stringify({ instances: [], schemaVersion: 0 }),
      'utf8'
    )
    // 无迁移器(默认空表);每次用新 store 实例,避免读缓存
    expect(await tmpRun().list()).toEqual([])
    expect((await tmpRun().stats()).corruptCount).toBe(1)

    await writeFile(
      join(dir, 'instances.json'),
      JSON.stringify({ instances: [], schemaVersion: 99 }),
      'utf8'
    )
    expect(await tmpRun().list()).toEqual([])
    expect((await tmpRun().stats()).corruptCount).toBe(2)
  })
})

describe.skipIf(process.platform === 'win32')('createInstanceStore / 写盘失败不产生幻影()', () => {
  it('目录只读时 create 失败,内存不残留幻影;恢复可写后幻影不会补落盘', async () => {
    const base = asLocal(await store.create(localInput({ name: '基准' })))
    expect(await store.list()).toHaveLength(1)

    await chmod(dir, 0o555) // 只读目录:备份写入 / rename 均失败
    try {
      await expect(store.create(localInput({ name: '幻影' }))).rejects.toMatchObject({
        code: 'io-error'
      })
      // 失败的写不得进入内存(磁盘先提交语义)
      expect(await store.list()).toHaveLength(1)
      const file = (await readRegistryFile()) as { instances: unknown[] }
      expect(file.instances).toHaveLength(1)
    } finally {
      await chmod(dir, 0o755) // 恢复可写
    }

    // 后续成功 mutation 不应把「幻影」一并落盘
    const second = asLocal(await store.create(localInput({ name: '第二个' })))
    const list = await store.list()
    expect(list.map((record) => record.id).sort()).toEqual([base.id, second.id].sort())
  })

  it('50+ 实例下 list 走内存缓存,规模化不劣化', async () => {
    const store = createInstanceStore({ dir })
    const COUNT = 60
    for (let index = 0; index < COUNT; index += 1) {
      await store.create(
        httpInput({ name: `实例 ${index}`, endpointUrl: `https://h${index}.example.com/` })
      )
    }
    // 首次 list 触发装载;随后应完全命中内存缓存(退化成每次读盘会远超下面的界)
    expect(await store.list()).toHaveLength(COUNT)

    const started = Date.now()
    const ROUNDS = 50
    for (let round = 0; round < ROUNDS; round += 1) {
      const all = await store.list()
      expect(all).toHaveLength(COUNT)
      // 返回值必须是拷贝:调用方改动不得污染缓存(设计约束)
      const first = all[0]
      if (first) first.name = '被污染'
    }
    const elapsed = Date.now() - started
    // 3000 次记录投影耗时上限:绝对阈值取得很宽(避免负载抖动导致假失败),
    // 但足以抓住「list 每次重新读盘/重新解析」这类规模化退化。
    expect(elapsed).toBeLessThan(3_000)

    // 拷贝语义:缓存未被前一轮的写入污染
    const after = await store.list()
    expect(after[0]?.name).toBe('实例 0')
  })
})

describe.skipIf(process.platform === 'win32')('createInstanceStore / 落盘权限 0600', () => {
  it('新建的注册表主文件为 0600', async () => {
    await store.create(localInput())
    expect(await modeOf(join(dir, 'instances.json'))).toBe(0o600)
  })

  it('滚动备份 .bak-* 为 0600', async () => {
    const created = await store.create(localInput())
    await store.update(created.id, { name: '触发备份' })
    const baks = (await readdir(dir)).filter((name) => name.startsWith('instances.json.bak-'))
    expect(baks.length).toBeGreaterThan(0)
    for (const name of baks) expect(await modeOf(join(dir, name)), name).toBe(0o600)
  })

  it('隔离副本 .corrupt-* 为 0600（源文件曾是 0644 也必须收紧）', async () => {
    await store.create(localInput())
    const file = join(dir, 'instances.json')
    await chmod(file, 0o644) // 模拟不安全的现有文件权限
    await writeFile(file, '{{{ 不是 JSON', 'utf8') // 覆盖写不改动既有 mode
    expect(await modeOf(file)).toBe(0o644)

    expect(await tmpRun().list()).toEqual([]) // 触发一次损坏隔离
    const corrupts = (await readdir(dir)).filter((name) =>
      name.startsWith('instances.json.corrupt-')
    )
    expect(corrupts.length).toBe(1)
    const quarantined = corrupts[0]
    if (!quarantined) throw new Error('期望存在隔离副本')
    expect(await modeOf(join(dir, quarantined))).toBe(0o600)
  })

  it('既有 0644 注册表在一次成功写入后归一化为 0600', async () => {
    const created = await store.create(localInput())
    const file = join(dir, 'instances.json')
    await chmod(file, 0o644)
    expect(await modeOf(file)).toBe(0o644)

    await store.update(created.id, { name: '归一化' })
    expect(await modeOf(file)).toBe(0o600)
    // 权限收紧不得影响写入本身
    const written = (await readRegistryFile()) as { instances: Array<{ name: string }> }
    expect(written.instances[0]?.name).toBe('归一化')
  })
})
