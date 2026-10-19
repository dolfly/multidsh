import { createServer, type Server } from 'node:http'
import { _electron as electron, expect, test } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'
import { backToOverview } from './overview'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

/**
 * 解码 PNG(RGBA/8bit)为像素缓冲,只支持 Playwright 截图产出的形态。
 * 用于核对原生提示的圆角描边是否真的绘制出来,而不只是 computed style 正确。
 */
function decodePng(buffer: Buffer): { width: number; height: number; pixels: Buffer } {
  let pos = 8
  let width = 0
  let height = 0
  const chunks: Buffer[] = []
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6)
        throw new Error(`unsupported png: depth=${data[8]} color=${data[9]}`)
    } else if (type === 'IDAT') {
      chunks.push(data)
    }
    pos += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw.readUInt8(y * (stride + 1))
    const lineStart = y * (stride + 1) + 1
    const prevStart = y === 0 ? -1 : (y - 1) * stride
    const currentStart = y * stride
    for (let i = 0; i < stride; i += 1) {
      const a = i >= 4 ? pixels.readUInt8(currentStart + i - 4) : 0
      const b = prevStart < 0 ? 0 : pixels.readUInt8(prevStart + i)
      const c = i >= 4 && prevStart >= 0 ? pixels.readUInt8(prevStart + i - 4) : 0
      let value = raw.readUInt8(lineStart + i)
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      pixels.writeUInt8(value & 0xff, currentStart + i)
    }
  }
  return { width, height, pixels }
}

/**
 * 统计提示可见区域的边框像素:四角圆角弧线与四边直线都必须存在,
 * 且窗口四角本身必须是透明像素(否则说明圆角被窗口边界裁成了直角)。
 */
function inspectTooltipCorners(png: Buffer): {
  cornerBorderPixels: number
  edgeBorderPixels: number
  transparentCorners: boolean
} | null {
  const { width, height, pixels } = decodePng(png)
  const alphaAt = (x: number, y: number): number => pixels.readUInt8((y * width + x) * 4 + 3)
  const isBorder = (x: number, y: number): boolean => {
    const i = (y * width + x) * 4
    if (pixels.readUInt8(i + 3) < 200) return false
    const luminance = (pixels.readUInt8(i) + pixels.readUInt8(i + 1) + pixels.readUInt8(i + 2)) / 3
    return luminance > 180 && luminance < 245
  }
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alphaAt(x, y) > 128) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  // 圆角弧线:从可见区域四角沿对角线向内扫,必须命中边框像素。
  let cornerBorderPixels = 0
  const span = Math.min(24, maxX - minX, maxY - minY)
  for (const [ox, oy, dx, dy] of [
    [minX, minY, 1, 1],
    [maxX, minY, -1, 1],
    [minX, maxY, 1, -1],
    [maxX, maxY, -1, -1]
  ] as const) {
    for (let step = 0; step < span; step += 1) {
      if (isBorder(ox + dx * step, oy + dy * step)) cornerBorderPixels += 1
    }
  }
  // 四边直线:可见区域各边中点附近必须有边框像素。
  let edgeBorderPixels = 0
  const midX = Math.floor((minX + maxX) / 2)
  const midY = Math.floor((minY + maxY) / 2)
  for (let offset = -6; offset <= 6; offset += 1) {
    if (isBorder(midX + offset, minY)) edgeBorderPixels += 1
    if (isBorder(midX + offset, maxY)) edgeBorderPixels += 1
    if (isBorder(minX, midY + offset)) edgeBorderPixels += 1
    if (isBorder(maxX, midY + offset)) edgeBorderPixels += 1
  }
  // 窗口四角必须透明:非透明说明系统窗口圆角把描边切成了直角或裁掉了弧线。
  const transparentCorners =
    alphaAt(0, 0) < 25 &&
    alphaAt(width - 1, 0) < 25 &&
    alphaAt(0, height - 1) < 25 &&
    alphaAt(width - 1, height - 1) < 25
  return { cornerBorderPixels, edgeBorderPixels, transparentCorners }
}

/**
 * UI E2E 与截图验证：向导布局、认证状态、明文提示、顶栏布局和详情页。
 *
 * 认证链路用本地假网关驱动(与 tests/contract 的真值口径一致):
 *   GET  /            → 302 <base>/login(网关特征)
 *   POST /login/auth  → 带 otp:200 + Set-Cookie;不带:400 otp-required(OTP 变体)
 *                       或 200 + Set-Cookie(无 OTP 变体,验证「可跳过」)
 */

const DATA_DIR = e2eDataDir('e2e-polish')
const SHOT_DIR = e2eDataDir('ui-polish-shots')

let app: ElectronApplication
let win: Page

const launchArgs = buildLaunchArgs()

/** 假网关:requireOtp=false 时首登直接 200;true 时首登 400 otp-required、带码 200 */
function startFakeGateway(requireOtp: boolean): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      // 探测打 <base>/ = /dsh/(带尾斜杠);登录页特征 = 302 到 <base>/login
      if (url.pathname === '/' || url.pathname === '/dsh' || url.pathname === '/dsh/') {
        res.writeHead(302, { location: '/dsh/login' })
        res.end()
        return
      }
      if (url.pathname.endsWith('/login-api/settings')) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthenticated' }))
        return
      }
      if (url.pathname.endsWith('/login/auth') && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk: Buffer) => {
          body += String(chunk)
        })
        req.on('end', () => {
          let otp: string | undefined
          try {
            otp = (JSON.parse(body) as { otp?: string }).otp
          } catch {
            otp = undefined
          }
          if (requireOtp && otp === undefined) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'otp-required' }))
            return
          }
          res.writeHead(200, {
            'content-type': 'application/json',
            'set-cookie': 'dsh_auth=ticket123; Path=/; HttpOnly'
          })
          res.end(JSON.stringify({ ok: true }))
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolvePromise({ server, port })
    })
  })
}

