import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * 渲染层端到端：空态、创建、列表、详情和删除。
 * 说明:本地分支创建后会自动触发启动,在受限/CI 环境里安装可能失败,但本用例
 * 只断言 UI 与注册表结果,启动结果由 status 事件另行覆盖(见 local-runtime 单测)。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-ui')

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

test('空态 → 向导三步创建本地实例 → 表格与侧栏可见', async () => {
  await expect(win.getByTestId('view-empty')).toBeVisible()
  await win.getByTestId('empty-new-btn').click()

  // 第 1 步:连接方式(默认本地)
  await expect(win.getByTestId('wizard')).toBeVisible()
  await expect(win.getByTestId('type-local')).toHaveAttribute('aria-pressed', 'true')
  await win.getByRole('button', { name: '下一步' }).click()

  // 第 2 步:空名称先显示校验错误；输入名称后错误应立即消失。
  await expect(win.getByTestId('wizard-step-2')).toBeVisible()
  await win.getByRole('button', { name: '下一步' }).click()
  await expect(win.getByText('请填写实例名称')).toBeVisible()
  await win.getByTestId('wizard-name').fill('E2E 演示实例')
  await win.locator('[data-testid="wizard-step-2"] details.adv > summary').click()
  await expect(win.getByTestId('wizard-launcher')).toHaveValue('dsh')
  // dsh 恒在且为默认；dush/duush 只在本机探测到时才渲染（未检测到直接隐藏，不是禁用）。
  // 选项集合随宿主安装状态变化，故只断言集合约束，不断言具体数量。
  const launcherOptions = await win
    .getByTestId('wizard-launcher')
    .evaluate((select) =>
      Array.from((select as HTMLSelectElement).options).map((option) => option.value)
    )
  expect(launcherOptions[0]).toBe('dsh')
  expect(new Set(launcherOptions).size).toBe(launcherOptions.length)
  expect(launcherOptions.every((value) => ['dsh', 'dush', 'duush'].includes(value))).toBe(true)
  await expect(win.getByTestId('wizard-launcher').locator('option:disabled')).toHaveCount(0)
  // 版本管理下拉已接线：选项首项恒为「跟随最新版本」（空值），与镜像拉取结果无关（离线安全）。
  await expect(win.getByTestId('wizard-version')).toBeVisible()
  await expect(win.getByTestId('wizard-version').locator('option').first()).toHaveAttribute(
    'value',
    ''
  )
  await expect(win.getByText('请填写实例名称')).toBeHidden()
  await win.getByRole('button', { name: '下一步' }).click()

  // 第 3 步:确认并创建
  await expect(win.getByTestId('wizard-step-3')).toBeVisible()
  await expect(win.getByText('E2E 演示实例')).toBeVisible()
  await win.getByTestId('wizard-create').click()

  // 创建后先展示详情；启动失败时用户仍可立即编辑本地配置。
  await expect(win.getByTestId('wizard')).toBeHidden()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByRole('heading', { name: 'E2E 演示实例' })).toBeVisible()
  await win.getByTestId('detail-overview-btn').click()
  await expect(win.getByTestId('view-home')).toBeVisible()
  const table = win.getByTestId('instances-table')
  await expect(table).toContainText('E2E 演示实例')
  await expect(table).toContainText('本地')
  const deleteFromHome = table.getByTestId(/delete-/)
  await deleteFromHome.click()
  await expect(win.getByTestId('home-confirm-delete')).toBeVisible()
  await win.getByTestId('home-confirm-delete').getByRole('button', { name: '取消' }).click()
  await expect(win.getByTestId('home-confirm-delete')).toBeHidden()
})

