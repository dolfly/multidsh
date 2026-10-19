import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * 「dsh 升级后首次启动自动禁用不兼容插件」的界面提示：主进程核对结果写在
 * `<DATA_DIR>/plugin-state/<id>.json` 的 autoDisabled 里，插件卡挂载时读取并提示。
 * 这里直接播种该状态文件，验证「主进程状态 → 界面提示条 → 可关闭」这条链路。
 */
const VERSION = '0.1.7-rc.2'
const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-plugins-auto-disabled')
const ENTRY_DIR = join(
  DATA_DIR,
  'runtimes',
  `dsh-${VERSION}`,
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib'
)

let app: ElectronApplication
let win: Page

/** 只认 list 的假 dsh 入口。 */
const FAKE_BIN = `
const args = process.argv.slice(2)
const i = args.indexOf('plugin')
if (i === -1) process.exit(0)
const rest = args.slice(i + 1)
let sub = rest
const p = rest.indexOf('--profile')
if (p !== -1) sub = rest.slice(0, p).concat(rest.slice(p + 2))
if (sub[0] === 'list') {
  process.stdout.write(JSON.stringify([{
    name: 'dsh-profile-web',
    dependencies: {
      'demo-plugin': {
        from: 'demo-plugin',
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.0.0.tgz',
        path: ${JSON.stringify(join(DATA_DIR, 'fake-plugin'))}
      }
    }
  }]))
  process.exit(0)
}
process.exit(0)
`

/**
 * 假插件的 manifest：声明与实例 dsh 版本不兼容的 dsh peer（>=0.2.0），
 * 供「手动启用 → 授予 allow-version --accept-risk 豁免」链路判定。
 * 同时落在 profile 顶层 node_modules（pnpm 布局的真实读取位置）。
 */
