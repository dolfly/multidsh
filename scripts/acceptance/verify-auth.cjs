/* 认证流程验证：真实网关 + 真实应用 —— 登录 → 分区 Cookie 注入 → 视图直接进入受保护页（不经 /login）
   → 会话失效后拦截层触发重登信号。
   用法:cd <repo> && node ./scripts/acceptance/verify-auth.cjs(需 pnpm build) */
const { _electron: electron } = require('@playwright/test')
const { mkdir, rm } = require('node:fs/promises')
const { resolve } = require('node:path')

const DATA_DIR = resolve(process.cwd(), 'hub-data', 'verify-auth')
const PASSWORD = 'accept-pass-123!'
let app = null
let fixture = null

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
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })

  // 真实网关(源码 LoginGateway + 假 upstream)+ 固定密码
  const { startGatewayFixture } = await import('../gateway-fixture.mjs')
  fixture = await startGatewayFixture({ password: PASSWORD })
  console.log(`[ok] 真实网关已启动:${fixture.baseUrl}`)

  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  const hub = await app.firstWindow()
  await hub.evaluate(() => {
    window.__authEvents = []
    window.__authSignals = []
    window.dshHub.auth.onState((e) => window.__authEvents.push(e))
    window.dshHub.auth.onSignal((e) => window.__authSignals.push(e))
    return true
  })

  // 1) 建 http 实例(指向网关)→ start(探测为 gateway)→ running
  const created = await hub.evaluate(
    (url) =>
      window.dshHub.instances.create({
        transport: 'http',
        name: '验证 · 网关登录',
        endpointUrl: url
      }),
    fixture.baseUrl
  )
  if (!created.ok) throw new Error(`创建失败:${created.message}`)
  const id = created.value.id
  await hub.evaluate((instanceId) => window.dshHub.runtime.start(instanceId), id)
  const load = () => hub.evaluate(() => window.__authEvents)

  // 2) 探针 → await-credentials;密码登录 → connected
  const probe = await hub.evaluate((instanceId) => window.dshHub.auth.probe(instanceId), id)
  if (!probe.ok) throw new Error(`probe 失败:${probe.message}`)
  if (probe.value?.phase !== 'await-credentials') {
    throw new Error(`probe 阶段异常:${JSON.stringify(probe.value)}`)
  }
  console.log(`[ok] 探测结论:${probe.value.phase}`)

  const login = await hub.evaluate(
    ([instanceId, password]) => window.dshHub.auth.login(instanceId, password),
    [id, PASSWORD]
  )
  if (!login.ok || login.value?.phase !== 'connected') {
    throw new Error(`登录失败:${JSON.stringify(login)}`)
  }
  console.log('[ok] 密码登录成功 → connected')

  const stateEvent = await waitFor(
    load,
    (events) => events.find((e) => e.instanceId === id && e.state.phase === 'connected') ?? null,
    8000,
    'auth:state connected 广播'
  )
  console.log(`[ok] auth:state 广播:${stateEvent.state.phase}`)

  // 3) openView → 分区 Cookie 注入 → 视图应直达受保护页(不落在 /login)
  const openResult = await hub.evaluate(
    (instanceId) => window.dshHub.runtime.openView(instanceId),
    id
  )
  if (!openResult.ok) throw new Error(`openView 失败:${JSON.stringify(openResult)}`)
  const viewUrl = await waitFor(
    async () => {
      const urls = app.windows().map((w) => w.url())
      return urls.find((u) => u.startsWith(fixture.baseUrl)) ?? null
    },
    (v) => v,
    15000,
    '实例视图窗口'
  )
  if (viewUrl.includes('/login')) {
    throw new Error(`分区 Cookie 未注入:视图落在登录页 ${viewUrl}`)
  }
  console.log(`[ok] 分区 Cookie 注入生效:视图直达受保护页 ${viewUrl}`)

  // 4) 会话失效 → 拦截层触发重登信号(清 Cookie 后刷新)
  await hub.evaluate((instanceId) => window.dshHub.auth.logout(instanceId), id)
  await new Promise((r) => setTimeout(r, 500))
  const instanceWin = app.windows().find((w) => w.url().startsWith(fixture.baseUrl))
  if (instanceWin) await instanceWin.reload()
  const signal = await waitFor(
    async () => (await hub.evaluate(() => window.__authSignals))[0] ?? null,
    (v) => v,
    15000,
    'auth:signal 会话失效'
  )
  console.log(`[ok] 拦截层信号:${signal.signal}`)

  await app.close()
  console.log('[DONE] 登录、Cookie 注入、受保护页访问和重登信号验证通过')
}

run()
  .catch((error) => {
    console.error('[FAIL]', error)
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
    if (fixture) await fixture.stop().catch(() => undefined)
  })

async function run() {
  await main()
}
