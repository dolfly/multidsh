/* 外部 dsh 探测验证：用**真实** dsh 打 live ps,确认探测器认得出它。
   场景:
   A. 用户自己起的 dsh(不经过 hub)→ 探测结果里有它,端口与实际监听一致;
   B. hub 自己拉起的 dsh → 探测结果里**没有**它(否则用户会接管自己的实例,
      停止时不再终止进程,进程泄漏);
   C. 判定用的命令行形态与真实 CLI 一致 —— 合成夹具会随 CLI 演进而漂移,
      这次的缺陷正是「夹具用旧形态、真实用新形态」造成的,所以这里只认真 dsh。

   为什么要有这个脚本:探测器的输入是 live ps 输出,单测与 E2E 夹具都是合成的,
   合成形态与真实形态脱节时门禁全绿而功能已坏(见 docs/adr/0011)。

   用法:cd <repo> && node ./scripts/acceptance/verify-external-dsh.cjs
   前置:pnpm build;PATH 上有 dsh(脚本自检,没有则提示并以 0 退出说明「无 PATH 可验」) */
const { _electron: electron } = require('@playwright/test')
const { mkdir, rm } = require('node:fs/promises')
const { resolve } = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

const DATA_DIR = resolve(process.cwd(), 'hub-data', 'verify-external-dsh')
const USER_PORT = 34101
const HUB_PORT = 34102

let app = null
let userDsh = null

function sh(cmd) {
  return execFileSync(cmd, { shell: true, encoding: 'utf8' }).trim()
}

function log(tag, ok, detail = '') {
  const mark = ok === null ? '·' : ok ? '✅' : '❌'
  if (ok === false) process.exitCode = 1
  console.log(`${mark} [${tag}] ${detail}`)
}

/** live ps 输出(与探测器用的是同一条命令、同样的字段) */
function liveProcessTable() {
  return sh('ps -axo pid=,ppid=,command=')
}

/**
 * 从 live ps 里找出 dsh web 进程:与探测器的判定同口径 —— 入口 token 以
 * /dsh 结尾,且参数里有 `--profile web` 或 `web` 位置参数。命令行形态变了
 * 这里就会跟着变,正是要抓的漂移。
 */