/**
 * 假网关(OTP 页面直跳):页面探测 302 → /otp/verify 触发 otp-page 证据,
 * 探测直接进入 await-otp,跳过密码屏——用于测试 OTP 屏的密码输入框。
 * 首登无密码:401;带 OTP 的 POST:200。
 */
function startFakeOtpGateway(): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      // 页面探测 → 302 → /otp/verify (otp-page 证据)
      if (url.pathname === '/' || url.pathname === '/dsh' || url.pathname === '/dsh/') {
        res.writeHead(302, { location: '/dsh/otp/verify' })
        res.end()
        return
      }
      if (url.pathname.endsWith('/login-api/settings')) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthenticated' }))
        return
      }
      if (url.pathname.endsWith('/login/auth') && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk: Buffer) => {
          body += String(chunk)
        })
        req.on('end', () => {
          let otp: string | undefined
          let password: string | undefined
          try {
            const parsed = JSON.parse(body) as { otp?: string; password?: string }
            otp = parsed.otp
            password = parsed.password
          } catch {
            otp = undefined
            password = undefined
          }
          if (!password || !otp) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'otp-required' }))
            return
          }
          res.writeHead(200, {
            'content-type': 'application/json',
            'set-cookie': 'dsh_auth=ticket123; Path=/; HttpOnly'
          })
          res.end(JSON.stringify({ ok: true }))
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolvePromise({ server, port })
    })
  })
}

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(SHOT_DIR, { recursive: true })
  app = await electron.launch({
    args: launchArgs,
    env: e2eEnv(DATA_DIR)
  })
  win = await app.firstWindow()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  // 侧栏收起态（rail）持久化在真实 userData 的 localStorage，会跨 spec 文件残留；
  // 归位到展开态，各用例再自行收敛到所需状态（见「收起态悬停提示」的范式），不依赖执行顺序。
  await win.evaluate(() => localStorage.setItem('dshhub-rail', '0'))
  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app.close()
})

test('顶栏横跨全宽:sidebar 边框不到窗口顶,红绿灯落在顶栏带内', async () => {
  // 结构断言:topbar 与 sidebar 是 app-shell 的并列 grid 项,且 topbar 在前
  const layout = await win.evaluate(() => {
    const shell = document.querySelector('[data-testid="app-shell"]')
    if (!shell) return null
    const topbar = shell.querySelector('.topbar')
    const sidebar = shell.querySelector('[data-testid="sidebar"]')
    if (!topbar || !sidebar) return null
    const tb = topbar.getBoundingClientRect()
    const sb = sidebar.getBoundingClientRect()
    const style = getComputedStyle(shell)
    return {
      topbarX: tb.x,
      topbarW: tb.width,
      shellW: shell.getBoundingClientRect().width,
      sidebarTop: sb.y,
      sidebarWidth: sb.width,
      titleX:
        (topbar.querySelector('.tb-title') as HTMLElement | null)?.getBoundingClientRect().x ??
        null,
      topbarBottom: tb.y + tb.height,
      templateAreas: style.gridTemplateAreas,
      columns: style.gridTemplateColumns
    }
  })
  expect(layout).not.toBeNull()
  if (!layout) return
  // 顶栏从窗口最左缘开始、横跨全宽
  expect(layout.topbarX).toBe(0)
  expect(layout.topbarW).toBe(layout.shellW)
  // sidebar 从顶栏底缘开始(边框不再直达窗口顶部)
  expect(layout.sidebarTop).toBeGreaterThanOrEqual(layout.topbarBottom - 1)
  // macOS 展开态:标题与 sidebar 内容轴对齐，而不是紧贴红绿灯。Linux 无此约束。
  const isMac = process.platform === 'darwin'
  if (isMac && layout.titleX !== null)
    expect(layout.titleX).toBeGreaterThanOrEqual(layout.sidebarWidth - 1)
  const railItemId = await win.evaluate(async () => {
    const result = await window.dshHub.instances.create({
      transport: 'http',
      name: '收起态留白检查',
      authMode: 'none',
      endpointUrl: 'https://rail-spacing.example.com/dsh'
    })
    if (!result.ok) throw new Error(result.message)
    return result.value.id
  })
  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await expect(win.getByTestId(`inst-${railItemId}`)).toBeVisible()

  // 截图目验:展开态
  await win.screenshot({ path: join(SHOT_DIR, 'shell-expanded.png'), animations: 'disabled' })

  // 折叠态(⌘B):64px 栏 + 全宽顶栏；展开/收起控件固定在侧栏底部，避免与 Logo 冲突。
  const collapseBefore = await win.getByTestId('sidebar-collapse-btn').boundingBox()
  const sidebarBefore = await win.getByTestId('sidebar').boundingBox()
  expect(collapseBefore).not.toBeNull()
  expect(sidebarBefore).not.toBeNull()
  if (collapseBefore && sidebarBefore)
    expect(collapseBefore.y).toBeGreaterThan(sidebarBefore.y + sidebarBefore.height / 2)
  // 收起按钮与设置/主题同排(位于 .side-foot .row 内),不再独占一行
  const collapseInRow = await win.evaluate(() =>
    Boolean(
      document.querySelector('[data-testid="sidebar-collapse-btn"]')?.closest('.side-foot .row')
    )
  )
  expect(collapseInRow).toBe(true)
  // 展开态 logo 保持设计尺寸 28×28(此前 rail 下被 flex:0 压成 16px)
  const expandedMark = await win.evaluate(() => {
    const mark = document.querySelector('[data-testid="brand"] .brand-mark') as HTMLElement | null
    return mark ? Math.round(mark.getBoundingClientRect().width) : null
  })
  expect(expandedMark).toBe(28)
  // 鼠标已停在实例上时收起侧栏，提示也必须在 rail 状态生效后出现；
  // 不能依赖用户额外移出再移入触发第二次 hover。
  const railInstance = win.getByTestId(`inst-${railItemId}`)
  await railInstance.hover()
  await win.keyboard.press('Meta+b')
  // 等过渡真正落到 64px 再截图/断言：固定 sleep 在慢机器上会读到中间态。
  await expect
    .poll(() =>
      win.evaluate(
        () =>
          getComputedStyle(document.querySelector('[data-testid="app-shell"]') as Element)
            .gridTemplateColumns
      )
    )
    .toContain('64px')
  await win.screenshot({ path: join(SHOT_DIR, 'shell-rail.png'), animations: 'disabled' })
  const railCols = await win.evaluate(
    () =>
      getComputedStyle(document.querySelector('[data-testid="app-shell"]') as Element)
        .gridTemplateColumns
  )
  expect(railCols.split(' ')[0]).toBe('64px')
  await expect(railInstance).toHaveAttribute('title', '收起态留白检查')
  const collapseAfter = await win.getByTestId('sidebar-collapse-btn').boundingBox()
  const brandAfter = await win.getByTestId('brand').boundingBox()
  expect(collapseAfter).not.toBeNull()
  expect(brandAfter).not.toBeNull()
  if (collapseAfter && brandAfter)
    expect(collapseAfter.y).toBeGreaterThan(brandAfter.y + brandAfter.height)
  // 折叠态 logo 不得小于展开态(此前被压缩到 16px)
  const railMark = await win.evaluate(() => {
    const mark = document.querySelector('[data-testid="brand"] .brand-mark') as HTMLElement | null
    return mark ? Math.round(mark.getBoundingClientRect().width) : null
  })
  expect(railMark).not.toBeNull()
  if (railMark !== null && expandedMark !== null)
    expect(Math.abs(railMark - expandedMark)).toBeLessThanOrEqual(3)
  const railItem = await win.getByTestId(`inst-${railItemId}`).boundingBox()
  expect(railItem).not.toBeNull()
  if (railItem) {
    expect(railItem.x).toBeGreaterThan(0)
    expect(railItem.x + railItem.width).toBeLessThan(64)
  }
  await win.keyboard.press('Meta+b')
  // 收尾等展开真正生效：下一用例按 classList 归一化状态，读到中间态会二次按键来回翻转。
  await expect
    .poll(() =>
      win.evaluate(() =>
        document.querySelector('[data-testid="app-shell"]')?.classList.contains('rail')
      )
    )
    .toBe(false)
})