const FAKE_PLUGIN_MANIFEST = {
  name: 'demo-plugin',
  version: '1.0.0',
  description: '示例插件',
  peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }
}

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(ENTRY_DIR, { recursive: true })
  await writeFile(join(ENTRY_DIR, 'bin.js'), FAKE_BIN, 'utf8')
  const pluginDir = join(DATA_DIR, 'fake-plugin')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify(FAKE_PLUGIN_MANIFEST), 'utf8')

  app = await electron.launch({
    args: buildLaunchArgs(),
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()

  const created = await win.evaluate(
    async (version) =>
      window.dshHub.instances.create({
        transport: 'local',
        name: '自动禁用实例',
        authMode: 'none',
        dshVersion: version
      }),
    VERSION
  )
  if (!created.ok) throw new Error('创建实例失败')

  // profile 清单：插件被自动禁用后已不在 bundles 里（保留 dependencies）。
  const profileDir = join(DATA_DIR, 'homes', created.value.id, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
        dependencies: { 'demo-plugin': '1.0.0' }
      },
      undefined,
      2
    )}\n`,
    'utf8'
  )
  // profile 顶层 node_modules 里的插件 manifest：主进程按它判定兼容性（与 dsh 加载时同源）。
  const installedPluginDir = join(profileDir, 'node_modules', 'demo-plugin')
  await mkdir(installedPluginDir, { recursive: true })
  await writeFile(
    join(installedPluginDir, 'package.json'),
    JSON.stringify(FAKE_PLUGIN_MANIFEST),
    'utf8'
  )

  // 主进程核对结果：demo-plugin 与新版 dsh 不兼容，已被自动禁用。
  const stateDir = join(DATA_DIR, 'plugin-state')
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    join(stateDir, `${created.value.id}.json`),
    `${JSON.stringify(
      {
        lastCheckedAt: null,
        updates: {},
        bundleIndex: { 'demo-plugin': 1 },
        runtimeVersion: VERSION,
        autoDisabled: [{ name: 'demo-plugin', version: '1.0.0', dshVersion: VERSION }]
      },
      undefined,
      2
    )}\n`,
    'utf8'
  )

  await win.reload()
  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 15_000 })
})

test.afterAll(async () => {
  await app.close()
  await rm(DATA_DIR, { recursive: true, force: true })
})

test('自动禁用提示：卡片顶部提示不兼容插件，且该行标注已禁用，可关闭提示', async () => {
  test.setTimeout(90_000)
  await win.locator('[data-testid^="detail-"]').first().click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByTestId('plugins-card')).toBeVisible()

  const banner = win.getByTestId('plugins-auto-disabled')
  await expect(banner).toBeVisible({ timeout: 15_000 })
  await expect(banner).toContainText('demo-plugin')
  // 该插件同时以「已禁用」标注出现在列表里（仍可见）
  await expect(win.getByTestId('plugin-disabled-demo-plugin')).toBeVisible()

  await win.getByTestId('plugins-auto-disabled-dismiss').click()
  await expect(banner).toBeHidden()
})

test('「知道了」确认后刷新（Cmd+R）不再重复提示', async () => {
  test.setTimeout(90_000)
  // 上一条用例点了「知道了」：确认落在渲染层，刷新渲染层后这一批自动禁用不该再提示。
  await win.reload()

  // 刷新后仍停在详情页（视图恢复），提示条与一次性提示都不再出现。
  await expect(win.getByTestId('view-detail')).toBeVisible({ timeout: 15_000 })
  await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible({ timeout: 15_000 })
  // 一次性提示存活 5s：只等 1s 做定点判定，重复弹出必然被抓到。
  await win.waitForTimeout(1_000)
  await expect(win.getByTestId('plugins-auto-disabled')).toHaveCount(0)
  expect(await win.getByTestId('toast').count()).toBe(0)
})

test('未确认时提示只弹一次：清掉确认后进详情弹一次，重进不再弹', async () => {
  test.setTimeout(90_000)
  // 清掉确认回到未确认状态：提示条与一次性提示都应恢复。
  await win.evaluate(() => localStorage.removeItem('dshhub-auto-disabled-acked'))

  await win.getByTestId('detail-overview-btn').click()
  await expect(win.getByTestId('view-home')).toBeVisible()
  await win.locator('[data-testid^="detail-"]').first().click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  const banner = win.getByTestId('plugins-auto-disabled')
  await expect(banner).toBeVisible({ timeout: 15_000 })
  await expect(win.getByTestId('toast')).toBeVisible({ timeout: 15_000 })

  // 等一次性提示自然退场（5s），再回总览重进详情：同一次自动禁用不该再弹提示。
  await expect(win.getByTestId('toast')).toBeHidden({ timeout: 15_000 })
  await win.getByTestId('detail-overview-btn').click()
  await expect(win.getByTestId('view-home')).toBeVisible()
  await win.locator('[data-testid^="detail-"]').first().click()
  // 列表已加载（提示与列表由同一批状态在同一帧渲染）后定点判定：只等 1s，
  // 若重复弹出必然被抓到 —— 不能用会重试到提示自行消失才通过的 toHaveCount(0)。
  await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible({ timeout: 15_000 })
  await win.waitForTimeout(1_000)
  expect(await win.getByTestId('toast').count()).toBe(0)
  // 未点「知道了」时提示条仍在：只有确认才让它消失。
  await expect(banner).toBeVisible()
})

test('手动启用不兼容插件：先授予 allow-version --accept-risk 豁免，插件启用并在信息栏留痕', async () => {
  test.setTimeout(90_000)
  // 承接上一条用例：实例详情已打开、插件卡可见、demo-plugin 处于禁用态。
  const toggle = win.getByTestId('plugin-toggle-demo-plugin')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()

  // 启用成功：开关打开、不再显示「已禁用」标注。
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 })
  await expect(win.getByTestId('plugin-disabled-demo-plugin')).toBeHidden()
  // 手动启用后不再是「自动禁用待处理」项：提示条随之消失（状态里的 autoDisabled 已清）。
  await expect(win.getByTestId('plugins-auto-disabled')).toBeHidden()

  // 信息栏记录本次操作：豁免命令与「插件@版本」原样可查（中英文案都含这段 ASCII）。
  await win.getByTestId('detail-logbar-more').click()
  const lines = win.getByTestId('log-more-body')
  await expect(lines).toContainText('allow-version --accept-risk', { timeout: 15_000 })
  await expect(lines).toContainText('demo-plugin@1.0.0')
})
