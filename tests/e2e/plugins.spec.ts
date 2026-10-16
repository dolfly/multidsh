import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * 实例详情「插件管理」端到端验证：
 * - 列表渲染（图标 / 版本 / 来源）
 * - 手风琴展开显示详情字段（作者 / 兼容版本 / 依赖 / 发布时间）
 * - 检查升级：兼容给升级按钮、不兼容给警告不给按钮；批量检查期间锁定单行按钮
 * - 发布时间：取已装版本那一项并持久化，刷新后仍在
 * - 卸载二次确认（只说明后果）
 * - 禁用/启用：禁用后仍在列表可见并标注，可再次启用
 *
 * dsh 可执行入口用一个假 bin.js（响应 plugin list/view/add/remove）替身：
 * 播种到 hub 隔离目录 `<DATA_DIR>/runtimes/dsh-<version>/node_modules/@deepseek-ai/dsh/lib/bin.js`，
 * 实例固定该版本，plugin-manager 的 resolveDshEntry 即命中它；由 Electron-as-node 执行。
 */

const VERSION = '0.1.7-rc.2'
const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-plugins')
const ENTRY_DIR = join(DATA_DIR, 'runtimes', `dsh-${VERSION}`, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
/** 假 dsh 记录的插桩文件：每次 add/remove 追加一行 JSON。 */
const MUTATION_LOG = join(DATA_DIR, 'plugin-mutations.jsonl')

/** 假插件已装版本与它在假 registry 里的发布时间（view 的 time 映射中已装版本那一项）。 */
const INSTALLED_VERSION = '1.0.0'
const INSTALLED_PUBLISHED_AT = '2026-09-20T02:30:00.000Z'

/**
 * 假 registry 的候选版本：故意不按版本序排列（`1.0.10` 在 `1.0.9` 前），
 * 且 dist-tag `latest` 停在已装版本（滞后）——解析必须取「最大稳定版」而不是末位或 dist-tag。
 */
const LATEST_VERSION = '1.1.0'
const FAKE_VERSIONS = ['1.0.0', '1.0.10', '1.0.9', LATEST_VERSION]

/** 假 dsh 记录的 add/remove 调用。 */
interface FakeMutation {
  cmd: string
  args: string[]
}

async function readMutations(): Promise<FakeMutation[]> {
  try {
    const text = await readFile(MUTATION_LOG, 'utf8')
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as FakeMutation)
  } catch {
    return []
  }
}

