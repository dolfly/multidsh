import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, _electron as electron } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'

// 默认写进被 Git 忽略的 hub-data/，避免每次跑 E2E 都弄脏受版本控制的文档截图；
// 需要刷新 README 里的文档截图时显式 DOCS_SHOTS=1 才写回 docs/images。
const SHOT_DIR =
  process.env.DOCS_SHOTS === '1'
    ? resolve(process.cwd(), 'docs', 'images')
    : resolve(process.cwd(), 'hub-data', 'e2e-shots')
const DATA_DIR = e2eDataDir('e2e-screenshot')

test('截图：首页 + 暗色主题 + 收起侧边栏', async () => {
  test.setTimeout(30_000)
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(SHOT_DIR, { recursive: true })
  await mkdir(DATA_DIR, { recursive: true })

  const args = buildLaunchArgs()

  const app = await electron.launch({
    args,
    env: e2eEnv(DATA_DIR)
  })
  const win = await app.firstWindow()
  await expect(win.getByTestId('app-shell')).toBeVisible({ timeout: 10_000 })
  await win.waitForTimeout(500)

  // 创建5个 mock 实例
  await win.evaluate(async () => {
    const instances = [
      { name: '本地开发环境', transport: 'local' as const, authMode: 'auto' as const },
      {
        name: '生产服务器',
        transport: 'ssh' as const,
        authMode: 'auto' as const,
        host: '192.168.1.100',
        username: 'deploy',
        port: 22,
        remotePort: 3080
      },
      {
        name: '远程网关',
        transport: 'http' as const,
        authMode: 'auto' as const,
        endpointUrl: 'https://dsh.example.com'
      },
      { name: '测试环境', transport: 'local' as const, authMode: 'none' as const },
      {
        name: 'Staging 服务器',
        transport: 'http' as const,
        authMode: 'gateway' as const,
        endpointUrl: 'https://staging.dsh.internal:8443'
      }
    ]
    for (const inst of instances) {
      await window.dshHub.instances.create(inst)
    }
  })

  // 刷新让列表同步
  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible({ timeout: 10_000 })
  await win.waitForTimeout(500)

  // 检测当前主题
  const currentTheme = await win.evaluate(() => document.documentElement.dataset.theme)
  const isLight = currentTheme !== 'dark'

  if (isLight) {
    // 亮色主题首页
    await win.screenshot({ path: join(SHOT_DIR, 'home-overview.png'), animations: 'disabled' })
    // 切到暗色
    const toggle = win.getByTestId('theme-toggle')
    await toggle.click({ timeout: 3000 })
    await win.waitForTimeout(300)
    await win.screenshot({ path: join(SHOT_DIR, 'dark-theme.png'), animations: 'disabled' })
    // 收起侧边栏
    const collapseBtn = win.getByTestId('sidebar-collapse-btn')
    await collapseBtn.click({ timeout: 3000 })
    await win.waitForTimeout(300)
    await win.screenshot({ path: join(SHOT_DIR, 'sidebar-collapsed.png'), animations: 'disabled' })
  } else {
    // 暗色主题在先
    await win.screenshot({ path: join(SHOT_DIR, 'dark-theme.png'), animations: 'disabled' })
    // 收起侧边栏
    const collapseBtn = win.getByTestId('sidebar-collapse-btn')
    await collapseBtn.click({ timeout: 3000 })
    await win.waitForTimeout(300)
    await win.screenshot({ path: join(SHOT_DIR, 'sidebar-collapsed.png'), animations: 'disabled' })
    // 展开侧边栏
    await collapseBtn.click({ timeout: 3000 })
    await win.waitForTimeout(300)
    // 切到亮色
    const toggle = win.getByTestId('theme-toggle')
    await toggle.click({ timeout: 3000 })
    await win.waitForTimeout(300)
    await win.screenshot({ path: join(SHOT_DIR, 'home-overview.png'), animations: 'disabled' })
  }

  await app.close()
})
