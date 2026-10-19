import { _electron as electron, expect, test } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/**
 * 总览列表 50+ 实例的性能验证。
 *
 * 预播种 60 条真实形态的注册表记录(混合 local/http 变体,形态与 create() 落盘
 * 完全一致 —— 参照 registry.spec 对落盘文件的断言),启动真实应用,断言:
 * ① 总览表格 60 行全部渲染出来;② 从启动到满行的耗时在预算内。
 *
 * 预算用于防止明显卡顿或 O(n²) 行为，不作为微基准。
 */

const DATA_DIR = e2eDataDir('e2e-perf')
const REGISTRY_FILE = join(DATA_DIR, 'registry', 'instances.json')
const COUNT = 60
const RENDER_BUDGET_MS = 10_000

/** 与 InstanceRecordSchema(zod)逐字段对应的真实落盘形态 */
function buildSeed(count: number): { schemaVersion: number; instances: unknown[] } {
  const now = new Date().toISOString()
  const instances = Array.from({ length: count }, (_, i) => {
    const idx = `${i + 1}`.padStart(3, '0')
    const base = {
      id: randomUUID(),
      name: `性能实例 ${idx}`,
      authMode: 'auto',
      createdAt: now,
      updatedAt: now
    }
    // 每 3 条里 1 条 http 变体(端点须过 parseEndpointUrl:https、合法 host、无 userinfo)
    if (i % 3 === 2) {
      return { ...base, transport: 'http', endpointUrl: `https://gw-${idx}.example.com/dsh/` }
    }
    return {
      ...base,
      transport: 'local',
      dshVersion: null,
      port: null,
      profile: null,
      autoStart: false
    }
  })
  return { schemaVersion: 1, instances }
}

let app: ElectronApplication
let win: Page
let launchedAt = 0

const launchArgs = buildLaunchArgs()

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(join(DATA_DIR, 'registry'), { recursive: true })
  await writeFile(REGISTRY_FILE, JSON.stringify(buildSeed(COUNT)), 'utf8')
  launchedAt = Date.now()
  app = await electron.launch({
    args: launchArgs,
    env: e2eEnv(DATA_DIR)
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

test(`总览渲染 ${COUNT} 条预播种实例且在预算内完成`, async () => {
  const table = win.getByTestId('instances-table')
  await expect(table).toBeVisible()

  // ① 60 行全部渲染(启动 → 满行),预算内完成
  const rows = table.locator('tbody tr')
  await expect(rows).toHaveCount(COUNT, { timeout: RENDER_BUDGET_MS })
  const elapsed = Date.now() - launchedAt
  console.log(`[perf] ${COUNT} 行渲染完成:启动 → 满行 ${elapsed}ms(预算 ${RENDER_BUDGET_MS}ms)`)

  // ② 首尾两条都真实渲染(不是骨架屏占位)
  await expect(table).toContainText('性能实例 001')
  await expect(table).toContainText('性能实例 060')

  // ③ 侧栏(折叠态的另一渲染面)也拿到全部实例
  const sidebarItems = win.locator('[data-testid^="inst-"]')
  await expect(sidebarItems).toHaveCount(COUNT, { timeout: RENDER_BUDGET_MS })

  expect(elapsed).toBeLessThan(RENDER_BUDGET_MS)
})