/** 与渲染层 fmtLogTime 同口径（本地时区，YYYY-MM-DD HH:mm:ss）。 */
function fmtLogTime(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

let app: ElectronApplication
let win: Page
/** 播种的实例 id：直接写 plugin-state 文件定位状态文件时需要它。 */
let instanceId = ''

/**
 * 假 dsh 入口：只认 `plugin --profile <p> <sub> ...`。
 * - list --json：一个含 host+client 半的 npm 插件；
 * - view ... --json：版本信息（versions 故意乱序且 dist-tag 滞后，用于验证解析不取末位、
 *   也不盲信 dist-tag）；`DSH_E2E_PLUGIN_INCOMPAT=1` 时返回不兼容 peer；
 * - add / remove：追加到 DSH_E2E_PLUGIN_ADD_LOG（若有），供断言实际下发的 spec 与 --registry。
 */
const FAKE_BIN = `
const fs = require('fs')
const args = process.argv.slice(2)
const i = args.indexOf('plugin')
if (i === -1) { process.exit(0) }
const rest = args.slice(i + 1)
// 跳过 --profile <name>
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
  // 可选延迟：用于验证「批量检查期间单行检查按钮锁定」。
  const delay = Number(process.env.DSH_E2E_PLUGIN_VIEW_DELAY_MS || '0')
  if (delay > 0) { const until = Date.now() + delay; while (Date.now() < until) {} }
  const incompat = process.env.DSH_E2E_PLUGIN_INCOMPAT === '1'
  process.stdout.write(JSON.stringify({
    version: ${JSON.stringify(LATEST_VERSION)},
    versions: ${JSON.stringify(FAKE_VERSIONS)},
    'dist-tags': { latest: ${JSON.stringify(INSTALLED_VERSION)} },
    peerDependencies: { '@deepseek-ai/dsh': incompat ? '>=0.2.0' : '>=0.1.7-rc.2' },
    repository: { type: 'git', url: 'git+https://github.com/demo/demo-plugin.git' },
    time: { ${JSON.stringify(INSTALLED_VERSION)}: ${JSON.stringify(INSTALLED_PUBLISHED_AT)}, ${JSON.stringify(LATEST_VERSION)}: '2026-09-28T11:16:59.586Z' }
  }))
  process.exit(0)
}
if (cmd === 'add' || cmd === 'remove') {
  const log = process.env.DSH_E2E_PLUGIN_ADD_LOG
  if (log) {
    try { fs.appendFileSync(log, JSON.stringify({ cmd: cmd, args: sub.slice(1) }) + '\\n') } catch (error) {}
  }
  process.stdout.write('ok')
  process.exit(0)
}
process.exit(0)
`

const FAKE_PLUGIN_MANIFEST = {
  name: 'demo-plugin',
  version: '1.0.0',
  description: '示例插件',
  author: 'demo-author',
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/demo/demo-plugin.git' },
  dependencies: { 'left-pad': '^1.0.0' },
  peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
  engines: { node: '>=20' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }
}

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(ENTRY_DIR, { recursive: true })
  await writeFile(join(ENTRY_DIR, 'bin.js'), FAKE_BIN, 'utf8')
  const pluginDir = join(DATA_DIR, 'fake-plugin')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify(FAKE_PLUGIN_MANIFEST), 'utf8')
  // 假 dsh 的 add/remove 插桩：插件安装与升级的断言都读它。
  process.env.DSH_E2E_PLUGIN_ADD_LOG = MUTATION_LOG

  app = await electron.launch({
    args: buildLaunchArgs(),
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()

  // 播种一个固定该版本的本机实例（resolveDshEntry 命中隔离目录里的假 bin.js）。
  const created = await win.evaluate(
    async (version) =>
      window.dshHub.instances.create({
        transport: 'local',
        name: '插件测试实例',
        authMode: 'none',
        dshVersion: version
      }),
    VERSION
  )
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error('创建实例失败')
  instanceId = created.value.id
  // 播种 profile package.json：dsh 的加载清单决定「启用/禁用」，hub 改的就是它。
  const profileDir = join(DATA_DIR, 'homes', created.value.id, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-plugin'] } },
        dependencies: { 'demo-plugin': '1.0.0' }
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

/** 打开该实例详情（本机未运行 → openFromSidebar 不直接进工作区，用 detail 按钮直达）。 */
async function openDetail(): Promise<void> {
  // 侧栏详情按钮是开关：已在详情页时再点会收起，故先判断。
  if (await win.getByTestId('view-detail').isVisible()) {
    await expect(win.getByTestId('plugins-card')).toBeVisible()
    return
  }
  const detailBtn = win.locator('[data-testid^="detail-"]').first()
  await detailBtn.click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByTestId('plugins-card')).toBeVisible()
}

/** 展开插件详情（已展开时不再点，避免收起）。 */
async function expandDetail(): Promise<void> {
  const detail = win.getByTestId('plugin-detail-demo-plugin')
  if (!(await detail.isVisible())) await win.getByTestId('plugin-expand-demo-plugin').click()
  await expect(detail).toBeVisible()
}

test('列表渲染 + 手风琴详情 + 检查升级（兼容给升级按钮）', async () => {
  test.setTimeout(90_000)
  await openDetail()

  // 列表出现该插件行。
  const row = win.getByTestId('plugin-row-demo-plugin')
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toContainText('demo-plugin')
  await expect(row).toContainText('1.0.0')

  // 手风琴展开显示详情字段。
  await win.getByTestId('plugin-expand-demo-plugin').click()
  const detail = win.getByTestId('plugin-detail-demo-plugin')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('demo-author')
  await expect(detail).toContainText('left-pad')
  await expect(detail).toContainText('>=0.1.7-rc.2')
  // 尚未检查过：发布时间为占位文案。
  await expect(detail).toContainText('点检查升级获取')

  // 检查升级：兼容 → 出现「升级到 1.1.0」按钮，发布时间同时取到已装版本那一条。
  await win.getByTestId('plugin-check-demo-plugin').click()
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toBeVisible({ timeout: 15_000 })
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toContainText('1.1.0')
  await expect(detail).toContainText(fmtLogTime(INSTALLED_PUBLISHED_AT))
})

test('发布时间：已装版本的快照持久化，刷新后仍在', async () => {
  test.setTimeout(90_000)
  await openDetail()
  await expandDetail()
  const detail = win.getByTestId('plugin-detail-demo-plugin')
  await expect(detail).toContainText(fmtLogTime(INSTALLED_PUBLISHED_AT))

  // 刷新：列表由主进程用落盘快照回填，不再回到「点检查升级获取」。
  await win.reload()
  await expect(win.getByTestId('view-home').or(win.getByTestId('view-detail'))).toBeVisible({
    timeout: 15_000
  })
  await openDetail()
  await expandDetail()
  await expect(detail).toContainText(fmtLogTime(INSTALLED_PUBLISHED_AT))
  await expect(detail).not.toContainText('点检查升级获取')
})

test('卸载二次确认：确认框只说明后果，不再按 host 半预告重启', async () => {
  await win.getByTestId('plugin-remove-demo-plugin').click()
  await expect(win.getByTestId('plugin-remove-confirm')).toBeVisible()
  // 是否需要重启由改动后的 application 决定（升级/替换已装包才必然重启），
  // 确认框不按 host 半预告，避免误导。
  await expect(win.getByTestId('plugin-remove-host-hint')).toHaveCount(0)
  // 收尾：关闭确认框，避免影响后续用例。
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('plugin-remove-confirm')).toBeHidden()
})

test('检查升级（不兼容）：给警告不给升级按钮', async () => {
  test.setTimeout(90_000)
  // 关掉再以不兼容开关重启应用，让假 bin.js 的 view 返回高版本 peer。
  await app.close()
  app = await electron.launch({
    args: buildLaunchArgs(),
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR, DSH_E2E_PLUGIN_INCOMPAT: '1' }
  })
  win = await app.firstWindow()
  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 15_000 })
  await openDetail()

  await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible({ timeout: 15_000 })
  await win.getByTestId('plugin-check-demo-plugin').click()
  // 不兼容：出现警告，且不出现升级按钮。
  const status = win.getByTestId('plugin-incompatible-demo-plugin')
  await expect(status).toBeVisible({ timeout: 15_000 })
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toHaveCount(0)

  // 行内说明按宽度截断：hover 展开气泡给出完整文案（与截断前同文）。
  const tip = win.locator('.info-tip').filter({ has: status })
  const bubble = tip.locator('.info-tip-bubble')
  await expect(bubble).toHaveText((await status.textContent()) ?? '')
  await status.hover()
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')

  // 点选文本（复制长文案的常见动作）后鼠标离开：气泡必须收起 —— 焦点展开只认键盘焦点，
  // 否则被点过的行气泡常驻，再 hover 相邻行会同时展开两个气泡。
  await status.click()
  await win.mouse.move(4, 4)
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('0')
  // 键盘 Tab 往返重新聚焦仍然展开（键盘/读屏用户可读完整说明）。
  await win.keyboard.press('Tab')
  await win.keyboard.press('Shift+Tab')
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')

  // 异常信息写入底部信息栏（信息栏只有一行，完整历史在「更多」弹层）。
  await win.getByTestId('detail-logbar-more').click()
  await expect(win.getByTestId('log-more-body')).toContainText('demo-plugin')
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('log-more')).toBeHidden()
})

