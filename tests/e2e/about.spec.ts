import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import { closeAboutWithEscape, expectAboutClosed, openAboutViaMenu, openAboutViaSettings } from './about-menu'
import type { ElectronApplication, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * 「关于」面板：应用菜单项打开**独立叠加窗口**（`?window=about`，与宿主窗口
 * 完全重合的透明子窗口），展示项目主页入口与运行组件版本。
 * 面板浮在宿主窗口（含内嵌工作区）之上，宿主页面路由全程不变；
 * 右上角、遮罩、Escape 三种途径关闭的都是该窗口本身。
 * 前置：`pnpm build`。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-about')
const SHOT_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-about-shots')
const expectedVersion = (
  JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string
  }
).version

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(SHOT_DIR, { recursive: true })
  app = await electron.launch({
    args: buildLaunchArgs(),
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

test('应用菜单的「关于」项打开叠加窗口,并展示版本与运行组件版本', async () => {
  await expect(win.getByTestId('app-shell')).toBeVisible()

  const about = await openAboutViaMenu(app)
  await expect(about.getByTestId('about-version')).toHaveText(`DSH Hub v${expectedVersion}`)
  await expect(about.getByTestId('about-homepage')).toBeVisible()

  // 叠加窗口自身背景必须透明(含遮罩关闭 backdrop-filter),否则会盖住下层宿主与工作区。
  await expect
    .poll(() => about.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe('rgba(0, 0, 0, 0)')
  await expect.poll(() => about.evaluate(() => getComputedStyle(document.querySelector('.overlay')!).backdropFilter)).toBe('none')

  // 组件版本必须与主进程实际运行的一致（Chromium 即前面升级到的 152 线）。
  const realChrome = await app.evaluate(() => process.versions.chrome)
  await expect(about.getByTestId('about-chromium')).toHaveText(realChrome)
  await expect(about.getByTestId('about-electron')).not.toBeEmpty()

  // 目验材料:叠加窗口里的对话框(容器聚焦不画焦点描边)。
  await about.screenshot({ path: join(SHOT_DIR, 'about-window.png'), animations: 'disabled' })

  // 关闭按钮收起的是整个叠加窗口
  await about.getByTestId('about-dialog').getByRole('button', { name: /关闭|Close/ }).click()
  await expectAboutClosed(app)
})

test('面板叠加在宿主页面上且 Escape 可关闭（不跳回实例列表）', async () => {
  await expect(win.getByTestId('app-shell')).toBeVisible()
  // 播种一个实例并进入详情页，作为「当前页面」的锚点。
  const created = await win.evaluate(async () =>
    window.dshHub.instances.create({ transport: 'local', name: '关于面板锚点实例', authMode: 'auto' })
  )
  expect(created.ok).toBe(true)
  await win.reload()
  await expect(win.getByTestId('instances-table')).toContainText('关于面板锚点实例')
  await win.getByTestId('instances-table').getByText('关于面板锚点实例', { exact: true }).click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  const about = await openAboutViaMenu(app)

  // 核心断言:面板打开后宿主仍停在实例详情,而不是跳回实例列表。
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByTestId('instances-table')).toBeHidden()

  // Escape 在叠加窗口内处理,关闭该窗口本身。
  await closeAboutWithEscape(about)
  await expectAboutClosed(app)
  // 关闭面板后宿主仍在详情页。
  await expect(win.getByTestId('view-detail')).toBeVisible()
})

test('在列表页与设置页打开面板都停留在当前页，关闭后同样不跳转', async () => {
  // 列表页(总览)。
  await win.getByTestId('brand').click()
  await expect(win.getByTestId('instances-table')).toBeVisible()
  let about = await openAboutViaMenu(app)
  await expect(win.getByTestId('instances-table')).toBeVisible()
  await closeAboutWithEscape(about)
  await expectAboutClosed(app)
  await expect(win.getByTestId('instances-table')).toBeVisible()

  // 设置页:面板叠加,不退出设置。
  await win.getByTestId('settings-btn').click()
  await expect(win.getByTestId('view-settings')).toBeVisible()
  about = await openAboutViaMenu(app)
  await expect(win.getByTestId('view-settings')).toBeVisible()
  await closeAboutWithEscape(about)
  await expectAboutClosed(app)
  await expect(win.getByTestId('view-settings')).toBeVisible()
})

test('设置页「关于」触发点打开叠加窗口（无菜单栏平台的入口）', async () => {
  await win.getByTestId('settings-btn').click()
  await expect(win.getByTestId('view-settings')).toBeVisible()
  const about = await openAboutViaSettings(app, win)
  await expect(about.getByTestId('about-version')).toHaveText(`DSH Hub v${expectedVersion}`)
  // 打开面板不改变宿主页面路由。
  await expect(win.getByTestId('view-settings')).toBeVisible()
  await closeAboutWithEscape(about)
  await expectAboutClosed(app)
  await expect(win.getByTestId('view-settings')).toBeVisible()
})

test('数据列点击复制：就地反馈已复制，剪贴板拿到与展示一致的值', async () => {
  const about = await openAboutViaMenu(app)
  const realChrome = await app.evaluate(() => process.versions.chrome)
  const cell = about.getByTestId('about-chromium')

  // 未交互时只是纯文本；hover 才露出复制 affordance（图标常驻占位，这里只验证可点与状态标记）。
  await cell.locator('button').click()
  await expect(cell.locator('button')).toHaveAttribute('data-copied', 'true')
  // 复制的是展示值本身：主进程读系统剪贴板核对。
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(copied).toBe(realChrome)

  // 反馈短暂停留后复位为可再次复制的状态。
  await expect(cell.locator('button')).not.toHaveAttribute('data-copied', 'true', { timeout: 4_000 })

  await closeAboutWithEscape(about)
  await expectAboutClosed(app)
})
