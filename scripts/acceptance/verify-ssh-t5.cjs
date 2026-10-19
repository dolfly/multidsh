/* SSH 指纹与口令验证：首次指纹确认 → askpass 口令弹窗（带口令的私钥）→ 隧道连通 →
   指纹变化后拒绝连接；同时检查口令不落盘和密钥预览元信息。
   用法：cd <repo> && node ./scripts/acceptance/verify-ssh-t5.cjs（需要可启动 sshd 的环境） */
const { _electron: electron } = require('@playwright/test')
const { mkdir, rm, writeFile, readFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { execSync, spawn } = require('node:child_process')
const { userInfo } = require('node:os')
const http = require('node:http')

const ACC = '/tmp/dsh-ssh-t5'
const DATA_DIR = resolve(process.cwd(), 'hub-data', 'verify-ssh-t5')
const SSH_PORT = 32223
const HTTP_PORT = 33081
const PASSPHRASE = 't5-transient-passphrase'
/** sshd 配置需要本机已存在的账号:取自系统,不写死任何用户名 */
const SSH_USER = process.env.USER || userInfo().username
let app = null
let sshdProc = null
let httpServer = null

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim()
}

async function writeSshdConfig() {
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
}

async function startSshd() {
  sshdProc = spawn('/usr/sbin/sshd', ['-f', join(ACC, 'sshd_config')], {
    detached: true,
    stdio: 'ignore'
  })
  sshdProc.unref()
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      sh(`nc -z -w1 127.0.0.1 ${SSH_PORT}`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  throw new Error('sshd 未就绪')
}

async function stopSshd() {
  try {
    sh(`pkill -f 'sshd.*${ACC}' || true`)
  } catch {
    /* 无进程 */
  }
  await new Promise((r) => setTimeout(r, 500))
}

async function setupSshd({ withPassphraseKey }) {
  await mkdir(join(ACC, 'authkeys'), { recursive: true })
  sh(`ssh-keygen -t ed25519 -f ${ACC}/hostkey -N '' -q`)
  // 客户端私钥:带口令 → 触发 askpass
  const pass = withPassphraseKey ? PASSPHRASE : ''
  sh(`ssh-keygen -t ed25519 -f ${ACC}/client -N '${pass}' -q`)
  await writeFile(join(ACC, 'authkeys', 'authorized_keys'), await readFile(`${ACC}/client.pub`))
  await writeSshdConfig()
  await startSshd()
}

async function waitFor(loader, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await loader()
    const hit = predicate(value)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`等待超时:${label}`)
}