test('一键检查：批量进行中锁定单行检查按钮，结束后解锁', async () => {
  test.setTimeout(90_000)
  // 以「view 慢响应」重启，制造可观察的批量检查窗口。
  await app.close()
  app = await electron.launch({
    args: buildLaunchArgs(),
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR, DSH_E2E_PLUGIN_VIEW_DELAY_MS: '1500' }
  })
  win = await app.firstWindow()
  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 15_000 })
  await openDetail()
  await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible({ timeout: 15_000 })

  const rowCheck = win.getByTestId('plugin-check-demo-plugin')
  await expect(rowCheck).toBeEnabled()
  await win.getByTestId('plugins-check-all-btn').click()

  // 批量检查进行中：单行检查按钮锁定（同一时刻只让系统检查在跑）。
  await expect(rowCheck).toBeDisabled({ timeout: 10_000 })
  // 批量结束后解锁，并给出升级按钮（view 返回 1.1.0）。
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toBeVisible({ timeout: 30_000 })
  await expect(rowCheck).toBeEnabled()

  // 有更新按类别汇总写入底部信息栏。
  await win.getByTestId('detail-logbar-more').click()
  await expect(win.getByTestId('log-more-body')).toContainText('demo-plugin')
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('log-more')).toBeHidden()
})


test('禁用/启用：禁用后仍在列表可见并标注已禁用，可再次启用', async () => {
  test.setTimeout(90_000)
  await openDetail()
  await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible({ timeout: 15_000 })
  // 初始为启用态（在 bundles 里）
  await expect(win.getByTestId('plugin-disabled-demo-plugin')).toHaveCount(0)

  // 开关初始为开（已加载）
  const toggle = win.getByTestId('plugin-toggle-demo-plugin')
  await expect(toggle).toHaveAttribute('role', 'switch')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  await toggle.click()
  // 禁用后：开关变为关，行仍在，出现「已禁用」标注
  await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 })
  await expect(win.getByTestId('plugin-disabled-demo-plugin')).toBeVisible()
  await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible()

  // 重新启用：开关回到开，标注消失
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 })
  await expect(win.getByTestId('plugin-disabled-demo-plugin')).toHaveCount(0)
})

