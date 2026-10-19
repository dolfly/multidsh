import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CreateInstanceInput } from '@shared/contracts'
import { REGISTRY_SCHEMA_VERSION } from '@shared/contracts'

/**
 * 注册表端到端：渲染进程 → preload 白名单 → ipcMain → instance-store → 磁盘。
 * 以真实 Electron 应用验证 IPC 边界(合法写入/非法拒绝)与落盘位置。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-registry')
const REGISTRY_FILE = join(DATA_DIR, 'registry', 'instances.json')

let app: ElectronApplication
let win: Page

const launchArgs = buildLaunchArgs()

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

test('create 通过真实桥接写入注册表并落盘', async () => {
  const created = await win.evaluate(async () =>
    window.dshHub.instances.create({
      transport: 'local',
      name: 'E2E 本地实例',
      authMode: 'auto'
    })
  )
  expect(created.ok).toBe(true)
  if (!created.ok) return
  expect(created.value.transport).toBe('local')
  expect(created.value.name).toBe('E2E 本地实例')

  // 落盘校验:文件存在于隔离数据目录内,且记录可读回
  const file = JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) as {
    schemaVersion: number
    instances: Array<{ id: string }>
  }
  expect(file.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
  expect(file.instances.map((item) => item.id)).toContain(created.value.id)
})

test('list 返回摘要,get 读回完整记录,delete 生效', async () => {
  const created = await win.evaluate(async () =>
    window.dshHub.instances.create({
      transport: 'http',
      name: 'E2E 网关实例',
      endpointUrl: 'https://gw.example.com/dsh/'
    })
  )
  expect(created.ok).toBe(true)
  if (!created.ok) return

  const list = await win.evaluate(async () => window.dshHub.instances.list())
  expect(list.ok).toBe(true)
  if (list.ok) {
    const summary = list.value.find((item) => item.id === created.value.id)
    expect(summary).toBeDefined()
    // 摘要不含详情字段
    expect(summary).not.toHaveProperty('endpointUrl')
  }

  const detail = await win.evaluate(async (id) => window.dshHub.instances.get(id), created.value.id)
  expect(detail.ok).toBe(true)
  if (detail.ok && detail.value && detail.value.transport === 'http') {
    expect(detail.value.endpointUrl).toBe('https://gw.example.com/dsh')
  }

  const removed = await win.evaluate(
    async (id) => window.dshHub.instances.remove(id),
    created.value.id
  )
  expect(removed.ok).toBe(true)
  if (removed.ok) expect(removed.value.removed).toBe(true)
})

test('非法入参在 IPC 边界被拒(错误信封,不抛异常)', async () => {
  // 故意携带未知字段:IPC 边界(.strict())必须拒绝
  const withUnknownField = {
    transport: 'local',
    name: 'x',
    evil: true
  } as unknown as CreateInstanceInput
  const badCreate = await win.evaluate(
    async (input) => window.dshHub.instances.create(input),
    withUnknownField
  )
  expect(badCreate.ok).toBe(false)
  if (!badCreate.ok) expect(badCreate.code).toBe('invalid-input')

  const badEndpoint = await win.evaluate(async () =>
    window.dshHub.instances.create({ transport: 'http', name: 'x', endpointUrl: 'ftp://nope' })
  )
  expect(badEndpoint.ok).toBe(false)

  const badId = await win.evaluate(async () => window.dshHub.instances.get('not-a-uuid'))
  expect(badId.ok).toBe(false)
  if (!badId.ok) expect(badId.code).toBe('invalid-input')

  const missing = await win.evaluate(
    async (id) => window.dshHub.instances.update(id, { name: 'x' }),
    '11111111-1111-4111-8111-111111111111'
  )
  expect(missing.ok).toBe(false)
  if (!missing.ok) expect(missing.code).toBe('not-found')
})
