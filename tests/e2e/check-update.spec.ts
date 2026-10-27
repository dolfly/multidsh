import { _electron as electron, expect, test } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
/**
 * 设置页「检查更新」：入口按钮常驻在「关于」卡片内，点击后经
 * `app:check-update` 走完 IPC 全链路，结果落在原位（最新 / 有新版本）。
 * 结果形态依赖外网是否可达，因此断言「结果区或失败 toast 必有其一」，
 * 不对具体版本号或网络可达性做断言。
 */

const DATA_DIR = e2eDataDir('e2e-check-update')

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

test('设置页提供检查更新入口，检查后就地给出结果或失败提示', async () => {
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await win.getByTestId('settings-btn').click()
  await expect(win.getByTestId('view-settings')).toBeVisible()

  const button = win.getByTestId('settings-check-update')
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled()
  // 文案跟随语言设置（中/英），只认这两种形态。
  await expect(button).toHaveText(/检查更新|Check for updates/)
  // 尚未检查时不显示上一次的结果。
  await expect(win.getByTestId('settings-update-result')).toHaveCount(0)

  await button.click()
  // 通路成功 → 结果区；GitHub 不可达 → 失败 toast；两者都算走完 IPC 全链路。
  await expect(win.getByTestId('settings-update-result').or(win.getByTestId('toast'))).toBeVisible({
    timeout: 20_000
  })
  if (await win.getByTestId('settings-update-result').isVisible()) {
    await expect(win.getByTestId('settings-update-verdict')).not.toHaveText('')
  }
  await expect(button).toBeEnabled()
})