test('陈旧的检查记录（旧版本写入 / 已装版本更高）→ 不再显示过期提示', async () => {
  test.setTimeout(90_000)
  const stateDir = join(DATA_DIR, 'plugin-state')
  await mkdir(stateDir, { recursive: true })
  const stateFile = join(stateDir, `${instanceId}.json`)

  /** 覆盖状态文件后重载并打开详情，等插件行出现。 */
  const seed = async (updates: Record<string, unknown>): Promise<void> => {
    await writeFile(
      stateFile,
      JSON.stringify({
        lastCheckedAt: '2026-09-29T10:00:00.000Z',
        updates,
        published: {},
        bundleIndex: {},
        runtimeVersion: null,
        autoDisabled: []
      }),
      'utf8'
    )
    await win.reload()
    await expect(win.getByTestId('view-home').or(win.getByTestId('view-detail'))).toBeVisible({
      timeout: 15_000
    })
    await openDetail()
    await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible({ timeout: 15_000 })
  }

  // 记录与已装版本（1.0.0）一致 → 正常恢复为「不兼容」警告。
  await seed({
    'demo-plugin': {
      current: '1.0.0',
      latest: '1.1.0',
      compatible: false,
      dshPeer: '>=0.2.0',
      dshVersion: VERSION
    }
  })
  await expect(win.getByTestId('plugin-incompatible-demo-plugin')).toBeVisible({ timeout: 15_000 })

  // 旧版本写入的记录（无 current）：无法校验是否仍适用 → 丢弃，不再显示过期提示。
  await seed({
    'demo-plugin': {
      latest: '0.9.5',
      compatible: false,
      dshPeer: '>=0.2.0',
      dshVersion: VERSION
    }
  })
  await expect(win.getByTestId('plugin-incompatible-demo-plugin')).toHaveCount(0)
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toHaveCount(0)

  // 记录来自更早的已装版本（手动装了更新版）：同样失效。
  await seed({
    'demo-plugin': {
      current: '0.9.0',
      latest: '0.9.5',
      compatible: false,
      dshPeer: '>=0.2.0',
      dshVersion: VERSION
    }
  })
  await expect(win.getByTestId('plugin-incompatible-demo-plugin')).toHaveCount(0)
})

