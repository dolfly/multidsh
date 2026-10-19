import { _electron as electron, expect, test } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
/**
 * 高风险 UI 状态迁移的端到端守卫：
 * 1. 删除确认框打开时经 切换修饰键+数字 切换实例 —— 确认框必须随详情整体重挂载消失，
 *    否则「A 的确认框在 B 上生效」会造成错实例的破坏性删除；
 * 2. 设置页主题偏好跨重启持久化（hydrateSettings → settings.update 全链路）。
 * 实例固定用不可达的本机 http 端点并显式 start：状态进入 error 后侧栏点击走
 * select 直达详情，不经过工作区加载，切换路径确定。
 */

const DATA_DIR = e2eDataDir('e2e-detail-guard')

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  app = await electron.launch({
    args: buildLaunchArgs(),
    env: e2eEnv(DATA_DIR)
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

async function createUnreachableInstance(name: string): Promise<string> {
  return win.evaluate(async (input) => {
    const created = await window.dshHub.instances.create({
      transport: 'http',
      name: input,
      authMode: 'none',
      endpointUrl: 'http://127.0.0.1:9/'
    })
    if (!created.ok) throw new Error(created.message)
    return created.value.id
  }, name)
}

test('删除确认框打开时切换实例：确认框随详情重挂载消失，不误删', async () => {
  test.setTimeout(90_000)
  const aId = await createUnreachableInstance('守卫实例一')
  const bId = await createUnreachableInstance('守卫实例二')

  // 显式 start → 端点不可达 → 状态 error：侧栏点击经 select 直达详情（不进工作区加载）。
  for (const id of [aId, bId]) {
    await win.evaluate(async (instanceId) => {
      await window.dshHub.runtime.start(instanceId)
    }, id)
  }
  const reachedError = async (id: string): Promise<boolean> => {
    const listed = await win.evaluate(async () => {
      const r = await window.dshHub.instances.list()
      return r.ok
        ? r.value.map((instance) => ({ id: instance.id, status: instance.runtimeStatus }))
        : []
    })
    return listed.find((instance) => instance.id === id)?.status === 'error'
  }
  await expect.poll(() => reachedError(aId), { timeout: 20_000 }).toBe(true)
  await expect.poll(() => reachedError(bId), { timeout: 20_000 }).toBe(true)
  await win.reload()
  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 15_000 })

  // 打开 A 的删除确认框
  await win.getByTestId(`inst-${aId}`).click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByRole('heading', { name: '守卫实例一' })).toBeVisible()
  await win.getByTestId('delete-btn').click()
  await expect(win.getByTestId('confirm-delete')).toBeVisible()

  // 切换修饰键+数字是窗口级监听，模态框开着也能切走（macOS 为 ⌘，其余平台为 Alt）。
  // 切换必须重挂载详情：修复前确认框会留在 B 的详情上（错实例删除）；修复后随重挂载整体消失。
  const switchMod = process.platform === 'darwin' ? 'Meta' : 'Alt'
  await win.keyboard.press(`${switchMod}+2`)
  await expect(win.getByTestId('confirm-delete')).toBeHidden()
  await expect(win.getByRole('heading', { name: '守卫实例二' })).toBeVisible()

  // 没有发生误删：两个实例都还在
  const names = await win.evaluate(async () => {
    const r = await window.dshHub.instances.list()
    return r.ok ? r.value.map((instance) => instance.name) : []
  })
  expect(names).toEqual(['守卫实例一', '守卫实例二'])
})

test('主题偏好跨重启持久化', async () => {
  test.setTimeout(90_000)
  await win.getByTestId('settings-btn').click()
  await expect(win.getByTestId('view-settings')).toBeVisible()
  await win.getByTestId('settings-theme-dark').click()
  await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')

  // 关闭并以同一数据目录重启：偏好必须从 settings.json 水合回来
  await app.close()
  app = await electron.launch({
    args: buildLaunchArgs(),
    env: e2eEnv(DATA_DIR)
  })
  win = await app.firstWindow()
  await expect(win.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(() => win.evaluate(() => document.documentElement.dataset.theme), { timeout: 15_000 })
    .toBe('dark')
  // 设置页读回的也是持久化后的值
  await win.getByTestId('settings-btn').click()
  await expect(win.getByTestId('settings-theme-dark')).toHaveAttribute('class', /btn-primary/)
})
