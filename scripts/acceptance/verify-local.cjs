/* 双实例验证：安装、启动、健康检查和自动开窗各执行两次，退出后不留孤儿进程。
   用法：cd <repo> && node ./hub-data-verify.cjs */
const { _electron: electron } = require('@playwright/test')
const { mkdir, rm } = require('node:fs/promises')

const { join, resolve } = require('node:path')
const { execSync } = require('node:child_process')

const DATA_DIR = resolve(process.cwd(), 'hub-data', 'verify-real')
const NAMES = ['验证 · 主力', '验证 · 备用']
let app = null

async function main() {
  // 清掉上次失败运行的残留(只匹配本验证专属数据目录路径,不误伤用户实例)
  try {
    execSync("pkill -f 'verify-real' || true")
  } catch {
    /* 无残留 */
  }
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 1500))

  // KEEP_DATA=1 时保留已预热的 runtimes/npm-cache(网络慢时先预热安装,再验证启动链路)
  if (process.env.KEEP_DATA === '1') {
    await rm(join(DATA_DIR, 'registry'), { recursive: true, force: true })
  } else {
    await rm(DATA_DIR, { recursive: true, force: true })
  }
  await mkdir(DATA_DIR, { recursive: true })
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  // 转发主进程日志:实例启动失败时能看到归因(dsh stderr / 安装错误)
  app.process().stderr.on('data', (chunk) => {
    const text = String(chunk)
    if (/registry|local-runtime|启动|安装|失败|error/i.test(text))
      process.stderr.write(`[main] ${text}`)
  })
  const hub = await app.firstWindow()
  // 捕获全部状态事件(含 detail),失败时可 dump 归因
  await hub.evaluate(() => {
    window.__hubEvents = []
    window.dshHub.onInstanceStatus((event) => window.__hubEvents.push(event))
    return true
  })

  async function createInstance(name) {
    const isEmpty = await hub
      .getByTestId('view-empty')
      .isVisible()
      .catch(() => false)
    if (isEmpty) await hub.getByTestId('empty-new-btn').click()
    else await hub.getByTestId('new-instance-btn').click()
    await hub.getByRole('button', { name: '下一步' }).click()
    await hub.getByTestId('wizard-name').fill(name)
    await hub.getByRole('button', { name: '下一步' }).click()
    await hub.getByTestId('wizard-create').click()
    await hub.getByTestId('wizard').waitFor({ state: 'hidden' })
    console.log(`[wizard] ${name} 已创建`)
  }

  await hub.getByTestId('view-empty').waitFor({ timeout: 15000 })
  for (const name of NAMES) await createInstance(name)

  const deadline = Date.now() + 8 * 60 * 1000
  const instanceWindows = new Set()
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      const url = win.url()
      if (url.startsWith('http://127.0.0.1:')) instanceWindows.add(url)
    }
    if (instanceWindows.size >= 2) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (instanceWindows.size < 2) {
    const events = await hub.evaluate(() => window.__hubEvents || [])
    const { writeFileSync } = require('node:fs')
    writeFileSync('/tmp/verify-events.json', JSON.stringify(events, null, 2))
    // 只打印终态事件(过滤 starting 噪音),完整 JSON 已落盘 /tmp/verify-events.json
    const terminal = events.filter((event) => event.status !== 'starting')
    console.error('[dump] 终态事件:\n' + JSON.stringify(terminal, null, 2))
    throw new Error(`只等到 ${instanceWindows.size} 个实例窗口`)
  }
  console.log(`[ok] 双实例窗口打开: ${[...instanceWindows].join(' , ')}`)

  // 状态推进到「已连接」且两个真实 dsh 进程并存
  await new Promise((r) => setTimeout(r, 3000))
  const runningProcs = execSync("pgrep -f 'bin.js --profile web' | wc -l").toString().trim()
  if (Number(runningProcs) < 2) throw new Error(`dsh 进程数 ${runningProcs} < 2`)
  console.log(`[ok] ${runningProcs} 个 dsh 进程并存(双实例并跑)`)

  const text = await hub.evaluate(() => document.body.innerText)
  console.log(text.includes('已连接') ? '[ok] 表格显示「已连接」' : '[warn] 表格未见「已连接」')

  await app.close()
  await new Promise((r) => setTimeout(r, 3000))
  const orphans = execSync("pgrep -fl 'bin.js --profile web' || true").toString().trim()
  if (orphans) {
    console.error('[FAIL] 存在孤儿 dsh 进程:\n' + orphans)
    process.exit(1)
  }
  console.log('[ok] 退出后无孤儿 dsh 进程')
  console.log('[DONE] 双实例验证通过')
}

async function run() {
  await main()
}

run()
  .catch((error) => {
    console.error('[FAIL]', error)
    process.exit(1)
  })
  .finally(async () => {
    // 失败路径也必须收尾:关应用(触发 stopAll),避免残留进程占端口
    if (app) {
      try {
        await app.close()
      } catch {
        /* 已关闭 */
      }
    }
  })