test('收起态悬停提示的四边与圆角一致', async () => {
  const instanceId = await win.evaluate(async () => {
    const created = await window.dshHub.instances.create({
      transport: 'http',
      name: '收起态提示边框',
      authMode: 'none',
      endpointUrl: 'https://rail-tooltip.example.com/dsh'
    })
    if (!created.ok) throw new Error(created.message)
    return created.value.id
  })
  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  // 提示只在收起态出现,先把侧栏收敛到已知状态,避免依赖前序用例的收展状态。
  const collapsed = await win.evaluate(() =>
    document.querySelector('[data-testid="app-shell"]')?.classList.contains('rail')
  )
  if (!collapsed) await win.keyboard.press('Meta+b')
  await expect
    .poll(() =>
      win.evaluate(
        () =>
          getComputedStyle(document.querySelector('[data-testid="app-shell"]') as Element)
            .gridTemplateColumns
      )
    )
    .toContain('64px')
  const railItem = win.getByTestId(`inst-${instanceId}`)
  await expect(railItem).toBeVisible()
  await railItem.hover()

  // 提示是独立原生窗口(renderer DOM 会被原生工作区视图盖住),必须真实出现。
  // 窗口实例会被复用,必须等到它显示当前实例名称,否则可能读到上一次的旧内容。
  await expect
    .poll(
      async () => {
        const page = app.windows().find((candidate) => candidate.url().startsWith('data:text/html'))
        if (!page) return null
        return (
          (await page
            .locator('main')
            .textContent()
            .catch(() => null)) ?? null
        )
      },
      { timeout: 10000 }
    )
    .toBe('收起态提示边框')
  const tooltipPage = app
    .windows()
    .find((candidate) => candidate.url().startsWith('data:text/html'))
  expect(tooltipPage).toBeDefined()
  const tooltipStyle = await tooltipPage?.evaluate(() => {
    const box = document.querySelector('main')
    if (!box) return null
    const style = getComputedStyle(box)
    const rect = box.getBoundingClientRect()
    const body = document.body.getBoundingClientRect()
    return {
      text: box.textContent,
      radius: style.borderTopLeftRadius,
      widths: [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth
      ],
      colors: [
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor
      ],
      // 圆角描边必须完整落在窗口内,否则四角会被窗口边界裁掉。
      inset: {
        top: rect.top - body.top,
        left: rect.left - body.left,
        right: body.right - rect.right,
        bottom: body.bottom - rect.bottom
      }
    }
  })
  expect(tooltipStyle?.text).toBe('收起态提示边框')
  expect(tooltipStyle?.radius).toBe('7px')
  expect(tooltipStyle?.widths).toEqual(['1px', '1px', '1px', '1px'])
  expect(new Set(tooltipStyle?.colors).size).toBe(1)
  // 提示盒子按文本宽度收缩(width:max-content),右侧可能留出透明的窗口余量,
  // 因此其余三边必须恰为安全区宽度,右侧只要求不小于安全区,避免圆角描边被窗口遮罩裁掉。
  expect(tooltipStyle?.inset.top).toBe(14)
  expect(tooltipStyle?.inset.left).toBe(14)
  expect(tooltipStyle?.inset.bottom).toBe(14)
  expect(tooltipStyle?.inset.right).toBeGreaterThanOrEqual(14)

  // 像素级核对:直接截取提示页面并解码,确认四角圆角处存在边框像素。
  // 只看 computed style 无法发现「四角被窗口边界裁掉」这类合成层缺陷。
  // 隐藏窗口模式下 macOS 不为不显示的子窗口持续合成帧,page.screenshot 会等不到稳定帧,
  // 因此经主进程用 capturePage(stayHidden) 强制离屏渲染一帧;透明窗口的截图自带 alpha。
  const shot = await app.evaluate(({ BrowserWindow }) => {
    const tooltip = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith('data:text/html')
    )
    if (!tooltip) return null
    return tooltip.webContents
      .capturePage(undefined, { stayHidden: true })
      .then((image) => image.toPNG())
  })
  expect(shot).not.toBeNull()
  const corners = shot ? inspectTooltipCorners(Buffer.from(shot)) : null
  expect(corners).not.toBeNull()
  expect(corners?.cornerBorderPixels).toBeGreaterThanOrEqual(4)
  expect(corners?.edgeBorderPixels).toBeGreaterThanOrEqual(4)
  expect(corners?.transparentCorners).toBe(true)

  // 指针移开后提示必须隐藏,不留悬浮窗口。
  await win.mouse.move(600, 400)
  await expect
    .poll(() =>
      app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter(
            (candidate) =>
              candidate.isVisible() && candidate.webContents.getURL().startsWith('data:text/html')
          ).length
      )
    )
    .toBe(0)
})

