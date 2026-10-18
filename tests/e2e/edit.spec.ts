import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * 实例详情和编辑流程的 E2E 验证：
 * - 明文连接警告显示为短标签，完整详情可悬停查看
 * - 实例创建后可编辑（编辑按钮、表单和 `instances:update` 持久化），
 *   本地实例端口可改(留空 = 自动分配)
 * 顺带产出详情页/编辑框截图(用户要求的目验材料)。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-edit')
const REGISTRY_FILE = join(DATA_DIR, 'registry', 'instances.json')
const SHOT_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-edit-shots')

let app: ElectronApplication
let win: Page

const launchArgs = buildLaunchArgs()

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(SHOT_DIR, { recursive: true })
  app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()

  // 播种:1 个本地实例(验证端口编辑)+ 1 个明文 http 实例(验证警告胶囊)
  const local = await win.evaluate(async () =>
    window.dshHub.instances.create({ transport: 'local', name: '可编辑本地实例', authMode: 'auto' })
  )
  expect(local.ok).toBe(true)
  const http = await win.evaluate(async () =>
    window.dshHub.instances.create({
      transport: 'http',
      name: '明文远端实例',
      authMode: 'auto',
      endpointUrl: 'http://remote.example.com/dsh/'
    })
  )
  expect(http.ok).toBe(true)
  // 直接经桥接播种时，首屏的异步列表 hydration 可能仍持有旧快照；刷新后再断言
  // 两条已落盘记录均已进入 renderer，避免把测试初始化竞态误判为工作区行为。
  await win.reload()
  await expect(win.getByTestId('instances-table')).toContainText('明文远端实例')
})

test.afterAll(async () => {
  await app.close()
})

test('明文警告显示为短标签，完整详情通过 data-tip 提供', async () => {
  // 侧栏选中 http 实例(播种的第二个)
  await win.getByTestId('instances-table').isVisible()
  await win.getByText('明文远端实例').first().click()
  // workspace-loading 仅在打开在途时渲染,是瞬态:Windows 上远端域名秒败,
  // 错误态先于可见性轮询到达,断言 loading 必然引入竞态 —— 只断言已进入工作区。
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible()
  await win.getByTestId('workspace-back-btn').click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByTestId('disconnect-view-btn')).toBeVisible()
  await win.getByTestId('disconnect-view-btn').click()
  await expect(win.getByText('工作区已断开')).toBeVisible()

  const pill = win.getByTestId('cleartext-warning')
  await expect(pill).toBeVisible()
  // 胶囊本体是短标签,不含整段长文案
  await expect(pill).toContainText('未加密')
  // 完整详情通过 data-tip 的 CSS 气泡显示，aria-label 保留读屏语义。
  const tip = await pill.getAttribute('data-tip')
  expect(tip).toContain('http://')
  expect(tip).toContain('SSH')
  expect(await pill.getAttribute('aria-label')).toBe(tip)

  // 「连接方式」「运行环境」两张事实卡放开文本选中（body 默认 user-select:none）。
  const selectable = await win.evaluate(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.detail-page .card.selectable'))
    return {
      count: cards.length,
      selects: cards.map((card) => getComputedStyle(card).userSelect)
    }
  })
  expect(selectable.count).toBe(2)
  expect(selectable.selects).toEqual(['text', 'text'])
  // 视觉取证:详情页(含胶囊 + 编辑按钮)。
  // animations:'disabled' —— CSS 动画(如 modal fade/rise)快进到终态,避免截到半透明中间帧
  await win.screenshot({ path: join(SHOT_DIR, 'detail-cleartext-pill.png'), animations: 'disabled' })
})

