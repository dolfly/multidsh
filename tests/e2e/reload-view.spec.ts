import { _electron as electron, expect, test } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { rm } from 'node:fs/promises'
/**
 * Cmd+R（重载渲染层）后应停留在刷新前的页面：
 * 详情页刷新后仍是同一实例的详情页（数据重新拉取），总览刷新后仍是总览。
 * Playwright 的 win.reload() 与应用菜单 Reload 角色走同一条 webContents.reload()。
 */
const DATA_DIR = e2eDataDir('e2e-reload-view')
const INSTANCE_NAME = '刷新实例'

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  app = await electron.launch({
    args: buildLaunchArgs(),
    env: e2eEnv(DATA_DIR)
  })
  win = await app.firstWindow()

  const created = await win.evaluate(
    async (name) =>
      window.dshHub.instances.create({
        transport: 'local',
        name,
        authMode: 'none',
        dshVersion: '0.1.7-rc.2'
      }),
    INSTANCE_NAME
  )
  if (!created.ok) throw new Error('创建实例失败')

  await win.reload()
  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 15_000 })
})

test.afterAll(async () => {
  await app.close()
  await rm(DATA_DIR, { recursive: true, force: true })
})

test('详情页刷新后仍在同一实例的详情页，而不是回到实例列表', async () => {
  test.setTimeout(90_000)
  await win.locator('[data-testid^="detail-"]').first().click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByTestId('view-detail')).toContainText(INSTANCE_NAME)

  await win.reload()

  await expect(win.getByTestId('view-detail')).toBeVisible({ timeout: 15_000 })
  await expect(win.getByTestId('view-detail')).toContainText(INSTANCE_NAME)
  await expect(win.getByTestId('view-home')).toBeHidden()
})

test('总览刷新后仍是总览', async () => {
  test.setTimeout(90_000)
  await win.getByTestId('detail-overview-btn').click()
  await expect(win.getByTestId('view-home')).toBeVisible()

  await win.reload()

  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 15_000 })
  await expect(win.getByTestId('view-detail')).toBeHidden()
})

test('实例被删除后刷新：留在总览，不进空详情页', async () => {
  test.setTimeout(90_000)
  await win.locator('[data-testid^="detail-"]').first().click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  // 从注册表删除该实例后刷新：恢复目标已不存在，应回落到总览。
  const instanceId = await win.evaluate(async () => {
    const listed = await window.dshHub.instances.list()
    return listed.ok ? (listed.value[0]?.id ?? null) : null
  })
  expect(instanceId).not.toBeNull()
  await win.evaluate(async (id) => {
    await window.dshHub.instances.remove(id as string, { trashSpace: false })
  }, instanceId)

  await win.reload()

  // 恢复目标已不存在：留在总览（实例已删完 → 空态），既不进详情页，
  // 也不会停在详情页的「找不到该实例」占位。
  await expect(win.getByTestId('view-empty')).toBeVisible({ timeout: 15_000 })
  await expect(win.getByTestId('view-detail')).toHaveCount(0)
  await expect(win.getByTestId('view-detail-missing')).toHaveCount(0)
})