test('安装两步：确定解析出版本、确认后才下发带 --registry 的 name@版本', async () => {
  test.setTimeout(120_000)
  await openDetail()
  const before = (await readMutations()).length

  await win.getByTestId('plugins-install-btn').click()
  const dialog = win.getByTestId('install-plugin-dialog')
  await expect(dialog).toBeVisible()
  // 第一步：安装源两档（默认国内镜像）+ 常驻安全提醒。
  await expect(win.getByTestId('install-plugin-source')).toHaveValue('npmmirror')
  await expect(win.getByTestId('install-plugin-source')).toContainText('npmjs')
  await expect(dialog).toContainText('来源不明的插件可能损坏 DSH')

  await win.getByTestId('install-plugin-input').fill('demo-plugin')
  await win.getByTestId('install-plugin-submit').click()

  // 第二步：解析出的版本是最大稳定版（假 registry 的 dist-tag 滞后、versions 乱序）。
  const versionRow = win.getByTestId('install-confirm-version')
  await expect(versionRow).toBeVisible({ timeout: 20_000 })
  await expect(versionRow).toContainText(LATEST_VERSION)
  await expect(win.getByTestId('install-confirm-downloads')).toBeVisible()
  await expect(win.getByTestId('install-plugin-submit')).toContainText(LATEST_VERSION)

  // 未点安装前不得有任何 add。
  expect((await readMutations()).length).toBe(before)

  // 对话框比默认（452px）宽一档：版本事实与更新内容一屏能读下。
  expect((await dialog.boundingBox())?.width ?? 0).toBeGreaterThan(500)

  // 「安装后启用」的后果说明默认不显示，hover 问号才展开；气泡贴在正文底部向上展开，
  // 且整体落在正文与对话框之内（正文是滚动容器、对话框 overflow:hidden，越界即被裁掉）。
  const tip = dialog.locator('.info-tip-above')
  const bubble = tip.locator('.info-tip-bubble')
  await expect(bubble).toHaveText('取消则只安装，插件落在「已禁用」状态')
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('0')
  await tip.locator('.info-tip-btn').hover()
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  const bubbleBox = await bubble.boundingBox()
  const bodyBox = await dialog.locator('.modal-body').boundingBox()
  const dialogBox = await dialog.boundingBox()
  expect(bubbleBox).not.toBeNull()
  expect(bodyBox).not.toBeNull()
  expect(dialogBox).not.toBeNull()
  const bubbleRect = bubbleBox ?? { x: 0, y: 0, width: 0, height: 0 }
  const bodyRect = bodyBox ?? { x: 0, y: 0, width: 0, height: 0 }
  const dialogRect = dialogBox ?? { x: 0, y: 0, width: 0, height: 0 }
  expect(Math.floor(bubbleRect.y)).toBeGreaterThanOrEqual(Math.ceil(bodyRect.y))
  expect(Math.ceil(bubbleRect.y + bubbleRect.height)).toBeLessThanOrEqual(
    Math.floor(bodyRect.y + bodyRect.height)
  )
  expect(Math.floor(bubbleRect.x)).toBeGreaterThanOrEqual(Math.ceil(dialogRect.x))
  expect(Math.ceil(bubbleRect.x + bubbleRect.width)).toBeLessThanOrEqual(
    Math.floor(dialogRect.x + dialogRect.width)
  )
  // 问号在勾选框之外：点它只读说明，不会把「安装后启用」点掉。
  await tip.locator('.info-tip-btn').click()
  await expect(win.getByTestId('install-confirm-enable-after')).toBeChecked()
  // 鼠标移开即收起，不在确认区残留气泡。
  await win.getByTestId('install-confirm-enable-after').hover()
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('0')

  await win.getByTestId('install-plugin-submit').click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
  const mutations = await readMutations()
  expect(mutations.length).toBe(before + 1)
  const add = mutations.at(-1)
  expect(add?.cmd).toBe('add')
  // 安装规格是解析出的具体版本，且与解析同源。
  expect(add?.args[0]).toBe(`demo-plugin@${LATEST_VERSION}`)
  expect(add?.args).toContain('--registry')
  expect(add?.args).toContain('https://registry.npmmirror.com')

  // 输入变更作废确认区：重新打开后改内容应回到第一步。
  await win.getByTestId('plugins-install-btn').click()
  await expect(dialog).toBeVisible()
  await win.getByTestId('install-plugin-input').fill('demo-plugin@1.0.0')
  await win.getByTestId('install-plugin-submit').click()
  await expect(versionRow).toContainText('重装', { timeout: 20_000 })
  await win.getByTestId('install-plugin-input').fill('demo-plugin@1.0.10')
  await expect(win.getByTestId('install-confirm-version')).toHaveCount(0)
  await win.getByTestId('install-plugin-cancel').click()
  await expect(dialog).toBeHidden()
})

test('升级二次确认：弹窗给出目标版本，取消不执行、确认才升级', async () => {
  test.setTimeout(120_000)
  await openDetail()
  const upgrade = win.getByTestId('plugin-upgrade-demo-plugin')
  if (!(await upgrade.isVisible())) {
    await win.getByTestId('plugin-check-demo-plugin').click()
  }
  await expect(upgrade).toBeVisible({ timeout: 20_000 })
  const before = (await readMutations()).length

  await upgrade.click()
  const dialog = win.getByTestId('upgrade-confirm-dialog')
  await expect(dialog).toBeVisible()
  await expect(win.getByTestId('upgrade-confirm-submit')).toContainText(LATEST_VERSION, { timeout: 20_000 })
  // 升级不改启用态：不出现「安装后启用」勾选，也没有它的说明气泡。
  await expect(win.getByTestId('install-confirm-enable-after')).toHaveCount(0)
  await expect(dialog.locator('.info-tip')).toHaveCount(0)
  // 与安装第二步同宽：同一套确认区不因入口不同而变窄。
  expect((await dialog.boundingBox())?.width ?? 0).toBeGreaterThan(500)

  // 取消：不产生任何改动。
  await win.getByTestId('upgrade-confirm-cancel').click()
  await expect(dialog).toBeHidden()
  expect((await readMutations()).length).toBe(before)

  // 确认后才执行升级。
  await upgrade.click()
  await expect(dialog).toBeVisible()
  await win.getByTestId('upgrade-confirm-submit').click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
  const mutations = await readMutations()
  expect(mutations.length).toBe(before + 1)
  expect(mutations.at(-1)?.args[0]).toBe(`demo-plugin@${LATEST_VERSION}`)
})