test('刷新后不会保留旧的原生工作区边界', async () => {
  const instanceId = await win.evaluate(async () => {
    const created = await window.dshHub.instances.create({
      transport: 'http',
      name: '刷新边界恢复',
      authMode: 'none',
      endpointUrl: 'https://reload-bounds.example.com/dsh'
    })
    if (!created.ok) throw new Error(created.message)
    return created.value.id
  })
  await win.reload()
  await expect(win.getByTestId(`inst-${instanceId}`)).toBeVisible()
  await win.getByTestId(`inst-${instanceId}`).click()
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible()
  // 用快捷键切换侧栏制造一次原生布局变更，为下面的「边界清零」断言确保有过非零起点；
  // 切换方向依赖当前 rail 态，因此不在此断言侧栏文案（rail 持久化后方向随前序用例变化）。
  await win.keyboard.press('Meta+b')
  await win.waitForTimeout(300)

  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const workspace = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.contentView.children.length > 0
        )?.contentView.children[0] as
          | { isVisible?: () => boolean; getBounds?: () => { width: number; height: number } }
          | undefined
        return workspace
          ? { visible: workspace.isVisible?.() ?? true, bounds: workspace.getBounds?.() ?? null }
          : null
      })
    )
    .toMatchObject({ bounds: { width: 0, height: 0 } })
})

test('SSH 认证对话框限制在右侧工作区且指纹复制行不溢出', async () => {
  const workspaceId = await win.evaluate(async () => {
    const created = await window.dshHub.instances.create({
      transport: 'http',
      name: 'SSH 对话框工作区范围',
      authMode: 'none',
      endpointUrl: 'https://workspace-scope.example.com/dsh'
    })
    if (!created.ok) throw new Error(created.message)
    return created.value.id
  })
  await win.reload()
  await expect(win.getByTestId(`inst-${workspaceId}`)).toBeVisible()
  await win.getByTestId(`inst-${workspaceId}`).click()
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible()
  // 悬停提示只在收起态出现：先收敛到已知收起态，避免依赖前序用例的收展状态（同「收起态悬停提示」）。
  const collapsed = await win.evaluate(() =>
    document.querySelector('[data-testid="app-shell"]')?.classList.contains('rail')
  )
  if (!collapsed) await win.keyboard.press('Meta+b')
  const workspaceRailItem = win.getByTestId(`inst-${workspaceId}`)
  await workspaceRailItem.hover()
  await expect
    .poll(() =>
      app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter(
            (candidate) => candidate !== BrowserWindow.getFocusedWindow() && candidate.isVisible()
          ).length
      )
    )
    .toBeGreaterThan(0)

  await app.evaluate(({ BrowserWindow }) => {
    const hub = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.contentView.children.length > 0
    )
    hub?.webContents.send('ssh:hostKeyDecision', {
      requestId: 'ui-polish-host-key',
      instanceId: 'ui-polish-instance',
      target: 'vsgp',
      verdict: 'unknown',
      fingerprints: [
        {
          type: 'ssh-ed25519',
          typeLabel: 'ED25519',
          fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789'
        }
      ],
      previousFingerprints: []
    })
  })
  await expect(win.getByTestId('fingerprint-dialog')).toBeVisible()
  const geometry = await win.evaluate(() => {
    const shell = document.querySelector('[data-testid="app-shell"]')
    const sidebar = document.querySelector('[data-testid="sidebar"]')
    const topbar = document.querySelector('.topbar')
    const overlay = document.querySelector('.overlay-workspace')
    const dialog = document.querySelector('[data-testid="fingerprint-dialog"]')
    const copy = document.querySelector('.fingerprint-copy')
    const value = document.querySelector('.fingerprint-value')
    if (!shell || !sidebar || !topbar || !overlay || !dialog || !copy || !value) return null
    const shellBox = shell.getBoundingClientRect()
    const sidebarBox = sidebar.getBoundingClientRect()
    const topbarBox = topbar.getBoundingClientRect()
    const overlayBox = overlay.getBoundingClientRect()
    const dialogBox = dialog.getBoundingClientRect()
    const copyBox = copy.getBoundingClientRect()
    const valueBox = value.getBoundingClientRect()
    return {
      shellLeft: shellBox.left,
      sidebarRight: sidebarBox.right,
      topbarBottom: topbarBox.bottom,
      overlayLeft: overlayBox.left,
      overlayTop: overlayBox.top,
      dialogRight: dialogBox.right,
      contentRight: shellBox.right,
      copyRight: copyBox.right,
      insetRight: valueBox.right
    }
  })
  expect(geometry).not.toBeNull()
  if (!geometry) return
  expect(geometry.overlayLeft).toBeGreaterThanOrEqual(geometry.sidebarRight - 1)
  expect(geometry.overlayTop).toBeGreaterThanOrEqual(geometry.topbarBottom - 1)
  expect(geometry.dialogRight).toBeLessThanOrEqual(geometry.contentRight + 1)
  expect(geometry.copyRight).toBeLessThanOrEqual(geometry.contentRight + 1)
  expect(geometry.insetRight).toBeLessThanOrEqual(geometry.copyRight + 1)
  await win.getByTestId('fingerprint-dialog').locator('.x-btn').click()
  await expect(win.getByTestId('fingerprint-dialog')).toBeHidden()
})

