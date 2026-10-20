import { _electron as electron, expect, test } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 插件更新内容的 Markdown 渲染 + 升级确认框宽度。
 *
 * 更新内容取数默认真连 GitHub；无头测试不该依赖外网，因此主进程读
 * `DSH_HUB_E2E_RELEASE_NOTES` 指向的文件作为固定正文（见 create-runtime.ts）。
 *
 * 断言两条：
 * - Markdown 结构真的渲染成了元素（标题/列表/代码块/表格），不再是纯文本；
 * - 危险协议的链接不成为可点击 href。
 */

const VERSION = '0.1.7-rc.2'
const DATA_DIR = e2eDataDir('e2e-plugin-markdown')
const ENTRY_DIR = join(
  DATA_DIR,
  'runtimes',
  `dsh-${VERSION}`,
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib'
)
const INSTALLED_VERSION = '1.0.0'
const LATEST_VERSION = '1.1.0'

/** 假 dsh 入口：只响应 plugin list / view / add / remove。 */
const FAKE_BIN = `
const fs = require('fs')
const args = process.argv.slice(2)
const i = args.indexOf('plugin')
if (i === -1) { process.exit(0) }
const rest = args.slice(i + 1)
let sub = rest
const p = rest.indexOf('--profile')
if (p !== -1) sub = rest.slice(0, p).concat(rest.slice(p + 2))
const cmd = sub[0]
if (cmd === 'list') {
  process.stdout.write(JSON.stringify([{
    name: 'dsh-profile-web',
    dependencies: {
      'demo-plugin': {
        from: 'demo-plugin',
        version: ${JSON.stringify(INSTALLED_VERSION)},
        resolved: 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.0.0.tgz',
        path: ${JSON.stringify(join(DATA_DIR, 'fake-plugin'))}
      }
    }
  }]))
  process.exit(0)
}
if (cmd === 'view') {
  process.stdout.write(JSON.stringify({
    version: ${JSON.stringify(LATEST_VERSION)},
    versions: ${JSON.stringify([INSTALLED_VERSION, LATEST_VERSION])},
    'dist-tags': { latest: ${JSON.stringify(LATEST_VERSION)} },
    peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
    repository: { type: 'git', url: 'git+https://github.com/demo/demo-plugin.git' },
    time: { ${JSON.stringify(LATEST_VERSION)}: '2026-09-28T11:16:59.586Z' }
  }))
  process.exit(0)
}
if (cmd === 'add' || cmd === 'remove') { process.stdout.write('ok'); process.exit(0) }
process.exit(0)
`

/** 固定正文：覆盖标题、列表、代码块、表格、引用、删除线与两种链接。 */
const RELEASE_NOTES = [
  '# 1.1.0 更新内容',
  '',
  '本次更新带来 **重要** 改动。',
  '',
  '## 新增',
  '',
  '- 支持 `--json` 输出',
  '- 新增 [文档链接](https://example.com/docs)',
  '',
  '## 修复',
  '',
  '1. 修复安装超时',
  '2. 修复路径转义',
  '',
  '> 升级前请备份配置。',
  '',
  '```bash',
  'dsh plugin add demo-plugin',
  '```',
  '',
  '| 变更 | 说明 |',
  '| --- | --- |',
  '| core | 重构 |',
  '',
  '已废弃的旧接口 ~~old-api~~ 仍可用。',
  '',
  '[危险链接](javascript:alert(1))',
  ''
].join('\n')

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(ENTRY_DIR, { recursive: true })
  await writeFile(join(ENTRY_DIR, 'bin.js'), FAKE_BIN, 'utf8')
  const pluginDir = join(DATA_DIR, 'fake-plugin')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'package.json'),
    JSON.stringify({
      name: 'demo-plugin',
      version: INSTALLED_VERSION,
      repository: { type: 'git', url: 'git+https://github.com/demo/demo-plugin.git' },
      peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' }
    }),
    'utf8'
  )
  // 固定正文写入文件，由主进程经 DSH_HUB_E2E_RELEASE_NOTES 读入。
  const notesFile = join(DATA_DIR, 'release-notes.md')
  await writeFile(notesFile, RELEASE_NOTES, 'utf8')

  app = await electron.launch({
    args: buildLaunchArgs(),
    env: e2eEnv(DATA_DIR, { DSH_HUB_E2E_RELEASE_NOTES: notesFile })
  })
  win = await app.firstWindow()

  const created = await win.evaluate(
    async (version) =>
      window.dshHub.instances.create({
        transport: 'local',
        name: 'Markdown 测试实例',
        authMode: 'none',
        dshVersion: version
      }),
    VERSION
  )
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error('创建实例失败')
  const profileDir = join(DATA_DIR, 'homes', created.value.id, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-plugin'] } },
        dependencies: { 'demo-plugin': INSTALLED_VERSION }
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

/** 打开该实例详情。 */
async function openDetail(): Promise<void> {
  // 上一个用例可能留着对话框：overlay 会拦截点击，先收掉。
  await closeOpenDialog()
  if (await win.getByTestId('view-detail').isVisible()) {
    await expect(win.getByTestId('plugins-card')).toBeVisible()
    return
  }
  await win.locator('[data-testid^="detail-"]').first().click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByTestId('plugins-card')).toBeVisible()
}