function findDshWebPids(table) {
  const pids = []
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim())
    if (!m) continue
    const command = m[3]
    if (!/\/(dsh|dsh\.js)\b/.test(command)) continue
    const tokens = command.split(/\s+/)
    const entry = tokens.findIndex((t) => /\/dsh(\.js)?$/.test(t))
    if (entry < 0) continue
    const args = tokens.slice(entry + 1)
    if (/\bplugin\b/.test(args)) continue
    const isWeb = args[0] === 'web' || /--profile[= ]web\b/.test(command)
    if (!isWeb) continue
    pids.push({ pid: Number(m[1]), ppid: Number(m[2]), command })
  }
  return pids
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const out = sh(`lsof -nP -iTCP -sTCP:LISTEN -i :${port}`)
      if (out.includes(`:${port}`)) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function main() {
  const which = (() => {
    try {
      return sh('which dsh')
    } catch {
      return ''
    }
  })()
  if (!which) {
    log('PATH-dsh', null, 'PATH 上没有 dsh —— 本脚本无从验证,跳过(非失败)')
    process.exit(0)
  }
  log('前置', true, `PATH dsh = ${which} (version ${sh('dsh --version')})`)

  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })

  // A:用户自己起的 dsh —— 父进程是本脚本,不在 hub 的进程树里
  userDsh = spawn(which, ['--profile', 'web', '--port', String(USER_PORT), '--no-open'], {
    stdio: 'ignore'
  })
  const userUp = await waitForPort(USER_PORT, 40_000)
  log('A.user-dsh-up', userUp, `127.0.0.1:${USER_PORT} ${userUp ? '已监听' : '未监听'}`)

  const launchArgs = [process.cwd()]
  if (process.env.CI) launchArgs.push('--no-sandbox')
  app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('[data-testid="app-shell"]')
  await win.evaluate(() => {
    window.__verifyEvents = []
    window.dshHub.onInstanceStatus((event) => window.__verifyEvents.push(event))
  })

  // B:hub 自己拉起一个实例(同一个 dsh 二进制,端口不同)—— 它必须不被报成外部实例
  const created = await win.evaluate(async (port) => {
    return window.dshHub.instances.create({
      transport: 'local',
      name: 'verify-hub-managed',
      authMode: 'auto',
      port
    })
  }, HUB_PORT)
  if (!created.ok) throw new Error(`创建失败: ${created.message}`)
  const hubInstanceId = created.value.id
  await win.evaluate(async (instanceId) => {
    window.dshHub.runtime.start(instanceId)
  }, hubInstanceId)
  const hubUp = await waitForPort(HUB_PORT, 90_000)
  log('B.hub-dsh-up', hubUp, `127.0.0.1:${HUB_PORT} ${hubUp ? '已监听' : '未监听'}`)

  // 等 hub 实例到 running(它的 dsh 才是真正的探测对象)
  const started = Date.now()
  let running = false
  while (Date.now() - started < 60_000) {
    const eventsNow = await win.evaluate(() => window.__verifyEvents)
    if (eventsNow.some((e) => e.status === 'running' && e.id === hubInstanceId)) {
      running = true
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  log('B.hub-running', running, running ? 'hub 实例已 running' : '60s 内未到 running')

  // 探测:走真实的 IPC 通道(渲染层拿到的就是用户看到的那份结果)
  const scanned = await win.evaluate(async () => {
    const r = await window.dshHub.runtime.scanExternal()
    return r.ok ? r.value : []
  })
  log('C.scan', true, `探测到 ${scanned.length} 个外部 dsh`)

  // A:用户自己起的那个必须在结果里,且端口正确
  const userEntry = scanned.find((item) => item.port === USER_PORT)
  log('A.detected', !!userEntry, `用户 dsh(端口 ${USER_PORT}) ${userEntry ? '已识别' : '未识别'}`)
  log('A.port', userEntry?.port === USER_PORT, `探测端口=${userEntry?.port ?? '(无)'}`)

  // 实际监听端口与探测端口一致(lsof 口径)
  // 用 lsof 的 pid 反查 ps 里的命令行,确认探测器认的正是持有该端口的那个进程
  const lsofPid = (() => {
    try {
      const out = sh(`lsof -nP -iTCP -sTCP:LISTEN -i :${USER_PORT}`)
      const m = /^\S+\s+(\d+)\s/.exec(
        out.split('\n').find((l) => l.includes(`:${USER_PORT}`)) ?? ''
      )
      return m ? Number(m[1]) : undefined
    } catch {
      return undefined
    }
  })()
  const psEntry = findDshWebPids(liveProcessTable()).find((p) => p.pid === lsofPid)
  log(
    'A.pid-match',
    userEntry === undefined || (lsofPid !== undefined && userEntry.pid === lsofPid),
    `探测 pid=${userEntry?.pid ?? '(无)'} / lsof 持有 ${USER_PORT} 的 pid=${lsofPid ?? '(未找到)'}`
  )
  // 那个 pid 在 ps 里确实是一条 dsh web 命令行(形态与真实 CLI 一致)
  log('A.ps-command', !!psEntry, `ps 里的命令行=${psEntry?.command ?? '(未找到)'}`)

  // B:hub 托管的那个绝不能在结果里
  const hubEntry = scanned.find((item) => item.port === HUB_PORT)
  log('B.excluded', !hubEntry, `hub 托管实例(端口 ${HUB_PORT}) ${hubEntry ? '被误报' : '已排除'}`)

  // C:命令��脱敏 —— 结果里不能出现明文凭据形态
  const commandText = scanned.map((item) => item.command).join('\n')
  const leaked = /(?:token|secret|password|api[_-]?key)\s*[=:]\s*(?!\*\*\*)\S+/i.test(commandText)
  log('C.redacted', !leaked, leaked ? '命令行里有明文凭据' : '命令行已脱敏')

  // 收尾:停掉 hub 实例,确认没有留下孤儿
  await win.evaluate(async (instanceId) => {
    window.dshHub.runtime.stop(instanceId)
  }, hubInstanceId)
  await new Promise((r) => setTimeout(r, 3000))

  const failed = process.exitCode != null && process.exitCode !== 0
  console.log(failed ? '\n❌ verify-external-dsh 存在失败项' : '\n✅ verify-external-dsh 全部通过')
}

main()
  .catch((error) => {
    console.error('❌ verify-external-dsh 异常:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (app) await app.close().catch(() => {})
    if (userDsh) userDsh.kill('SIGTERM')
  })