test('向导三选项卡:间距与边框关系正常(截图目验)', async () => {
  await win.getByTestId('new-instance-btn').click()
  await expect(win.getByTestId('wizard')).toBeVisible()
  await expect(win.getByTestId('wizard-step-1')).toBeVisible()
  // 结构断言:type-cards 与 modal-head 边框之间有真实间隙(不重叠)
  const gap = await win.evaluate(() => {
    const head = document.querySelector('[data-testid="wizard"] .modal-head')
    const cards = document.querySelector('[data-testid="wizard-step-1"]')
    if (!head || !cards) return null
    const headBottom = head.getBoundingClientRect().bottom
    const cardsTop = cards.getBoundingClientRect().top
    return { headBottom, cardsTop, delta: cardsTop - headBottom }
  })
  expect(gap).not.toBeNull()
  if (!gap) return
  expect(gap.delta).toBeGreaterThan(8) // 有 ≥8px 间隙,不是贴着重叠
  await win.screenshot({ path: join(SHOT_DIR, 'wizard-step1.png'), animations: 'disabled' })
  // 关闭向导(点 ✕)
  await win.locator('[data-testid="wizard"] .x-btn').click()
  await expect(win.getByTestId('wizard')).toBeHidden()
})

test('认证链路:按钮状态化 + 密码屏/OTP 屏 + 无 OTP 直连 + pill hover', async () => {
  const { server, port } = await startFakeGateway(true)
  test.setTimeout(60_000)
  try {
    // 创建 OTP 网关实例(http + auto)
    const created = await win.evaluate(async (p) => {
      const r = await window.dshHub.instances.create({
        transport: 'http',
        name: 'OTP 网关实例',
        authMode: 'auto',
        endpointUrl: `http://127.0.0.1:${p}/dsh`
      })
      if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r)}`)
      const s = await window.dshHub.runtime.start(r.value.id)
      return { id: r.value.id, startOk: s.ok }
    }, port)
    expect(created.startOk).toBe(true)
    await win.waitForTimeout(600) // 探测完成(302→login → await-credentials)
    // evaluate 直创实例不经过渲染层 store → 重载让列表/详情缓存同步
    await win.reload()
    await expect(win.getByTestId('app-shell')).toBeVisible()

    // 重载会恢复刷新前的视图：本用例从列表起步，先确保回到总览。
    await backToOverview(win)
    await win.getByTestId('instances-table').getByText('OTP 网关实例', { exact: true }).click()
    await expect(win.getByTestId('view-detail')).toBeVisible()
    // 新实例默认保存密码与会话，用户可显式取消。
    await expect(win.getByTestId('vault-remember-password')).toBeChecked()
    await expect(win.getByTestId('vault-remember-session')).toBeChecked()

    // 未登录态 —— 按钮是「登录」且没有「登出」
    await expect(win.getByTestId('login-btn')).toBeVisible()
    await expect(win.getByTestId('login-btn')).toContainText('登录')
    await expect(win.getByTestId('login-btn')).not.toContainText('重新登录')
    expect(await win.getByTestId('logout-btn').count()).toBe(0)
    await win.screenshot({
      path: join(SHOT_DIR, 'detail-not-logged-in.png'),
      animations: 'disabled'
    })

    // 明文胶囊 hover 出现提示气泡
    const pill = win.getByTestId('cleartext-warning')
    if ((await pill.count()) > 0) {
      await pill.hover()
      await win.waitForTimeout(200)
      await win.screenshot({ path: join(SHOT_DIR, 'pill-hover.png'), animations: 'disabled' })
    }

    // 打开认证面板 → 密码屏
    await win.getByTestId('login-btn').click()
    await expect(win.getByTestId('auth-panel')).toBeVisible()
    await win.screenshot({ path: join(SHOT_DIR, 'auth-password.png'), animations: 'disabled' })

    // 提交密码 → 假网关 400 otp-required → OTP 屏(截图:按钮形态目验)
    await win.getByTestId('auth-password').fill('hunter2')
    await win.getByTestId('auth-submit').click()
    await expect(win.getByTestId('auth-otp')).toBeVisible({ timeout: 10_000 })
    await win.screenshot({ path: join(SHOT_DIR, 'auth-otp.png'), animations: 'disabled' })

    // 输入验证码 → 200 + cookie → connected → 面板自动关闭
    await win.getByTestId('auth-otp').fill('654321')
    await win.getByTestId('auth-submit').click()
    await expect(win.getByTestId('auth-panel')).toBeHidden({ timeout: 10_000 })

    // 已连接态 —— 「重新登录」出现,「登出」出现
    await expect(win.getByTestId('login-btn')).toContainText('重新登录')
    await expect(win.getByTestId('logout-btn')).toBeVisible()
    // 密码 + TOTP 登录成功后「凭据存储」必须就地更新,不需要进出工作区才刷新
    await expect(win.getByTestId('vault-state')).toContainText('已记住')
    await win.screenshot({ path: join(SHOT_DIR, 'detail-connected.png'), animations: 'disabled' })

    // 登出 → 回到「登录」且无登出按钮
    await win.getByTestId('logout-btn').click()
    await expect(win.getByTestId('login-btn')).toContainText('登录')
    await expect(win.getByTestId('login-btn')).not.toContainText('重新登录')
    expect(await win.getByTestId('logout-btn').count()).toBe(0)
  } finally {
    server.close()
  }

  // 无 OTP 变体:首登 200 直连 —— 不出现 TOTP 页(「实例未设置 OTP 可跳过」)
  const direct = await startFakeGateway(false)
  try {
    await win.evaluate(async (p) => {
      const r = await window.dshHub.instances.create({
        transport: 'http',
        name: '无 OTP 网关实例',
        authMode: 'auto',
        endpointUrl: `http://127.0.0.1:${p}/dsh`
      })
      if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r)}`)
      await window.dshHub.runtime.start(r.value.id)
      return r.value.id
    }, direct.port)
    await win.waitForTimeout(600)
    await win.reload()
    await expect(win.getByTestId('app-shell')).toBeVisible()
    // 重载会恢复刷新前的视图：本用例从列表起步，先确保回到总览。
    await backToOverview(win)
    await win.getByTestId('instances-table').getByText('无 OTP 网关实例', { exact: true }).click()
    await expect(win.getByTestId('view-detail')).toBeVisible()
    await win.getByTestId('login-btn').click()
    await expect(win.getByTestId('auth-panel')).toBeVisible()
    await win.getByTestId('auth-password').fill('pw1234')
    await win.getByTestId('auth-submit').click()
    // 直接 connected:面板关闭,全程无 auth-otp 输入框
    await expect(win.getByTestId('auth-panel')).toBeHidden({ timeout: 10_000 })
    expect(await win.getByTestId('auth-otp').count()).toBe(0)

    // 密码已入保险库;登出只清会话,不清密码。重新打开面板时用显式入口复用已存密码,
    // 不手输任何内容也能登录 —— 且密码不写进渲染层,密码框始终为空。
    await expect(win.getByTestId('vault-state')).toContainText('已记住')
    await win.getByTestId('logout-btn').click()
    await expect(win.getByTestId('login-btn')).toContainText('登录')
    await win.getByTestId('login-btn').click()
    await expect(win.getByTestId('auth-panel')).toBeVisible()
    await expect(win.getByTestId('auth-password')).toHaveValue('')
    await expect(win.getByTestId('auth-use-stored')).toBeVisible()
    await win.getByTestId('auth-use-stored').click()
    await expect(win.getByTestId('auth-panel')).toBeHidden({ timeout: 10_000 })
    await expect(win.getByTestId('login-btn')).toContainText('重新登录')
  } finally {
    direct.server.close()
  }
})

test('从已连接的工作区重新登录成功后自动重开工作区', async () => {
  // 有状态假网关：带 cookie 且会话有效时 GET / 返回 200 受保护页面（工作区正常展示）；
  // gate.authed 置回 false 模拟远端 dsh 重启导致会话失效，此后探测回落到登录态。
  const gate = { authed: false }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const hasCookie = (req.headers.cookie ?? '').includes('dsh_auth=')
    if (url.pathname === '/' || url.pathname === '/dsh' || url.pathname === '/dsh/') {
      if (hasCookie && gate.authed) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<!doctype html><title>ws</title><p>authed workspace</p>')
        return
      }
      res.writeHead(302, { location: '/dsh/login' })
      res.end()
      return
    }
    if (url.pathname.endsWith('/login-api/settings')) {
      if (hasCookie && gate.authed) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, config: { 'dsh-auth-gateway': { otpEnabled: false } } }))
        return
      }
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthenticated' }))
      return
    }
    if (url.pathname.endsWith('/login/auth') && req.method === 'POST') {
      gate.authed = true
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'dsh_auth=ticket123; Path=/; HttpOnly'
      })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  test.setTimeout(60_000)
  try {
    const created = await win.evaluate(async (p) => {
      const r = await window.dshHub.instances.create({
        transport: 'http',
        name: '重登自动重开实例',
        authMode: 'auto',
        endpointUrl: `http://127.0.0.1:${p}/dsh`
      })
      if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r)}`)
      const s = await window.dshHub.runtime.start(r.value.id)
      return { id: r.value.id, startOk: s.ok }
    }, port)
    expect(created.startOk).toBe(true)
    await win.waitForTimeout(600)
    await win.reload()
    await expect(win.getByTestId('app-shell')).toBeVisible()

    // 重载会恢复刷新前的视图：本用例从列表起步，先确保回到总览。
    await backToOverview(win)
    await win.getByTestId('instances-table').getByText('重登自动重开实例', { exact: true }).click()
    await expect(win.getByTestId('view-detail')).toBeVisible()

    // 首次登录 → connected（密码入保险库供后续显式复用）
    await win.getByTestId('login-btn').click()
    await expect(win.getByTestId('auth-panel')).toBeVisible()
    await win.getByTestId('auth-password').fill('pw1234')
    await win.getByTestId('auth-submit').click()
    await expect(win.getByTestId('auth-panel')).toBeHidden({ timeout: 10_000 })
    await expect(win.getByTestId('login-btn')).toContainText('重新登录')

    // 打开工作区建立「工作区已连接」态（带 cookie 命中 200 受保护页），再返回详情
    await win.getByTestId('open-view-btn').click()
    await expect(win.getByTestId('workspace-back-btn')).toBeVisible({ timeout: 20_000 })
    await win.getByTestId('workspace-back-btn').click()
    await expect(win.getByTestId('view-detail')).toBeVisible()

    // 模拟远端 dsh 重启：现有会话失效，探测将回落到登录态。
    gate.authed = false

    // 从详情页触发重新登录：打开面板会探测并用已存密码静默复登，登录成功后
    // （无论经静默复登还是显式提交）工作区都应自动重开，无需再手动点「打开工作区」。
    await win.getByTestId('login-btn').click()
    // 若面板停在密码/已存密码屏，点「使用已存密码」；若已静默复登成功则面板已关闭。
    const useStored = win.getByTestId('auth-use-stored')
    try {
      await useStored.waitFor({ state: 'visible', timeout: 3_000 })
      await useStored.click()
    } catch {
      // 静默复登已在探测阶段完成 → 面板未出现或已关闭，直接等待工作区重开。
    }
    // 关键断言：出现工作区返回按钮 = 已自动回到工作区，而非停在详情页
    await expect(win.getByTestId('workspace-back-btn')).toBeVisible({ timeout: 20_000 })
  } finally {
    server.close()
  }
})

test('OTP 屏无已存密码时密码输入框持续可见且可提交', async () => {
  const { server, port } = await startFakeOtpGateway()
  test.setTimeout(60_000)
  try {
    const created = await win.evaluate(async (p) => {
      const r = await window.dshHub.instances.create({
        transport: 'http',
        name: 'OTP 无密码实例',
        authMode: 'auto',
        endpointUrl: `http://127.0.0.1:${p}/dsh`
      })
      if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r)}`)
      const s = await window.dshHub.runtime.start(r.value.id)
      return { id: r.value.id, startOk: s.ok }
    }, port)
    expect(created.startOk).toBe(true)
    // 探测打 /dsh/ → 302 → /otp/verify → otp-page 证据 → await-otp
    await win.waitForTimeout(600)
    await win.reload()
    await expect(win.getByTestId('app-shell')).toBeVisible()

    // 重载会恢复刷新前的视图：本用例从列表起步，先确保回到总览。
    await backToOverview(win)
    await win.getByTestId('instances-table').getByText('OTP 无密码实例', { exact: true }).click()
    await expect(win.getByTestId('view-detail')).toBeVisible()

    // 新实例未登录过,保险库中无凭据 → storedAvailable=false
    await expect(win.getByTestId('vault-state')).not.toContainText('已记住')

    // 打开认证面板 → 探测后直接进入 await-otp(无密码屏)
    await win.getByTestId('login-btn').click()
    await expect(win.getByTestId('auth-panel')).toBeVisible()

    // OTP 屏:密码输入框必须出现(无已存密码,phase=await-otp,password='')
    const otpPwd = win.getByTestId('auth-password-in-otp')
    await expect(otpPwd).toBeVisible({ timeout: 10_000 })
    // storedAvailable=false → 不应显示已保存密码提示
    await expect(win.getByTestId('auth-stored-hint')).toBeHidden()

    // 输入密码 — 字段持续可见(不会因输入一个字符后自卸载)
    await otpPwd.fill('hunter2')
    await expect(otpPwd).toHaveValue('hunter2')

    // 输入 OTP 并提交
    await win.getByTestId('auth-otp').fill('654321')
    await win.getByTestId('auth-submit').click()
    await expect(win.getByTestId('auth-panel')).toBeHidden({ timeout: 10_000 })
    // 登录成功 → 重新登录按钮出现
    await expect(win.getByTestId('login-btn')).toContainText('重新登录')
  } finally {
    server.close()
  }
})

test('侧边栏拖拽排序 + 首页表格同步', async () => {
  test.setTimeout(60_000)
  // 创建三个实例
  const ids: string[] = []
  for (const name of ['排序实例 C', '排序实例 A', '排序实例 B']) {
    const result = await win.evaluate(async (n) => {
      const r = await window.dshHub.instances.create({
        transport: 'http',
        name: n,
        authMode: 'auto',
        endpointUrl: `http://127.0.0.1:30999/dsh`
      })
      if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r)}`)
      return r.value.id
    }, name)
    ids.push(result!)
  }
  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  // 重载会恢复刷新前的视图：本用例从列表起步，先确保回到总览。
  await backToOverview(win)

  // 获取完整列表,确认新实例在末尾
  const listBefore = await win.evaluate(async () => {
    const r = await window.dshHub.instances.list()
    return r.ok ? r.value.map((i) => ({ id: i.id, name: i.name })) : []
  })
  expect(listBefore.slice(-3).map((i) => i.name)).toEqual([
    '排序实例 C',
    '排序实例 A',
    '排序实例 B'
  ])

  // 把三个新实例重排为 A → B → C,同时保留其他实例在前面
  const others = listBefore
    .slice(0, -3)
    .map((i) => i.id)
    .filter((id): id is string => id !== undefined)
  const [idC, idA, idB] = ids
  const newOrder: string[] = [...others, idA!, idB!, idC!]
  const reordered = await win.evaluate(async (reorderedIds) => {
    const result = await window.dshHub.instances.reorder(reorderedIds)
    return result.ok ? result.value.map((i) => i.id) : null
  }, newOrder)
  expect(reordered).toEqual(newOrder)

  // 刷新页面验证持久化顺序
  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  // 同上：表格断言要求在总览。
  await backToOverview(win)

  // 侧边栏顺序验证:新实例部分 A → B → C
  const listAfter = await win.evaluate(async () => {
    const r = await window.dshHub.instances.list()
    return r.ok ? r.value.map((i) => i.id) : []
  })
  expect(listAfter.slice(-3)).toEqual([ids[1], ids[2], ids[0]])

  // 侧边栏渲染顺序也一致
  const sidebar = win.getByTestId('sidebar')
  const aBox = await sidebar.getByTestId(`inst-${ids[1]}`).boundingBox()
  const bBox = await sidebar.getByTestId(`inst-${ids[2]}`).boundingBox()
  const cBox = await sidebar.getByTestId(`inst-${ids[0]}`).boundingBox()
  expect(aBox!.y).toBeLessThan(bBox!.y)
  expect(bBox!.y).toBeLessThan(cBox!.y)

  // 首页表格也同步: A → B → C
  const table = win.getByTestId('instances-table')
  const rows = table.locator('tbody tr')
  const rowCount = await rows.count()
  const rowTexts: string[] = []
  for (let i = 0; i < rowCount; i++) {
    rowTexts.push((await rows.nth(i).textContent()) ?? '')
  }
  const aRow = rowTexts.findIndex((t) => t.includes('排序实例 A'))
  const bRow = rowTexts.findIndex((t) => t.includes('排序实例 B'))
  const cRow = rowTexts.findIndex((t) => t.includes('排序实例 C'))
  expect(aRow).toBeLessThan(bRow)
  expect(bRow).toBeLessThan(cRow)
})

test('收起侧栏时原生工作区跟随扩大（DOM 与原生边界一致）', async () => {
  test.setTimeout(60_000)
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>workspace</title><p>bounds probe</p>')
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const contentRect = async (): Promise<{ left: number; width: number } | null> =>
    win.evaluate(() => {
      const element = document.querySelector('.content')
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return { left: Math.round(rect.left), width: Math.round(rect.width) }
    })

  // 取面积最大的子视图 = 当前可见的原生工作区（其余子视图是 0×0 或小浮层）。
  const nativeBounds = async (): Promise<{
    x: number
    y: number
    width: number
    height: number
  } | null> =>
    app.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.contentView.children.length > 0
      )
      const views = (host?.contentView.children ?? [])
        .map((child) =>
          (
            child as {
              getBounds?: () => { x: number; y: number; width: number; height: number }
            }
          ).getBounds?.()
        )
        .filter(
          (bounds): bounds is { x: number; y: number; width: number; height: number } =>
            bounds !== undefined
        )
      return views.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null
    })

  try {
    const instanceId = await win.evaluate(
      async ({ port: endpointPort }) => {
        const created = await window.dshHub.instances.create({
          transport: 'http',
          name: '边界跟随检查',
          authMode: 'none',
          endpointUrl: `http://127.0.0.1:${endpointPort}/dsh`
        })
        if (!created.ok) throw new Error(created.message)
        return created.value.id
      },
      { port }
    )
    await win.reload()
    await expect(win.getByTestId('app-shell')).toBeVisible()
    await expect(win.getByTestId(`inst-${instanceId}`)).toBeVisible()

    // 前置：侧栏展开（前序用例可能停在收起态）。
    if ((await contentRect())?.left !== 262) {
      await win.getByTestId('sidebar-collapse-btn').click()
      await win.waitForTimeout(400)
    }
    expect((await contentRect())?.left, '前置：内容区应从 262 开始').toBe(262)

    await win.getByTestId(`inst-${instanceId}`).click()
    await expect(win.getByTestId('workspace-back-btn')).toBeVisible({ timeout: 20_000 })
    await win.waitForTimeout(600)

    const before = { dom: await contentRect(), native: await nativeBounds() }
    console.log('[bounds-diag before]', JSON.stringify(before))
    expect(before.native, '展开态：原生工作区应与内容区左缘对齐').toMatchObject({ x: 262 })

    await win.getByTestId('sidebar-collapse-btn').click()
    await win.waitForTimeout(700)

    const after = { dom: await contentRect(), native: await nativeBounds() }
    console.log('[bounds-diag after]', JSON.stringify(after))
    expect(after.dom?.left, '收起后：DOM 内容区左缘应到 64').toBe(64)
    expect(after.native, '收起后：原生工作区必须跟随扩大').toMatchObject({ x: 64 })
    expect(after.native?.width ?? 0).toBeGreaterThan(before.native?.width ?? 0)

    // 展开方向同样必须跟随（内容区收窄，视图左缘回到 262）。
    await win.getByTestId('sidebar-collapse-btn').click()
    await win.waitForTimeout(700)
    const restored = { dom: await contentRect(), native: await nativeBounds() }
    console.log('[bounds-diag restored]', JSON.stringify(restored))
    expect(restored.dom?.left).toBe(262)
    expect(restored.native, '展开后：原生工作区必须跟随收窄').toMatchObject({ x: 262 })

    // 过渡未结束就用快捷键连切两次：最终必须收敛到正确边界（净效果=保持展开）。
    await win.keyboard.press('Meta+b')
    await win.waitForTimeout(60)
    await win.keyboard.press('Meta+b')
    await win.waitForTimeout(700)
    const settled = { dom: await contentRect(), native: await nativeBounds() }
    console.log('[bounds-diag settled]', JSON.stringify(settled))
    expect(settled.dom?.left).toBe(262)
    expect(settled.native).toMatchObject({ x: 262, width: settled.dom?.width })

    // 断开工作区 → 收起侧栏 → 重新打开：边界必须按收起后的布局回传（打开时已是收起态）。
    await win.getByTestId('workspace-back-btn').click()
    await expect(win.getByTestId('view-detail')).toBeVisible()
    await win.keyboard.press('Meta+b')
    await win.waitForTimeout(400)
    expect((await contentRect())?.left, '断开后收起：内容区左缘应到 64').toBe(64)
    await win.getByTestId('open-view-btn').click()
    await expect(win.getByTestId('workspace-back-btn')).toBeVisible({ timeout: 20_000 })
    await win.waitForTimeout(600)
    const reopened = { dom: await contentRect(), native: await nativeBounds() }
    console.log('[bounds-diag reopened]', JSON.stringify(reopened))
    expect(reopened.native, '收起态下打开的原生工作区应从 64 起步').toMatchObject({
      x: 64,
      width: reopened.dom?.width
    })
  } finally {
    server.close()
  }
})
