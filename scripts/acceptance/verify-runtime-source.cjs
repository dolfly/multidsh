/* 运行时获取策略验证：hub 同版本 → PATH → 下载需确认。
   场景(对应当前实现的三级优先):
   A. PATH 上有 dsh(本脚本前置检查)→ 未固定实例启动 → 不走安装、
      事件 runtimeSource='path'、实例 dshVersion 保持 null(未固定不被钉死);
   B. 下载确认口:清理 PATH 假象不可行(沙箱内),改验证「确认口缺省=拒绝」语义
      由单测锁定,本脚本只做 A 的端到端取证 + 产物日志。
   用法:cd <repo> && node ./scripts/acceptance/verify-runtime-source.cjs
   前置:pnpm build;PATH 上有 dsh(脚本自检,没有则提示并以 0 退出说明「无 PATH 可验」) */
const { _electron: electron } = require('@playwright/test')
const { mkdir, rm, readFile } = require('node:fs/promises')
const { resolve } = require('node:path')
const { execFileSync } = require('node:child_process')

const DATA_DIR = resolve(process.cwd(), 'hub-data', 'verify-runtime-source')

function sh(cmd) {
  return execFileSync(cmd, { shell: true, encoding: 'utf8' }).trim()
}

let app = null

function log(tag, ok, detail = '') {
  const mark = ok === null ? '·' : ok ? '✅' : '❌'
  if (ok === false) process.exitCode = 1
  console.log(`${mark} [${tag}] ${detail}`)
}

async function main() {
  const which = (() => {
    try {
      return sh('which dsh')
    } catch {
      return ''
    }
  })()
  const pathVersion = which ? sh('dsh --version') : ''
  if (!which) {
    log('PATH-dsh', null, 'PATH 上没有 dsh —— 本脚本的 A 场景无从验证,跳过(非失败)')
    process.exit(0)
  }
  log('前置', true, `PATH dsh = ${which} (version ${pathVersion})`)

  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })

  const launchArgs = [process.cwd()]
  if (process.env.CI) launchArgs.push('--no-sandbox')
  app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('[data-testid="app-shell"]')

  // 订阅状态事件(经 store 的 onInstanceStatus 桥接转发的实例事件在页面上以 toast 出现,
  // 这里直接经 IPC 订阅:用 evaluate 挂 listener 到 bridge 的事件通道)
  await win.evaluate(() => {
    // 渲染层桥接的 onInstanceStatus 是主进程事件转发;此处通过 window 上的计数器观察
    window.__verifyEvents = []
    window.dshHub.onInstanceStatus((event) => window.__verifyEvents.push(event))
  })

  // A:创建一个未固定的本地实例(不带端口/版本)并启动
  const created = await win.evaluate(async () => {
    return window.dshHub.instances.create({
      transport: 'local',
      name: 'verify-path-source',
      authMode: 'auto'
    })
  })
  if (!created.ok) throw new Error(`创建失败: ${created.message}`)
  const id = created.value.id

  await win.evaluate(async (instanceId) => {
    window.dshHub.runtime.start(instanceId)
  }, id)

  // 等待 running(PATH 上的 dsh 启动通常 < 5s,给 30s 余量)
  const started = Date.now()
  let runningEvent = null
  while (Date.now() - started < 30_000) {
    const eventsNow = await win.evaluate(() => window.__verifyEvents)
    runningEvent = eventsNow.find((e) => e.status === 'running' && e.id === id)
    if (runningEvent) break
    if (eventsNow.some((e) => e.status === 'error' && e.id === id)) {
      const err = eventsNow.find((e) => e.status === 'error' && e.id === id)
      throw new Error(`启动失败: ${err.detail}`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  log(
    'A.running',
    !!runningEvent,
    runningEvent ? `启动成功(${Math.round((Date.now() - started) / 1000)}s)` : '30s 内未到 running'
  )

  // 校验 1:runtimeSource === 'path'(用本机 dsh,不是下载)
  log(
    'A.runtimeSource',
    runningEvent?.runtimeSource === 'path',
    `runtimeSource=${runningEvent?.runtimeSource ?? '(缺失)'}`
  )

  // 校验 2:版本与 PATH dsh 一致
  log(
    'A.version',
    runningEvent?.version === pathVersion,
    `事件 version=${runningEvent?.version} / PATH ${pathVersion}`
  )

  // 校验 3:注册表里 dshVersion 仍为 null(path 来源不回写,未固定跟随用户升级)
  const registry = JSON.parse(
    await readFile(resolve(DATA_DIR, 'registry', 'instances.json'), 'utf8')
  )
  const record = registry.instances.find((i) => i.id === id)
  log(
    'A.no-persist',
    record?.dshVersion == null,
    `落盘 dshVersion=${JSON.stringify(record?.dshVersion)}`
  )

  // 校验 4:没有往 hub 隔离目录安装任何运行时(runtimes/ 为空或不存在)
  let runtimesEntries
  try {
    const { readdir } = require('node:fs/promises')
    runtimesEntries = await readdir(resolve(DATA_DIR, 'runtimes'))
  } catch {
    runtimesEntries = []
  }
  log(
    'A.no-install',
    runtimesEntries.length === 0,
    `runtimes/ 条目=[${runtimesEntries.join(', ')}]`
  )

  await win.evaluate(async (instanceId) => {
    window.dshHub.runtime.stop(instanceId)
  }, id)
  await new Promise((r) => setTimeout(r, 1500))

  const failed = process.exitCode != null && process.exitCode !== 0
  console.log(
    failed ? '\n❌ verify-runtime-source 存在失败项' : '\n✅ verify-runtime-source 全部通过'
  )
}

main()
  .catch((error) => {
    console.error('❌ verify-runtime-source 异常:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (app) await app.close().catch(() => {})
  })
