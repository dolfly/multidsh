/**
 * Starts a local dsh-auth-gateway instance with a local upstream server.
 * Used by pnpm test:contract.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_SRC = process.env.DSH_AUTH_GATEWAY_SRC?.trim() || null

function configuredGatewaySource(src) {
  if (src) return src
  throw new Error(
    '缺少 DSH_AUTH_GATEWAY_SRC：请将其设置为本地 dsh-auth-gateway 源码目录后再运行 pnpm test:contract'
  )
}

async function loadGatewayModule(src) {
  const root = resolve(configuredGatewaySource(src))
  const [gateway, store, otpStore, totp] = await Promise.all([
    import(pathToFileURL(join(root, 'lib', 'gateway.js')).href),
    import(pathToFileURL(join(root, 'lib', 'store.js')).href),
    import(pathToFileURL(join(root, 'lib', 'otp-store.js')).href),
    import(pathToFileURL(join(root, 'lib', 'totp.js')).href)
  ])
  return {
    LoginGateway: gateway.LoginGateway,
    ...store,
    enableOTP: otpStore.enableOTP,
    getOTPSecret: otpStore.getOTPSecret,
    generateSecret: totp.generateSecret,
    generateTOTP: totp.generateTOTP
  }
}

/** 假 upstream:模拟被网关保护的 dsh 端点 */
function startUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, echo: req.url }))
  })
  return new Promise((resolvePort) => {
    server.listen(0, '127.0.0.1', () => resolvePort({ server, port: server.address().port }))
  })
}

export async function startGatewayFixture(options = {}) {
  const {
    password = 'contract-pass-123!',
    otpRequired = false,
    otpEnabled = false,
    basePath = '/',
    lockMinutes = 5,
    maxLoginFailures = 5,
    minPasswordLength = 8,
    gatewaySrc = DEFAULT_SRC
  } = options

  const { LoginGateway, setPassword, enableOTP, getOTPSecret, generateSecret, generateTOTP } =
    await loadGatewayModule(gatewaySrc)
  const home = mkdtempSync(join(tmpdir(), 'dsh-hub-contract-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  // 固定 master key:OTP 相关路径需要稳定密钥(设计要求)
  if (!process.env.DSH_AUTH_GATEWAY_MASTER_KEY) {
    process.env.DSH_AUTH_GATEWAY_MASTER_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  }

  await setPassword(password, {
    minLength: minPasswordLength,
    requireMixedCase: false,
    requireSpecial: false
  })

  // 可选:真正绑定一个 TOTP 密钥(否则网关的 #otpActive() 为 false,otpRequired 不生效)
  if (otpEnabled || otpRequired) {
    await enableOTP({ secret: generateSecret(20) })
  }

  const upstream = await startUpstream()
  const gateway = new LoginGateway({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstream.port,
    basePath,
    policy: {
      minPasswordLength,
      requireMixedCase: false,
      requireSpecial: false,
      maxLoginFailures,
      lockMinutes
    },
    otp: { otpEnabled, otpRequired }
  })
  await gateway.start()
  const port = gateway.address().port
  const base = basePath === '/' ? '' : basePath.replace(/\/+$/, '')

  const otpSecret = otpEnabled || otpRequired ? getOTPSecret() : null

  return {
    baseUrl: `http://127.0.0.1:${port}${base}`,
    password,
    home,
    /** 当前有效的 TOTP 验证码(仅 otp 启用时有值) */
    otpCode: () => (otpSecret ? generateTOTP(otpSecret) : null),
    otpSecret,
    async stop() {
      await gateway.close().catch(() => undefined)
      await new Promise((res) => {
        upstream.server.closeAllConnections?.()
        upstream.server.close(() => res())
      })
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  }
}
