import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * 设置页说明图标：长说明收进 info 气泡，hover 展开、点击钉住；
 * 钉住态移开鼠标仍显示，点击卡片空白处收起。同时守住两处结构：
 * 说明不再以常驻段落占行，带说明的复选框行拆成 label + 图标后
 * 点 label 仍能切换勾选。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-settings-tip')

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  app = await electron.launch({
    args: buildLaunchArgs(),
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

/** 气泡显示与否由 CSS opacity 决定，读计算样式而不是 toBeVisible。 */
const bubbleOpacity = (bubble: ReturnType<Page['locator']>): Promise<string> =>
  bubble.evaluate((element) => getComputedStyle(element).opacity)

test('说明图标：hover 展开、点击钉住、点击卡片空白处收起', async () => {
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await win.getByTestId('settings-btn').click()
  await expect(win.getByTestId('view-settings')).toBeVisible()

  // 四条说明各占一个图标；git/node 只出现在环境检测那条的中英文文案里。
  const card = win.locator('[data-testid="view-settings"] .card').filter({
    has: win.getByTestId('settings-refresh-env')
  })
  await expect(card.locator('.info-tip')).toHaveCount(4)
  const tip = card.locator('.info-tip').filter({ hasText: 'git/node' })
  await expect(tip).toHaveCount(1)
  const bubble = tip.locator('.info-tip-bubble')

  // 常驻段落已移除：设置视图里不再有承载这段说明的 .meta 行。
  await expect(win.locator('[data-testid="view-settings"] .meta').filter({ hasText: 'git/node' })).toHaveCount(0)

  // hover 展开。
  await expect.poll(() => bubbleOpacity(bubble)).toBe('0')
  await tip.locator('.info-tip-btn').hover()
  await expect.poll(() => bubbleOpacity(bubble)).toBe('1')

  // 点击钉住：移开鼠标后仍显示，aria-expanded 同步为 true。
  const button = tip.locator('.info-tip-btn')
  await button.click()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await win.mouse.move(4, 4)
  await expect.poll(() => bubbleOpacity(bubble)).toBe('1')

  // 点击卡片空白处收起。
  await card.locator('h3').first().click()
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => bubbleOpacity(bubble)).toBe('0')
})

test('带说明的复选框行：点 label 正文仍切换勾选', async () => {
  const box = win.getByTestId('settings-prevent-sleep')
  const before = await box.isChecked()
  const label = win.locator('label').filter({ has: box })
  await label.click()
  await expect(box).toBeChecked({ checked: !before })
  await label.click()
  await expect(box).toBeChecked({ checked: before })
})