test('按住修饰键显示序号,修饰键+数字切换实例', async () => {
  test.setTimeout(60_000)
  // 切换修饰键随平台:macOS 为 ⌘(Meta),其余平台(Windows/Linux)为 Alt。
  const switchMod = process.platform === 'darwin' ? 'Meta' : 'Alt'
  const switchModLower = process.platform === 'darwin' ? 'meta' : 'alt'
  const listIds = async (): Promise<string[]> => {
    const listed = await win.evaluate(async () => {
      const r = await window.dshHub.instances.list()
      return r.ok ? r.value.map((instance) => instance.id) : []
    })
    return listed
  }
  const createHttpInstance = async (name: string, endpointUrl: string): Promise<string> =>
    win.evaluate(
      async (input) => {
        const created = await window.dshHub.instances.create({
          transport: 'http',
          name: input.name,
          authMode: 'none',
          endpointUrl: input.endpointUrl
        })
        if (!created.ok) throw new Error(created.message)
        return created.value.id
      },
      { name, endpointUrl }
    )

  // 演示实例挪到末尾:切换只落在本用例的实例上,后置用例依赖演示实例排在侧栏首位。
  const demoId = (await listIds())[0]!
  const aId = await createHttpInstance('快捷键实例一', 'https://hotkey-a.example.com/dsh')
  const bId = await createHttpInstance('快捷键实例二', 'https://hotkey-b.example.com/dsh')
  const reordered = await win.evaluate(
    async (order) => {
      const r = await window.dshHub.instances.reorder(order)
      return r.ok
    },
    [aId, bId, demoId]
  )
  expect(reordered).toBe(true)
  await win.reload()
  await expect(win.getByTestId('view-home')).toBeVisible()
  expect(await listIds()).toEqual([aId, bId, demoId])

  const reachedTerminal = async (): Promise<boolean> => {
    const back = await win
      .getByTestId('workspace-back-btn')
      .isVisible()
      .catch(() => false)
    const detail = await win
      .getByTestId('view-detail')
      .isVisible()
      .catch(() => false)
    return back || detail
  }
  // 切换的终态有两种:工作区打开,或回落详情页(启动失败/被拒)。
  const expectShowing = async (name: string): Promise<void> => {
    if (
      await win
        .getByTestId('workspace-back-btn')
        .isVisible()
        .catch(() => false)
    ) {
      await expect(win.getByTestId('tb-title')).toHaveText(name)
    } else {
      await expect(win.getByRole('heading', { name })).toBeVisible()
    }
  }
  const backHome = async (): Promise<void> => {
    const back = win.getByTestId('workspace-back-btn')
    if (await back.isVisible().catch(() => false)) {
      await back.click()
      await expect(win.getByTestId('view-detail')).toBeVisible()
    }
    await win.getByTestId('detail-overview-btn').click()
    await expect(win.getByTestId('view-home')).toBeVisible()
  }

  const badge1 = win.getByTestId('hotkey-badge-1')
  // 不按修饰键时不显示序号
  await expect(badge1).toBeHidden()

  // 按住切换修饰键:满 0.5 秒延迟窗口后序号才显示,松开即收起
  await win.keyboard.down(switchMod)
  await expect(badge1).toBeHidden()
  await expect(badge1).toBeVisible()
  await expect(badge1).toHaveText('#1')
  await expect(win.getByTestId(`inst-${aId}`).getByTestId('hotkey-badge-1')).toBeVisible()
  await expect(win.getByTestId(`inst-${bId}`).getByTestId('hotkey-badge-2')).toHaveText('#2')
  await expect(win.getByTestId(`inst-${demoId}`).getByTestId('hotkey-badge-3')).toHaveText('#3')
  // 序号只覆盖存在的行,不存在的 #4 不渲染
  await expect(win.getByTestId('hotkey-badge-4')).toHaveCount(0)
  await win.keyboard.up(switchMod)
  await expect(badge1).toBeHidden()

  // 切换不等显示:角标还在延迟窗口内,数字键已切到首行实例
  await win.keyboard.down(switchMod)
  await expect(badge1).toBeHidden()
  await win.keyboard.down('1')
  await win.keyboard.up('1')
  await expect(win.getByTestId(`inst-${aId}`)).toHaveAttribute('aria-current', 'true')
  // 切换完成时角标仍未显示 → 切换没有等这 0.5 秒
  await expect(badge1).toBeHidden()
  await win.keyboard.up(switchMod)
  await expect.poll(reachedTerminal, { timeout: 20_000 }).toBe(true)
  await expectShowing('快捷键实例一')
  await backHome()

  // 切换修饰键+2 → 切换到第二行实例
  await win.keyboard.press(`${switchMod}+2`)
  await expect.poll(reachedTerminal, { timeout: 20_000 }).toBe(true)
  await expectShowing('快捷键实例二')

  // 工作区可能回落到了详情页:补开工作区,进入原生视图持焦的场景。
  const back = win.getByTestId('workspace-back-btn')
  if (!(await back.isVisible().catch(() => false))) {
    const openBtn = win.getByTestId('open-view-btn')
    await expect(openBtn).toBeVisible()
    await openBtn.click()
    await expect(back).toBeVisible({ timeout: 20_000 })
  }

  // 原生工作区持有真实键盘焦点:按键只进原生视图,需经主进程白名单转发。
  // Playwright 的键盘事件直接注入 hub 渲染层,因此这里用 sendInputEvent 注入视图。
  const sendToWorkspace = async (events: unknown[]): Promise<void> => {
    await app.evaluate((_electron, sent) => {
      const area = (view: { getBounds?: () => { width: number; height: number } }): number => {
        const bounds = view.getBounds?.()
        return (bounds?.width ?? 0) * (bounds?.height ?? 0)
      }
      const host = _electron.BrowserWindow.getAllWindows().find(
        (candidate) => candidate.contentView.children.length > 0
      )
      const target = (host?.contentView.children ?? [])
        .map(
          (child) =>
            child as {
              getBounds?: () => { width: number; height: number }
              webContents?: { sendInputEvent: (event: unknown) => void }
            }
        )
        .filter((child) => child.webContents !== undefined)
        .sort((a, b) => area(b) - area(a))[0]
      if (!target?.webContents) throw new Error('工作区视图不存在')
      for (const event of sent) target.webContents.sendInputEvent(event)
    }, events)
  }

  // 切换修饰键注入原生视图 → hub 渲染层收到转发,序号照常显示
  await sendToWorkspace([{ type: 'keyDown', keyCode: switchMod }])
  await expect(badge1).toBeVisible()

  // 视图内 修饰键+1 → 切回首行实例(转发链路:视图输入 → 白名单过滤 → 窗口事件)
  await sendToWorkspace([{ type: 'keyDown', keyCode: '1', modifiers: [switchModLower] }])
  await expect.poll(reachedTerminal, { timeout: 20_000 }).toBe(true)
  await expectShowing('快捷键实例一')

  // 释放切换修饰键从窗口侧注入(切换后焦点已离开原视图)→ 序号收起
  await win.keyboard.up(switchMod)
  await expect(badge1).toBeHidden()

  // 清理:回首页并删除本用例创建的实例,演示实例回到侧栏首位(后置用例的前置)
  await backHome()
  const table = win.getByTestId('instances-table')
  for (const id of [aId, bId]) {
    await table.getByTestId(`delete-${id}`).click()
    await expect(win.getByTestId('home-confirm-delete')).toBeVisible()
    await win
      .getByTestId('home-confirm-delete')
      .getByRole('button', { name: '删除', exact: true })
      .click()
    await expect(win.getByTestId(`inst-${id}`)).toBeHidden()
  }
  await expect(win.getByTestId('view-home')).toBeVisible()
  await expect(win.locator('[data-testid^="inst-"]').first()).toHaveAttribute(
    'data-testid',
    `inst-${demoId}`
  )
})

