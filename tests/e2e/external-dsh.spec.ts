import { spawn, type ChildProcess } from 'node:child_process'
import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import { closeAboutWithEscape, expectAboutClosed, openAboutViaMenu } from './about-menu'
import { backToOverview } from './overview'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * 外部 dsh web 的 E2E 验证：
 * - HTTP 实例无需启动即可打开视图
 * - 可探测并接管本机已运行的 dsh web，然后直接开窗
 *
 * 假 dsh web:用 `node -e` 起一个**监听端口的进程**,并让它的命令行包含
 * `dsh web --patch <file>`(探测器按命令行识别,不依赖真实 dsh 安装)。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-external')
const SHOT_DIR = resolve(__dirname, '..', '..', 'hub-data', 'ui-polish-shots')

let app: ElectronApplication
let win: Page
let fakeDsh: ChildProcess | null = null
let fakeDshPort: number | null = null
let fakeGatewayPort: number | null = null

const launchArgs = buildLaunchArgs()

/**
 * 打开新建向导到「配置」步并等待外部 dsh 扫描结果卡片出现。
 *
 * Windows 扫描走 PowerShell/CIM + netstat,冷启动慢且偶发单次失败;失败时
 * 扫描退化为空结果,向导在本次打开期间不再重扫,故等待超时后关掉向导重开,
 * 触发一次新的扫描。两轮各自等待 30s,覆盖扫描器最坏预算(PowerShell 15s +
 * netstat 10s)加渲染余量。
 */
async function openWizardAwaitingExternalScan(): Promise<Locator> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await win.getByTestId('new-instance-btn').click()
    await win.getByRole('button', { name: '下一步' }).click()
    const external = win.getByTestId('wizard-external-dsh')
    try {
      await expect(external).toBeVisible({ timeout: 30_000 })
      return external
    } catch (error) {
      if (attempt === 1) throw error
      await win.getByTestId('wizard').getByRole('button', { name: '关闭' }).click()
      await expect(win.getByTestId('wizard')).toBeHidden()
    }
  }
  throw new Error('unreachable')
}

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(SHOT_DIR, { recursive: true })

  const script = [
    "const http = require('node:http')",
    // HTML 必须显式声明 UTF-8(响应头 + meta):缺省时 Chromium 按非 UTF-8 猜测编码,中文渲染成乱码
    `const server = http.createServer((req, res) => { const page = (body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html><head><meta charset="utf-8"></head>' + body + '</html>') }; if (req.url.startsWith('/login')) { page('<body><h1>本地网关登录</h1></body>'); return } const token = new URL(req.url, 'http://127.0.0.1').searchParams.get('token'); if (!['external-token', 'test-restart-token'].includes(token ?? '')) { res.writeHead(302, { location: '/login' }); res.end(); return } page('<body><h1 id="external-dsh">外部 dsh web</h1></body>') }); server.listen(0, '127.0.0.1', () => { console.log('PORT=' + server.address().port); setTimeout(() => {}, 600000) })`
  ].join('\n')
  fakeDsh = spawn(
    process.execPath,
    [
      '-e',
      script,
      '/tmp/fake-dsh/dsh',
      'web',
      '--patch',
      '/tmp/fake-dsh/cordis.dush.patch.yml',
      '--no-open'
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], detached: false }
  )
  await new Promise<void>((resolvePromise, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error(`本地假网关未输出端口：${output}`)), 5_000)
    fakeDsh?.once('error', reject)
    fakeDsh?.stdout?.on('data', (chunk) => {
      output += String(chunk)
      const portMatch = /PORT=(\d{1,5})/.exec(output)
      if (!portMatch?.[1]) return
      fakeGatewayPort = Number(portMatch[1])
      fakeDshPort = fakeGatewayPort
      clearTimeout(timeout)
      resolvePromise()
    })
  })
  expect(fakeDshPort).toBeGreaterThan(0)

  app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()
  await expect(win.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  fakeDsh?.kill('SIGTERM')
})