test('本地实例可编辑，端口留空时回到自动分配', async () => {
  const workspaceBack = win.getByTestId('workspace-back-btn')
  if (await workspaceBack.isVisible()) await workspaceBack.click()
  await win.getByTestId('brand').click()
  await expect(win.getByTestId('instances-table')).toBeVisible()
  await win.getByTestId('instances-table').getByText('可编辑本地实例', { exact: true }).click()
  const workspaceBackAfterSelection = win.getByTestId('workspace-back-btn')
  if (await workspaceBackAfterSelection.isVisible()) await workspaceBackAfterSelection.click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  // 编辑入口必须可用。
  await expect(win.getByTestId('edit-btn')).toBeVisible()
  await win.getByTestId('edit-btn').click()
  await expect(win.getByTestId('edit-dialog')).toBeVisible()
  // 截图时禁用动画，避免捕获到半透明的中间帧。
  await win.screenshot({ path: join(SHOT_DIR, 'edit-dialog-open.png'), animations: 'disabled' })

  // Escape 关闭编辑对话框（窗口级关闭栈，焦点无需落在对话框内）。
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('edit-dialog')).toBeHidden()
  // 重新打开继续编辑流程。
  await win.getByTestId('edit-btn').click()
  await expect(win.getByTestId('edit-dialog')).toBeVisible()

  // 打开即聚焦对话框本身;Tab / Shift+Tab 只在对话框内圈闭,不落到背后的主窗口。
  await expect
    .poll(() =>
      win.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')
    )
    .toBe('edit-dialog')
  const focusInside = (): Promise<boolean> =>
    win.evaluate(() => {
      const dialog = document.querySelector('[data-testid="edit-dialog"]')
      return dialog?.contains(document.activeElement) ?? false
    })
  for (let i = 0; i < 12; i += 1) {
    await win.keyboard.press('Tab')
    expect(await focusInside()).toBe(true)
  }
  for (let i = 0; i < 12; i += 1) {
    await win.keyboard.press('Shift+Tab')
    expect(await focusInside()).toBe(true)
  }

  // 端口字段可编辑；名称、启动命令修改，端口设为 30567。
  const portInput = win.getByTestId('edit-port')
  await expect(portInput).toBeVisible()
  await expect(win.getByTestId('edit-launcher')).toBeVisible()
  await win.getByTestId('edit-launcher').selectOption('dush')
  await portInput.fill('30567')
  await win.getByTestId('edit-name').fill('改名后的本地实例')
  await win.getByTestId('edit-save').click()

  await expect(win.getByTestId('edit-dialog')).toBeHidden()
  // 名称出现在侧栏 + 详情标题两处 —— 取详情标题断言(strict 模式单元素)
  await expect(win.getByRole('heading', { name: '改名后的本地实例' })).toBeVisible()

  // 落盘校验:注册表文件里 name + port 都更新了
  const file = JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) as {
    instances: Array<{ name: string; port: number | null; launcher: string | null }>
  }
  const edited = file.instances.find((item) => item.name === '改名后的本地实例')
  expect(edited).toBeDefined()
  expect(edited?.port).toBe(30567)
  expect(edited?.launcher).toBe('dush')

  // 再编辑:端口清空 → null(回到自动分配)
  await win.getByTestId('edit-btn').click()
  await expect(win.getByTestId('edit-dialog')).toBeVisible()
  await win.getByTestId('edit-port').fill('')
  await win.getByTestId('edit-save').click()
  await expect(win.getByTestId('edit-dialog')).toBeHidden()
  const file2 = JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) as {
    instances: Array<{ name: string; port: number | null }>
  }
  const cleared = file2.instances.find((item) => item.name === '改名后的本地实例')
  expect(cleared?.port).toBeNull()
  await win.screenshot({ path: join(SHOT_DIR, 'edit-saved.png'), animations: 'disabled' })
})

test('本机编辑对话框可切换安装镜像，保存后 settings.json 落盘', async () => {
  // 选中上个用例改过名的本机实例（编辑入口在详情页）。
  await win.getByTestId('brand').click()
  await expect(win.getByTestId('instances-table')).toBeVisible()
  await win.getByTestId('instances-table').getByText('改名后的本地实例', { exact: true }).click()
  const workspaceBack = win.getByTestId('workspace-back-btn')
  if (await workspaceBack.isVisible()) await workspaceBack.click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await win.getByTestId('edit-btn').click()
  const dialog = win.getByTestId('edit-dialog')
  await expect(dialog).toBeVisible()

  const registry = win.getByTestId('edit-registry')
  await expect(registry).toBeVisible()
  // 新数据目录：镜像未设置 → 跟随系统；两档预设与自定义都可选。
  await expect(registry).toHaveValue('system')
  await expect(registry).toContainText('npmmirror')
  await expect(registry).toContainText('npmjs')
  await expect(registry).toContainText('自定义')
  // 作用范围写明是应用级设置：用户要知道改的不是单个实例的私有字段。
  await expect(dialog).toContainText('应用级设置')

  // 自定义档只切出 URL 输入框，不改当前值。
  await registry.selectOption('custom')
  await expect(win.getByTestId('edit-registry-url')).toBeVisible()
  // 切到 npmjs 预设：输入框收回。
  await registry.selectOption('https://registry.npmjs.org')
  await expect(win.getByTestId('edit-registry-url')).toHaveCount(0)

  await win.getByTestId('edit-save').click()
  await expect(dialog).toBeHidden()
  const saved = JSON.parse(await readFile(join(DATA_DIR, 'settings.json'), 'utf8')) as {
    npmRegistry: string
  }
  expect(saved.npmRegistry).toBe('https://registry.npmjs.org')

  // 重开回读：仍选中 npmjs 档；改回跟随系统后再次落盘。
  await win.getByTestId('edit-btn').click()
  await expect(win.getByTestId('edit-registry')).toHaveValue('https://registry.npmjs.org')
  await win.getByTestId('edit-registry').selectOption('system')
  await win.getByTestId('edit-save').click()
  await expect(dialog).toBeHidden()
  const restored = JSON.parse(await readFile(join(DATA_DIR, 'settings.json'), 'utf8')) as {
    npmRegistry: string
  }
  expect(restored.npmRegistry).toBe('')
})