async function main() {
  try {
    sh(`pkill -f 'dsh-hub-ssh-' || true`)
    sh(`pkill -f 'sshd.*${ACC}' || true`)
  } catch {
    /* 无残留 */
  }
  await new Promise((r) => setTimeout(r, 800))
  await rm(ACC, { recursive: true, force: true })
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })

  await setupSshd({ withPassphraseKey: true })
  console.log(`[ok] sshd 就绪 127.0.0.1:${SSH_PORT}（私钥带口令,将触发 askpass）`)

  httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('t5-tunnel-ok')
  })
  httpServer.listen(HTTP_PORT, '127.0.0.1')

  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  app.process().stderr.on('data', (chunk) => {
    const text = String(chunk)
    if (/ssh-tunnel|askpass|指纹|失败|error/i.test(text)) process.stderr.write(`[main] ${text}`)
  })
  const hub = await app.firstWindow()
  await hub.evaluate(() => {
    window.__t5 = { hostKey: [], askpass: [], statuses: [] }
    window.dshHub.onInstanceStatus((event) => window.__t5.statuses.push(event))
    window.dshHub.ssh.onHostKeyDecision((payload) => window.__t5.hostKey.push(payload))
    window.dshHub.ssh.onAskpassRequest((payload) => window.__t5.askpass.push(payload))
    return true
  })

  // —— 密钥预览(只读元信息) ——
  const preview = await hub.evaluate(
    ([host, port, user, identityFile]) =>
      window.dshHub.ssh.keyPreview({ host, port, username: user, identityFile }),
    ['127.0.0.1', SSH_PORT, SSH_USER, `${ACC}/client`]
  )
  if (!preview.ok) throw new Error(`keyPreview 失败:${preview.message}`)
  if (!preview.value.identityFiles.includes(`${ACC}/client`)) {
    throw new Error(`keyPreview 未包含显式私钥:${JSON.stringify(preview.value.identityFiles)}`)
  }
  if (
    JSON.stringify(preview.value).includes('PRIVATE KEY') ||
    preview.value.agent.keys.some((key) => 'privateKey' in key)
  ) {
    throw new Error('密钥预览泄露了私钥字段')
  }
  console.log(
    `[ok] 密钥预览:identityFiles=${preview.value.identityFiles.length} 条,agent=${preview.value.agent.status}`
  )

  // —— 创建实例并启动:应先弹指纹确认,再弹口令 ——
  const created = await hub.evaluate(
    ([host, port, user, remotePort, identityFile]) =>
      window.dshHub.instances.create({
        transport: 'ssh',
        name: '验证 · SSH',
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

  const loadT5 = () => hub.evaluate(() => window.__t5)
  await hub.evaluate((id) => window.dshHub.runtime.start(id), instanceId)

  // 1) TOFU 首次确认(verdict=unknown)
  const hostKeyPrompt = await waitFor(
    async () => (await loadT5()).hostKey[0] ?? null,
    (value) => value,
    20000,
    '指纹确认弹窗'
  )
  if (hostKeyPrompt.verdict !== 'unknown') {
    throw new Error(`首次确认 verdict 应为 unknown:${hostKeyPrompt.verdict}`)
  }
  if (!hostKeyPrompt.fingerprints[0]?.fingerprint?.startsWith('SHA256:')) {
    throw new Error('指纹格式异常')
  }
  console.log(
    `[ok] 首次指纹确认弹窗:${hostKeyPrompt.target} ${hostKeyPrompt.fingerprints[0].fingerprint}`
  )
  await hub.evaluate(
    (requestId) => window.dshHub.ssh.replyHostKey(requestId, 'trust'),
    hostKeyPrompt.requestId
  )

  // 2) askpass 口令弹窗
  const askpassPrompt = await waitFor(
    async () => (await loadT5()).askpass[0] ?? null,
    (value) => value,
    20000,
    'askpass 口令弹窗'
  )
  if (!/passphrase|password/i.test(askpassPrompt.prompt)) {
    throw new Error(`askpass 提示语异常:${askpassPrompt.prompt}`)
  }
  console.log(`[ok] askpass 弹窗提示语:${askpassPrompt.prompt}`)
  await hub.evaluate(
    ([requestId, secret]) => window.dshHub.ssh.replyAskpass(requestId, secret),
    [askpassPrompt.requestId, PASSPHRASE]
  )

  // 3) 隧道就绪 + 穿透验证
  const running = await waitFor(
    async () =>
      (await loadT5()).statuses
        .filter((e) => e.status === 'running' && e.id === instanceId)
        .pop() ?? null,
    (value) => value,
    20000,
    'running'
  )
  const body = await (async () => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${running.port}/`)
        if (res.status === 200) return await res.text()
      } catch {
        /* 重试 */
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    return null
  })()
  if (body !== 't5-tunnel-ok') throw new Error(`隧道穿透失败:${body}`)
  console.log(`[ok] 指纹确认 + 口令输入后隧道连通(127.0.0.1:${running.port})`)

  // 4) 口令不落盘:数据目录内任何文件都不得包含口令明文
  const found = sh(`grep -rl '${PASSPHRASE}' ${DATA_DIR} 2>/dev/null || true`)
  if (found) throw new Error(`口令疑似落盘:${found}`)
  const registry = await readFile(join(DATA_DIR, 'registry', 'instances.json'), 'utf8')
  if (registry.includes(PASSPHRASE)) throw new Error('注册表包含口令')
  console.log('[ok] 口令未落盘(数据目录全量 grep 无命中)')

  // 5) 停止,轮换 sshd 主机密钥 → 再次启动应出「指纹已变化」并拒绝
  await hub.evaluate((id) => window.dshHub.runtime.stop(id), instanceId)
  await waitFor(
    async () =>
      (await loadT5()).statuses
        .filter((e) => e.status === 'stopped' && e.id === instanceId)
        .pop() ?? null,
    (value) => value,
    10000,
    'stopped'
  )
  await stopSshd()
  await rm(`${ACC}/hostkey`, { force: true })
  await rm(`${ACC}/hostkey.pub`, { force: true })
  sh(`ssh-keygen -t ed25519 -f ${ACC}/hostkey -N '' -q`) // 轮换主机密钥
  await startSshd()
  console.log('[fixture] sshd 主机密钥已轮换')

  const cursor = (await loadT5()).hostKey.length
  await hub.evaluate((id) => window.dshHub.runtime.start(id), instanceId)
  const changedPrompt = await waitFor(
    async () => (await loadT5()).hostKey[cursor] ?? null,
    (value) => value,
    20000,
    '指纹变化弹窗'
  )
  if (changedPrompt.verdict !== 'changed') {
    throw new Error(`轮换后 verdict 应为 changed:${changedPrompt.verdict}`)
  }
  console.log(
    `[ok] 指纹变化弹窗(红色警示变体):旧=${changedPrompt.previousFingerprints[0]?.fingerprint} 新=${changedPrompt.fingerprints[0]?.fingerprint}`
  )
  await hub.evaluate(
    (requestId) => window.dshHub.ssh.replyHostKey(requestId, 'reject'),
    changedPrompt.requestId
  )
  const refused = await waitFor(
    async () =>
      (await loadT5()).statuses.filter((e) => e.status === 'error' && e.id === instanceId).pop() ??
      null,
    (value) => value,
    10000,
    '拒绝连接 error'
  )
  if (!refused.detail.includes('指纹')) throw new Error(`拒绝原因异常:${refused.detail}`)
  console.log(`[ok] 指纹变化被拒绝:${refused.detail}`)

  // 6) 不残留
  await app.close()
  await new Promise((r) => setTimeout(r, 1500))
  const orphans = sh(`pgrep -fl -- ':127.0.0.1:${HTTP_PORT}' || true`)
  if (orphans) throw new Error(`退出后仍有隧道进程:${orphans}`)
  console.log('[ok] 退出后无孤儿 ssh 进程')
  console.log('[DONE] 指纹确认、口令输入、指纹变更拒绝、口令不落盘和密钥预览验证通过')
}

async function run() {
  await main()
}

run()
  .catch(async (error) => {
    console.error('[FAIL]', error)
    if (app) {
      try {
        const hub = await app.firstWindow()
        const t5 = await hub.evaluate(() => window.__t5 || null)
        require('node:fs').writeFileSync(
          '/tmp/verify-ssh-t5-events.json',
          JSON.stringify(t5, null, 2)
        )
        console.error('[dump] /tmp/verify-ssh-t5-events.json')
      } catch {
        /* 忽略 */
      }
    }
    process.exitCode = 1
  })
  .finally(async () => {
    if (app) {
      try {
        await app.close()
      } catch {
        /* 已关闭 */
      }
    }
    try {
      sh(`pkill -f 'sshd.*${ACC}' || true`)
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
