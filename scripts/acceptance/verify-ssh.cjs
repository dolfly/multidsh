/* SSH 隧道验证：临时 sshd、连通性检查、自动重连、停止回收和退出清理。
   用法：cd <repo> && node ./scripts/acceptance/verify-ssh.cjs
   前置：pnpm build。 */
const { _electron: electron } = require('@playwright/test')
const { mkdir, rm, writeFile, chmod, readFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { execSync, spawn } = require('node:child_process')
const http = require('node:http')

const ACC = '/tmp/dsh-ssh-accept'
const DATA_DIR = resolve(process.cwd(), 'hub-data', 'verify-ssh')
const SSH_PORT = 32222
const HTTP_PORT = 33080
const SSH_USER = process.env.USER || 'dev'
let app = null
let sshdProc = null
let httpServer = null

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim()
}

async function setupSshd() {
  await rm(ACC, { recursive: true, force: true })
  await mkdir(join(ACC, 'authkeys'), { recursive: true })
  // 主机密钥 + 客户端密钥(仅本验收使用,不给真实账号加公钥)
  sh(`ssh-keygen -t ed25519 -f ${ACC}/hostkey -N '' -q`)
  sh(`ssh-keygen -t ed25519 -f ${ACC}/client -N '' -q`)
  await writeFile(join(ACC, 'authkeys', 'authorized_keys'), await readFile(`${ACC}/client.pub`))
  await chmod(`${ACC}/hostkey`, 0o600)
  const config = [
    `Port ${SSH_PORT}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${ACC}/hostkey`,
    `PidFile ${ACC}/sshd.pid`,
    `AuthorizedKeysFile ${ACC}/authkeys/authorized_keys`,
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'ChallengeResponseAuthentication no',
    'UsePAM no',
    'StrictModes no',
    'PermitRootLogin no',
    'LogLevel ERROR',
    'PrintMotd no'
  ].join('\n')
  await writeFile(join(ACC, 'sshd_config'), `${config}\n`)
  // 若端口已被占用则快速失败，避免连接到其他 sshd。
  try {
    sh(`nc -z -w1 127.0.0.1 ${SSH_PORT}`)
    throw new Error(`端口 ${SSH_PORT} 已被占用(可能是遗留 sshd),请先清理`)
  } catch (error) {
    if (String(error.message).includes('已被占用')) throw error
  }
  // 后台起 sshd(独立进程组,脚本结束需手动回收)
  sshdProc = spawn('/usr/sbin/sshd', ['-f', join(ACC, 'sshd_config')], {
    detached: true,
    stdio: 'ignore'
  })
  sshdProc.unref()
  // 就绪判定:pidfile 存在 + 进程存活 + 端口可连(三重校验)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      const pid = sh(`cat ${ACC}/sshd.pid 2>/dev/null || true`)
      if (pid) {
        sh(`kill -0 ${pid}`)
        sh(`nc -z -w1 127.0.0.1 ${SSH_PORT}`)
        console.log(`[ok] sshd 就绪 127.0.0.1:${SSH_PORT}（pid ${pid}）`)
        return
      }
    } catch {
      /* 继续等待 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('sshd 未在 8s 内就绪')
}

function startHttpServer() {
  httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ssh-tunnel-ok')
  })
  httpServer.listen(HTTP_PORT, '127.0.0.1')
  console.log(`[ok] 测试 HTTP 服务器 127.0.0.1:${HTTP_PORT}`)
}

async function fetchThroughTunnel(port) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.status === 200) return await res.text()
    } catch {
      /* 隧道未就绪,重试 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

async function waitEvent(loadEvents, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = await loadEvents() // 每次实时读取,不持有快照
    const hit = events.find(predicate)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 200))
  }
  const events = await loadEvents()
  throw new Error(`等待事件超时:${label}(当前事件 ${events.length} 条)`)
}

async function main() {
  try {
    sh(`pkill -f 'dsh-hub-ssh-' || true`)
    sh(
      `find /var/folders -maxdepth 5 -name 'dsh-hub-ssh-*' -type d -exec rm -rf {} + 2>/dev/null || true`
    )
    sh(`pkill -f 'ControlPath=.*verify-ssh' || true`)
    sh(`pkill -f 'sshd.*dsh-ssh-accept' || true`)
  } catch {
    /* 无残留 */
  }
  await new Promise((r) => setTimeout(r, 1000))
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })

  await setupSshd()
  startHttpServer()

  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  app.process().stderr.on('data', (chunk) => {
    const text = String(chunk)
    if (/ssh-tunnel|传输|隧道|失败|error/i.test(text)) process.stderr.write(`[main] ${text}`)
  })
  const hub = await app.firstWindow()
  await hub.evaluate(() => {
    window.__sshEvents = []
    window.dshHub.onInstanceStatus((event) => window.__sshEvents.push(event))
    // 首次连接时自动信任测试主机指纹。
    window.__fingerprints = []
    window.dshHub.ssh.onHostKeyDecision((payload) => {
      window.__fingerprints.push(payload)
      void window.dshHub.ssh.replyHostKey(payload.requestId, 'trust')
    })
    return true
  })

  // 通过 IPC 创建带 identityFile 的 SSH 实例。
  const created = await hub.evaluate(
    ([host, port, user, remotePort, identityFile]) =>
      window.dshHub.instances.create({
        transport: 'ssh',
        name: '验收 · SSH 隧道',
        host,
        port,
        username: user,
        remotePort,
        identityFile
      }),
    ['127.0.0.1', SSH_PORT, SSH_USER, HTTP_PORT, `${ACC}/client`]
  )
  if (!created.ok) throw new Error(`创建失败:${created.message}`)
  const instanceId = created.value.id
  console.log('[ok] ssh 实例已创建')

  const eventsLoader = () => hub.evaluate(() => window.__sshEvents || [])
  await hub.evaluate((id) => window.dshHub.runtime.start(id), instanceId)

  const running = await waitEvent(
    eventsLoader,
    (event) => event.status === 'running' && event.id === instanceId,
    20000,
    'ssh 隧道 running'
  )
  console.log(`[ok] 隧道 running:${running.url}(${running.detail})`)

  // 健康探测:穿过真实隧道打到测试 HTTP 服务器
  const body = await fetchThroughTunnel(running.port)
  if (body !== 'ssh-tunnel-ok') throw new Error(`隧道内 HTTP 响应异常:${body}`)
  console.log(`[ok] 经隧道 fetch 127.0.0.1:${running.port}/ → ${body}`)

  // 注册表回写:localPort 已持久化
  const record = await hub.evaluate((id) => window.dshHub.instances.get(id), instanceId)
  if (!record.ok || record.value.localPort !== running.port) {
    throw new Error(`localPort 未回写:${JSON.stringify(record)}`)
  }
  console.log(`[ok] localPort ${running.port} 已持久化到注册表`)

  // SSH 实例运行后必须能打开视图窗口。
  const openResult = await hub.evaluate((id) => window.dshHub.runtime.openView(id), instanceId)
  if (!openResult.ok) throw new Error(`ssh openView 失败:${JSON.stringify(openResult)}`)
  const deadlineWin = Date.now() + 10000
  let instanceWindowUrl = null
  while (Date.now() < deadlineWin) {
    instanceWindowUrl =
      app
        .windows()
        .map((win) => win.url())
        .find((url) => url.startsWith('http://127.0.0.1:')) ?? null
    if (instanceWindowUrl) break
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!instanceWindowUrl) throw new Error('ssh 实例窗口未打开')
  console.log(`[ok] ssh 实例视图窗口已打开:${instanceWindowUrl}`)

  // ControlPath socket 存在:数据目录过长时 socket 目录自适应退化到系统临时目录
  // (unix socket 名上限 104 字节,见 ssh-tunnel.ts socketsDirFor)
  const findSocket = () =>
    sh(`find /var/folders -maxdepth 5 -type s -name 'ctl-*' 2>/dev/null | head -1 || true`) ||
    sh(`find ${join(DATA_DIR, 'ssh')} -maxdepth 1 -type s 2>/dev/null | head -1 || true`)
  const sock = findSocket()
  if (!sock) throw new Error('ControlPath socket 未创建')
  console.log(`[ok] ControlPath socket 存在:${sock}`)

  // —— 看门狗:杀掉 ssh 客户端进程,验证自动重连 ——
  // 事件列表会累积历史事件,必须用游标只看「本次操作之后」产生的事件,
  // 否则旧的 running/error 会被 find 立刻命中,时序判定失效
  const cursorAfter = async (cursor) => (await eventsLoader()).slice(cursor)
  const tunnelPids = sh(`pgrep -f -- ':127.0.0.1:${HTTP_PORT}' || true`).split('\n').filter(Boolean)
  if (tunnelPids.length !== 1) throw new Error(`隧道进程数异常:${tunnelPids.length}`)
  const cursor = (await eventsLoader()).length
  execSync(`kill -9 ${tunnelPids[0]}`)
  console.log(`[watchdog] 已杀掉隧道进程 ${tunnelPids[0]}`)

  // 期望(只看新事件):error(归因)→ 退避 → 自动重连 → running
  const errorEvent = await waitEvent(
    () => cursorAfter(cursor),
    (event) => event.status === 'error',
    10000,
    '断线 error'
  )
  console.log(`[ok] 断线归因:${errorEvent.detail}`)
  await waitEvent(
    () => cursorAfter(cursor),
    (event) => event.status === 'running',
    25000,
    '自动重连 running'
  )
  console.log('[ok] 看门狗自动重连成功')
  const reconnectDetail = (await cursorAfter(cursor))
    .filter((event) => event.status === 'starting')
    .pop()?.detail
  console.log(`[watchdog] ${reconnectDetail}`)
  const body2 = await fetchThroughTunnel(
    (await cursorAfter(cursor)).filter((event) => event.status === 'running').pop().port
  )
  if (body2 !== 'ssh-tunnel-ok') throw new Error(`重连后隧道失效:${body2}`)
  console.log('[ok] 重连后隧道仍然连通')

  // —— 停止 → 隧道回收,ControlPath 清理 ——
  const stopCursor = (await eventsLoader()).length
  await hub.evaluate((id) => window.dshHub.runtime.stop(id), instanceId)
  await waitEvent(
    () => cursorAfter(stopCursor),
    (event) => event.status === 'stopped',
    10000,
    'stopped'
  )
  await new Promise((r) => setTimeout(r, 1000))
  const sockAfter = findSocket()
  if (sockAfter) throw new Error(`ControlPath socket 未被清理:${sockAfter}`)
  console.log(
    '[debug] 停止后残留:\n' + (sh(`pgrep -fl -- ':127.0.0.1:${HTTP_PORT}' || true`) || '(无)')
  )
  const leftover = sh(`pgrep -f -- ':127.0.0.1:${HTTP_PORT}' || true`)
  if (leftover) throw new Error(`停止后仍有隧道进程:${leftover}`)
  console.log('[ok] 停止后隧道进程与 ControlPath 均已回收')

  // —— 退出 → 无孤儿 ——
  await app.close()
  await new Promise((r) => setTimeout(r, 2000))
  const orphans = sh(`pgrep -fl -- ':127.0.0.1:${HTTP_PORT}' || true`)
  if (orphans) {
    console.error('[FAIL] 存在孤儿 ssh 隧道进程:\n' + orphans)
    process.exitCode = 1
  }
  console.log('[ok] 退出后无孤儿 ssh 进程')
  console.log('[DONE] 隧道启停、健康检查、自动重连和退出回收验证通过')
}

async function run() {
  await main()
}

run()
  .catch(async (error) => {
    console.error('[FAIL]', error)
    process.exitCode = 1
    const { writeFileSync } = require('node:fs')
    // 失败时 dump 事件便于归因
    if (app) {
      try {
        const hub = await app.firstWindow()
        const events = await hub.evaluate(() => window.__sshEvents || [])
        writeFileSync('/tmp/verify-ssh-events.json', JSON.stringify(events, null, 2))
      } catch {
        /* 进程可能已经退出 */
      }
    }
  })
  .finally(async () => {
    // 失败路径也必须收尾:关应用 + 回收 sshd / 测试服务器
    if (app) {
      try {
        await app.close()
      } catch {
        /* 已关闭 */
      }
    }
    try {
      sh(`pkill -f 'sshd.*dsh-ssh-accept' || true`)
    } catch {
      /* 无残留 */
    }
    if (httpServer) httpServer.close()
    if (sshdProc) {
      try {
        process.kill(-sshdProc.pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
  })