test('远程网关登录重定向不把正常 ERR_FAILED 写入主进程错误日志', async () => {
  const mainErrors: string[] = []
  const onOutput = (chunk: Buffer): void => {
    mainErrors.push(String(chunk))
  }
  app.process().stderr?.on('data', onOutput)
  app.process().stdout?.on('data', onOutput)
  try {
    const created = await win.evaluate(async (endpointUrl) => {
      const r = await window.dshHub.instances.create({
        transport: 'http',
        name: '远程登录重定向',
        authMode: 'gateway',
        endpointUrl
      })
      return r.ok ? r.value.id : null
    }, `http://127.0.0.1:${fakeGatewayPort}`)
    expect(created).not.toBeNull()
    if (!created) return

    await win.reload()
    await expect(win.getByTestId('app-shell')).toBeVisible()
    // 重载会恢复刷新前的视图：本用例从列表起步，先确保回到总览。
    await backToOverview(win)
    await win.getByTestId('instances-table').getByText('远程登录重定向', { exact: true }).click()
    await expect(win.getByTestId('open-view-btn')).toBeEnabled()
    await win.getByTestId('open-view-btn').click()
    await expect
      .poll(async () =>
        app.evaluate(({ BrowserWindow }) => {
          const workspace = BrowserWindow.getAllWindows().find(
            (candidate) => candidate.contentView.children.length > 0
          )?.contentView.children[0] as { webContents?: { getURL(): string } } | undefined
          return workspace?.webContents?.getURL() ?? ''
        })
      )
      .toContain('/login')
    await expect
      .poll(async () =>
        app.evaluate(({ BrowserWindow }) => {
          const workspace = BrowserWindow.getAllWindows().find(
            (candidate) => candidate.contentView.children.length > 0
          )?.contentView.children[0] as
            | { getBounds?: () => { x: number; y: number; width: number; height: number } }
            | undefined
          return workspace?.getBounds?.() ?? null
        })
      )
      .toMatchObject({ x: 262, y: 46, width: expect.any(Number), height: expect.any(Number) })
    await expect(win.getByTestId('tb-title')).toHaveText('远程登录重定向')
    // 认证页由右侧 WebContentsView 自己呈现；全局认证 Modal 只能由用户主动打开。
    await expect(win.getByTestId('auth-panel')).toBeHidden()
    await win.waitForTimeout(500)
    await expect(win.getByTestId('auth-panel')).toBeHidden()
    await expect(win.getByTestId('tb-sub')).toHaveText(`127.0.0.1:${fakeGatewayPort}`)
    await win.waitForTimeout(300)
    const log = mainErrors.join('')
    expect(log).not.toContain('[instance-view] 加载失败')
    expect(log).not.toContain("ERR_FAILED (-2) loading 'http://127.0.0.1:")
  } finally {
    app.process().stderr?.off('data', onOutput)
    app.process().stdout?.off('data', onOutput)
  }
})

test('HTTP 实例未启动也能直接打开视图', async () => {
  const created = await win.evaluate(async () => {
    const r = await window.dshHub.instances.create({
      transport: 'http',
      name: '免启动 http',
      authMode: 'auto',
      endpointUrl: 'http://127.0.0.1:1/dsh'
    })
    return r.ok ? r.value.id : null
  })
  expect(created).not.toBeNull()
  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  // 重载会恢复刷新前的视图：本用例从列表起步，先确保回到总览。
  await backToOverview(win)
  await win.getByTestId('instances-table').getByText('免启动 http', { exact: true }).click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  // 关键:没有点过「启动」,开窗按钮必须可用
  const openBtn = win.getByTestId('open-view-btn')
  await expect(openBtn).toBeEnabled()
  await win.screenshot({
    path: join(SHOT_DIR, 'http-open-without-start.png'),
    animations: 'disabled'
  })
})

test('重启后接管同一外部 dsh 会复用端口实例和已保存 token，不新建实例', async () => {
  // Windows 首次扫描走 PowerShell/CIM,冷启动明显慢于 POSIX 的 ps+lsof;
  // 两轮各等 30s + 重启复扫,给足扫描器最坏预算
  test.setTimeout(180_000)
  const external = await openWizardAwaitingExternalScan()
  await win.getByTestId('wizard-name').fill('重启后复用实例')
  await external.getByRole('checkbox').check()
  await win.getByTestId('wizard-external-access').fill('test-restart-token')
  await win.getByRole('button', { name: '下一步' }).click()
  await win.getByTestId('wizard-create').click()
  await expect(win.getByTestId('wizard')).toBeHidden({ timeout: 30_000 })
  await expect
    .poll(async () =>
      win.evaluate(async () => {
        const result = await window.dshHub.instances.list()
        return result.ok ? result.value.filter((item) => item.name === '重启后复用实例') : []
      })
    )
    .toHaveLength(1)
  const firstAddress = await win.evaluate(async () => {
    const result = await window.dshHub.instances.list()
    return result.ok
      ? (result.value.find((item) => item.name === '重启后复用实例')?.address ?? null)
      : null
  })
  expect(firstAddress).toMatch(/^127\.0\.0\.1:\d+$/)
  const registry = await readFile(join(DATA_DIR, 'registry', 'instances.json'), 'utf8')
  expect(registry).not.toContain('test-restart-token')

  await app.close()
  app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  const reopenedExternal = await openWizardAwaitingExternalScan()
  await reopenedExternal.getByRole('checkbox').check()
  await expect(win.getByTestId('wizard-name')).toHaveValue('重启后复用实例')
  await expect(win.getByTestId('wizard-external-access')).toHaveValue('')
  await win.getByRole('button', { name: '下一步' }).click()
  await win.getByTestId('wizard-create').click()
  await expect(win.getByTestId('wizard')).toBeHidden({ timeout: 30_000 })
  await expect
    .poll(async () =>
      win.evaluate(async () => {
        const result = await window.dshHub.instances.list()
        return result.ok ? result.value.filter((item) => item.name === '重启后复用实例') : []
      })
    )
    .toHaveLength(1)
  const restartedAddress = await win.evaluate(async () => {
    const result = await window.dshHub.instances.list()
    return result.ok
      ? (result.value.find((item) => item.name === '重启后复用实例')?.address ?? null)
      : null
  })
  expect(restartedAddress).toBe(firstAddress)
  await expect(win.getByTestId('tb-sub')).toHaveText(/127\.0\.0\.1:\d+/)
})