test('侧栏实例名称进入工作区或错误详情，随后可删除实例', async () => {
  // 确保在首页视图
  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 10_000 })
  await expect(win.getByTestId('instances-table')).toBeVisible()
  const firstSidebarItem = win.locator('[data-testid^="inst-"]').first()
  await firstSidebarItem.click()
  await expect
    .poll(async () => {
      const workspaceLoading = await win
        .getByTestId('workspace-loading')
        .isVisible()
        .catch(() => false)
      const detail = await win
        .getByTestId('view-detail')
        .isVisible()
        .catch(() => false)
      return workspaceLoading || detail
    })
    .toBe(true)
  const workspaceOpened = await win
    .getByTestId('workspace-loading')
    .isVisible()
    .catch(() => false)
  if (workspaceOpened) {
    // loading 消失后的确定终态有两种:工作区打开(启动成功)或回落详情页(启动被拒/失败)。
    await expect
      .poll(async () => {
        const back = await win
          .getByTestId('workspace-back-btn')
          .isVisible()
          .catch(() => false)
        const detail = await win
          .getByTestId('view-detail')
          .isVisible()
          .catch(() => false)
        return back || detail
      })
      .toBe(true)
    const opened = await win
      .getByTestId('workspace-back-btn')
      .isVisible()
      .catch(() => false)
    if (opened) {
      const toolbarLayout = await win.evaluate(() => {
        const topbar = document.querySelector('.topbar')?.getBoundingClientRect()
        const back = document
          .querySelector('[data-testid="workspace-back-btn"]')
          ?.getBoundingClientRect()
        return topbar && back ? { topbarRight: topbar.right, backRight: back.right } : null
      })
      expect(toolbarLayout).not.toBeNull()
      if (toolbarLayout)
        expect(toolbarLayout.topbarRight - toolbarLayout.backRight).toBeLessThanOrEqual(16)
      await win.getByTestId('workspace-back-btn').click()
    }
  }
  await expect(win.getByTestId('view-detail')).toBeVisible()
  // 底部信息栏常驻详情页（空态或已有活动日志）。
  await expect(win.getByTestId('detail-logbar')).toBeVisible()
  const deleteButton = win.getByTestId('delete-btn')
  await expect(deleteButton).toBeVisible()
  const deleteMetrics = await deleteButton.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height }
  })
  expect(deleteMetrics.height).toBeGreaterThanOrEqual(46)
  const deletePosition = await win.evaluate(() => {
    const button = document.querySelector('[data-testid="delete-btn"]')
    if (!button) return null
    const box = button.getBoundingClientRect()
    const style = getComputedStyle(button)
    return {
      right: window.innerWidth - box.right,
      bottom: window.innerHeight - box.bottom,
      position: style.position
    }
  })
  // 删除按钮悬在底部信息栏之上（信息栏 44px + 16px 间隙），右缘 20px。
  expect(deletePosition).toEqual({ right: 20, bottom: 60, position: 'fixed' })
  const overviewMetrics = await win.getByTestId('detail-overview-btn').evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height }
  })
  expect(overviewMetrics.width).toBeGreaterThan(overviewMetrics.height)
  await expect(win.getByTestId('detail-overview-btn')).toHaveCSS('white-space', 'nowrap')
  await expect(win.getByTestId('detail-delete-area')).toBeVisible()

  // 删除(二次确认)→ 回空态
  await deleteButton.click()
  await expect(win.getByTestId('confirm-delete')).toBeVisible()
  await win
    .getByTestId('confirm-delete')
    .getByRole('button', { name: '删除', exact: true })
    .click({ force: true })
  await expect(win.getByTestId('view-empty')).toBeVisible()
})
