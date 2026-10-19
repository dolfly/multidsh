import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * 设置页说明图标：长说明收进问号气泡，hover 或键盘聚焦展开、点击不钉住；
 * 图标紧跟在文案之后（不在行尾）。同时守住两处结构：
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

test('说明图标：hover 展开、点击不钉住、键盘聚焦仍展开', async () => {
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
  await expect(
    win.locator('[data-testid="view-settings"] .meta').filter({ hasText: 'git/node' })
  ).toHaveCount(0)

  // 图标紧跟文案之后：复选框行里 label 与图标是仅有的两个相邻子元素。
  // has 内的定位器会以候选行为根重新求根，必须给相对选择器（不能带 card 那段链）。
  const sleepRow = card
    .locator('.row')
    .filter({ has: win.getByTestId('settings-prevent-sleep') })
    .filter({ has: win.locator('.info-tip') })
  expect(
    await sleepRow.evaluate((element) => {
      const children = element.children
      return (
        children.length === 2 &&
        children[0]?.tagName === 'LABEL' &&
        children[1]?.classList.contains('info-tip')
      )
    })
  ).toBe(true)

  // hover 展开。
  await expect.poll(() => bubbleOpacity(bubble)).toBe('0')
  await tip.locator('.info-tip-btn').hover()
  await expect.poll(() => bubbleOpacity(bubble)).toBe('1')

  // 点击不钉住：点击后移开鼠标，气泡随之收起，不在卡片上残留。
  await tip.locator('.info-tip-btn').click()
  await win.mouse.move(4, 4)
  await expect.poll(() => bubbleOpacity(bubble)).toBe('0')

  // 键盘聚焦仍展开（Tab 往返把焦点经键盘送回图标）。
  await win.keyboard.press('Tab')
  await win.keyboard.press('Shift+Tab')
  await expect.poll(() => bubbleOpacity(bubble)).toBe('1')
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

test('刷新环境缓存：无运行实例只出结果 toast，不弹重启确认', async () => {
  test.setTimeout(60_000)
  // 承接上一条：设置页仍打开、本机无运行实例。
  // 先等勾选留下的「设置已保存」toast 消失，确保新 toast 来自本次刷新。
  await expect(win.getByTestId('toast')).toHaveCount(0, { timeout: 15_000 })
  // 冷缓存要先解析登录环境再失效重解析，两轮子进程解析给足超时预算。
  await win.getByTestId('settings-refresh-env').click()
  const toast = win.getByTestId('toast').first()
  await expect(toast).toBeVisible({ timeout: 30_000 })
  // 结果 toast（有变化 / 无变化 / 不可比 / 失败）都要落在环境刷新这条语义上
  await expect(toast).toContainText(/环境|nvironment/i)
  // 没有可重启的实例，不该出现重启确认框
  await expect(win.getByTestId('settings-confirm-restart-env')).toHaveCount(0)
})
