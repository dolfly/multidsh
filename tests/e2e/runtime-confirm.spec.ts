import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { accessSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

/**
 * 运行时二次确认是 hub 风格的渲染层对话框（非系统原生对话框）：
 * 本机探不到任何 dsh（假 home 让候选安装路径全部落空、PATH 只留 node/npm、登录 shell 不可用）时，
 * 向导创建后的自动启动会走到「需要下载 dsh」确认；断言对话框出现、文案归属、
 * 取消后出列且实例停在停止态（不会真的发起下载）。
 */
const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-confirm')
const SHOT_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-shots')

let app: ElectronApplication
let win: Page
const cleanupDirs: string[] = []

/** POSIX：从 spec 进程的 PATH 里定位可执行文件（shim 目录只保留 npm/node，隐藏 dsh）。 */
function locateOnPath(binary: string): string {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, binary)
    try {
      accessSync(candidate)
      return candidate
    } catch {
      // 继续下一个 PATH 目录
    }
  }
  throw new Error(`PATH 上找不到 ${binary}，无法构造 E2E 的最小环境`)
}

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(SHOT_DIR, { recursive: true })

  // 最小环境：假 home（候选安装路径全部落空）+ 只含 node/npm 的 PATH（探测不到 dsh）
  // + 不可用的登录 shell（登录 shell 兜底探测直接失败；win32 不走该兜底）。
  const fakeHome = await mkdtemp(join(tmpdir(), 'dsh-e2e-home-'))
  cleanupDirs.push(fakeHome)

  let pathValue: string
  if (process.platform === 'win32') {
    // Windows 没有无扩展名的 node/npm 垫片：直接用 spec 自己的 node 目录
    // （node.exe 与自带的 node_modules/npm 同目录，正好满足 win32 的 npm 解析），
    // 再带一个系统目录让 where 可执行；两处都不含 dsh。
    const system32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')
    pathValue = [dirname(process.execPath), system32].join(delimiter)
  } else {
    const shimDir = await mkdtemp(join(tmpdir(), 'dsh-e2e-path-'))
    cleanupDirs.push(shimDir)
    symlinkSync(locateOnPath('npm'), join(shimDir, 'npm'))
    symlinkSync(locateOnPath('node'), join(shimDir, 'node'))
    pathValue = `${shimDir}:/usr/bin:/bin`
  }

  // CI 的 DSH_HUB_E2E_DECLINE_DOWNLOAD=1 会让下载确认在主进程直接按「取消」应答，
  // 本用例要的却是对话框停在页面上等 Playwright 点「取消」，故对该实例移除这个开关。
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['DSH_HUB_E2E_DECLINE_DOWNLOAD']

  app = await electron.launch({
    args: buildLaunchArgs(),
    env: {
      ...env,
      DSH_HUB_DATA_DIR: DATA_DIR,
      HOME: fakeHome,
      // win32 的 homedir() 读 USERPROFILE：不同时覆盖它，候选路径不会全部落空
      USERPROFILE: fakeHome,
      PATH: pathValue,
      SHELL: join(fakeHome, 'no-such-shell'),
      // 生效镜像必须随确认请求展示：用户要能看到下载的包从哪里来。
      DSH_HUB_NPM_REGISTRY: 'https://registry.npmjs.org'
    }
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

test('创建后启动触发下载确认：hub 风格对话框，取消即收敛到停止态', async () => {
  test.setTimeout(90_000)
  await expect(win.getByTestId('app-shell')).toBeVisible({ timeout: 10_000 })

  // 向导三步创建本地实例（默认启动器 dsh、未固定版本）
  await win.getByTestId('empty-new-btn').click()
  await expect(win.getByTestId('wizard')).toBeVisible()
  await win.getByRole('button', { name: '下一步' }).click()
  await win.getByTestId('wizard-name').fill('确认框实例')
  await win.getByRole('button', { name: '下一步' }).click()
  await expect(win.getByTestId('wizard-step-3')).toBeVisible()
  await win.getByTestId('wizard-create').click()
  await expect(win.getByTestId('wizard')).toBeHidden()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  // hub 与 PATH 都无可用 dsh → 解析 registry latest → 下载确认等待用户拍板
  const dialog = win.getByTestId('runtime-confirm-dialog')
  await expect(dialog).toBeVisible({ timeout: 45_000 })
  await expect(dialog).toContainText('未找到可复用的 dsh 运行时')
  await expect(win.getByTestId('runtime-confirm-body')).toContainText('@deepseek-ai/dsh@')
  await expect(win.getByTestId('runtime-confirm-registry')).toContainText(
    'https://registry.npmjs.org'
  )
  await expect(win.getByTestId('runtime-confirm-accept')).toHaveText('下载并启动')
  await win.screenshot({ path: join(SHOT_DIR, 'runtime-confirm.png') })

  // 取消：对话框出列，本次启动被取消，实例停在停止态（不发起任何下载）
  await win.getByTestId('runtime-confirm-cancel').click()
  await expect(dialog).toBeHidden()
  await expect
    .poll(
      async () =>
        win.evaluate(async () => {
          const listed = await window.dshHub.instances.list()
          return listed.ok ? (listed.value[0]?.runtimeStatus ?? null) : 'unknown'
        }),
      { timeout: 15_000 }
    )
    .toBe('stopped')
})
