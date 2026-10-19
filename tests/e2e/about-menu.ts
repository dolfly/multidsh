import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

/** 菜单文案跟随语言（zh / en 两种形态）；只认「关于」这一项，忽略 Hide/Quit 等标准项。 */
const ABOUT_LABEL = /^(关于 DSH Hub|About DSH Hub)$/

/**
 * 走真实菜单项点击（不是直接发通道）：菜单未接上时返回 false，由调用方重试。
 */
export async function clickAboutMenuItem(app: ElectronApplication): Promise<boolean> {
  return await app.evaluate(({ Menu }, pattern) => {
    const matches = new RegExp(pattern)
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (matches.test(item.label ?? '')) return item
        const found = item.submenu ? walk(item.submenu.items) : null
        if (found) return found
      }
      return null
    }
    const target = walk(Menu.getApplicationMenu()?.items ?? [])
    if (!target) return false
    target.click()
    return true
  }, ABOUT_LABEL)
}

/** 「关于」是独立叠加窗口（`?window=about`）；返回其页面，尚未创建时返回 undefined。 */
export function aboutPage(app: ElectronApplication): Page | undefined {
  return app.windows().find((page) => page.url().includes('window=about'))
}

/**
 * 点菜单并等待「关于」窗口及其对话框就绪。
 * 重复点击是幂等的（已存在时只聚焦），因此可安全重试。
 */
export async function openAboutViaMenu(app: ElectronApplication): Promise<Page> {
  let about: Page | undefined
  await expect(async () => {
    expect(await clickAboutMenuItem(app)).toBe(true)
    about = aboutPage(app)
    expect(about).toBeTruthy()
    await about?.getByTestId('about-dialog').waitFor({ state: 'visible' })
  }).toPass({ timeout: 15_000 })
  if (!about) throw new Error('关于窗口未出现')
  return about
}

/**
 * 从设置页的「关于」触发点打开面板（Windows/Linux 无菜单栏时的入口）。
 * 调用前需已停在设置页。
 */
export async function openAboutViaSettings(app: ElectronApplication, win: Page): Promise<Page> {
  let about: Page | undefined
  await expect(async () => {
    await win.getByTestId('settings-open-about').click()
    about = aboutPage(app)
    expect(about).toBeTruthy()
    await about?.getByTestId('about-dialog').waitFor({ state: 'visible' })
  }).toPass({ timeout: 15_000 })
  if (!about) throw new Error('关于窗口未出现')
  return about
}

/** 等待「关于」窗口已关闭（三种关闭途径共用的断言前置）。 */
export async function expectAboutClosed(app: ElectronApplication): Promise<void> {
  await expect.poll(() => aboutPage(app)).toBeUndefined()
}

/**
 * 在「关于」窗口按 Escape 关闭它。keydown 同步执行 window.close()，
 * press 的 keyup 随后会投递到已销毁的 webContents 而报 target closed ——
 * 该竞态错误在这里吞掉，关闭结果由前置(对话框可见)与 expectAboutClosed 断言。
 */
export async function closeAboutWithEscape(about: Page): Promise<void> {
  await expect(about.getByTestId('about-dialog')).toBeVisible()
  await about.keyboard.press('Escape').catch(() => undefined)
}

/**
 * 点「关于」窗口的关闭按钮收起叠加窗口。click 的合成鼠标事件同步执行 window.close()，
 * 紧随其后的 mouseup/收尾请求会打到已销毁的 webContents 而报 target closed —— 与
 * closeAboutWithEscape 同一竞态，错误在此吞掉，关闭结果由 expectAboutClosed 断言。
 */
export async function closeAboutWithButton(about: Page): Promise<void> {
  await expect(about.getByTestId('about-dialog')).toBeVisible()
  await about
    .getByTestId('about-dialog')
    .getByRole('button', { name: /关闭|Close/ })
    .click()
    .catch(() => undefined)
}