/** 关闭残留的对话框（Escape 逐层关闭）。 */
async function closeOpenDialog(): Promise<void> {
  if ((await win.locator('.overlay').count()) === 0) return
  await win.keyboard.press('Escape')
  await expect(win.locator('.overlay')).toHaveCount(0)
}

/** 打开升级确认框并等确认区就绪。 */
async function openUpgradeDialog(): Promise<void> {
  await openDetail()
  const upgrade = win.getByTestId('plugin-upgrade-demo-plugin')
  if (!(await upgrade.isVisible())) {
    await win.getByTestId('plugin-check-demo-plugin').click()
  }
  await expect(upgrade).toBeVisible({ timeout: 20_000 })
  await upgrade.click()
  await expect(win.getByTestId('upgrade-confirm-dialog')).toBeVisible()
}

test('更新内容按 Markdown 渲染：标题、列表、代码块、表格都成为元素', async () => {
  test.setTimeout(120_000)
  await openUpgradeDialog()

  const notes = win.getByTestId('install-confirm-notes')
  await expect(notes).toBeVisible({ timeout: 20_000 })
  await expect(notes).toContainText('1.1.0 更新内容')

  // 标题渲染成真正的标题元素（纯文本渲染时只是一个段落）。
  await expect(notes.locator('h1')).toHaveText('1.1.0 更新内容')
  await expect(notes.locator('h2').first()).toHaveText('新增')
  // 列表项成为 li，代码块成为 pre，表格成为 table。
  await expect(notes.locator('li').first()).toBeVisible()
  await expect(notes.locator('pre')).toContainText('dsh plugin add demo-plugin')
  await expect(notes.locator('table')).toBeVisible()
  await expect(notes.locator('blockquote')).toContainText('升级前请备份配置')
  // 删除线与强调都渲染成对应元素。
  await expect(notes.locator('del')).toHaveText('old-api')
  await expect(notes.locator('strong')).toHaveText('重要')
  // Markdown 标记本身不出现在正文里（说明确实被解析了，而不是当字面量显示）。
  await expect(notes).not.toContainText('## 新增')
})

test('更新内容里的外链：http(s) 可点击，危险协议降级为纯文本', async () => {
  test.setTimeout(120_000)
  await openUpgradeDialog()

  const notes = win.getByTestId('install-confirm-notes')
  await expect(notes.locator('h1')).toBeVisible({ timeout: 20_000 })

  // 正常链接保留 href。
  const safe = notes.locator('a.md-link')
  await expect(safe).toHaveCount(1)
  await expect(safe).toHaveAttribute('href', 'https://example.com/docs')
  await expect(safe).toHaveText('文档链接')

  // javascript: 链接不产生 href 属性，只剩文字。
  await expect(notes).toContainText('危险链接')
  await expect(notes.locator('a[href^="javascript"]')).toHaveCount(0)
})

test('升级确认框宽度比 560px 基准加宽 10%', async () => {
  test.setTimeout(120_000)
  await openUpgradeDialog()

  const dialog = win.getByTestId('upgrade-confirm-dialog')
  const width = (await dialog.boundingBox())?.width ?? 0
  // 560 → 616（+10%）：断言落在 600 以上，且不超过 640（防止宽度被随意放大）。
  expect(width).toBeGreaterThan(600)
  expect(width).toBeLessThanOrEqual(640)
  // 收尾：关掉对话框，别把 overlay 留给后面的用例。
  await closeOpenDialog()
})

test('安装确认框用同一套 Markdown 渲染', async () => {
  test.setTimeout(120_000)
  await openDetail()
  await win.getByTestId('plugins-install-btn').click()
  const dialog = win.getByTestId('install-plugin-dialog')
  await expect(dialog).toBeVisible()
  await win.getByTestId('install-plugin-input').fill('demo-plugin')
  await win.getByTestId('install-plugin-submit').click()

  const notes = win.getByTestId('install-confirm-notes')
  await expect(notes.locator('h1')).toBeVisible({ timeout: 20_000 })
  await expect(notes.locator('h1')).toHaveText('1.1.0 更新内容')
  // 安装与升级共用确认区：宽度一致。
  const width = (await dialog.boundingBox())?.width ?? 0
  expect(width).toBeGreaterThan(600)
  // 收尾：关掉对话框，别把 overlay 留给后面的用例。
  await closeOpenDialog()
})