test('探测到已运行的 dsh web 后可接管并直接开窗', async () => {
  test.setTimeout(60_000)
  // 接管和断开都不应产生运行信息回写错误。
  const mainErrors: string[] = []
  app.process().stderr?.on('data', (chunk: Buffer) => mainErrors.push(String(chunk)))
  app.process().stdout?.on('data', (chunk: Buffer) => mainErrors.push(String(chunk)))

  const created = await win.evaluate(async () => {
    const r = await window.dshHub.instances.create({
      transport: 'local',
      name: '接管本地实例',
      authMode: 'auto'
    })
    return r.ok ? r.value.id : null
  })
  expect(created).not.toBeNull()
  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  // 重载会恢复刷新前的视图：本用例从列表起步，先确保回到总览。
  await backToOverview(win)
  await win.getByTestId('instances-table').getByText('接管本地实例', { exact: true }).click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  // 详情页出现「本机已在运行的 dsh web」卡片(只读探测命中假 dsh web)
  const card = win.getByTestId('external-dsh-card')
  await expect(card).toBeVisible({ timeout: 25_000 })
  await win.screenshot({
    path: join(SHOT_DIR, 'external-dsh-detected.png'),
    animations: 'disabled'
  })

  await card.locator('[data-testid^="external-access-"]').first().fill('external-token')
  await card.locator('[data-testid^="adopt-btn-"]:not([disabled])').first().click()
  await expect
    .poll(async () =>
      app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((candidate) => candidate.contentView.children.length > 0)
            ?.contentView.children.map(
              (child) =>
                (child as { webContents?: { getURL(): string } }).webContents?.getURL() ?? ''
            ) ?? []
      )
    )
    .toContainEqual(expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+/))
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible()
  await win.getByTestId('new-instance-btn').click()
  await expect(win.getByTestId('wizard')).toBeVisible()
  await expect(win.getByTestId('workspace-back-btn')).toHaveCount(0)
  await win.getByTestId('wizard').getByRole('button', { name: '关闭' }).click()
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible()
  await win.getByTestId('workspace-back-btn').click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByTestId('external-token-editor')).toBeVisible()
  expect(fakeDsh?.killed).toBe(false)

  // 接管和断开都不应产生运行信息回写错误。
  await win.waitForTimeout(300)
  const log = mainErrors.join('')
  expect(log).not.toContain('回写实例运行信息失败')
  expect(log).not.toContain('补丁不能为空')
})

test('工作区内打开关于：叠加窗口浮于工作区之上，宿主页面不切换', async () => {
  test.setTimeout(60_000)
  // 已接管实例的视图仍在缓存中：重开走同一缓存视图。
  await expect(win.getByTestId('view-detail')).toBeVisible()
  const openBtn = win.getByTestId('open-view-btn')
  await expect(openBtn).toBeEnabled()
  await openBtn.click()
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible()
  await expect(win.getByTestId('tb-title')).toHaveText('接管本地实例')

  const about = await openAboutViaMenu(app)

  // 核心断言:宿主全程停留在工作区 —— 不隐藏原生视图、不跳详情、不回列表。
  // workspace-open 时顶栏标题保持实例名;一旦跳到详情/列表,标题会变成「实例详情/总览」。
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible()
  await expect(win.getByTestId('tb-title')).toHaveText('接管本地实例')

  await closeAboutWithEscape(about)
  await expectAboutClosed(app)
  // 关闭叠加窗口后工作区原样保留。
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible()
  await expect(win.getByTestId('tb-title')).toHaveText('接管本地实例')
})
