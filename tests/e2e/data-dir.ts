/**
 * E2E 数据目录的唯一入口。
 *
 * 每个 spec 启动的应用都必须经 `DSH_HUB_DATA_DIR` 指向仓库内 `hub-data/e2e-*`：
 * 真实 userData（macOS 为 `~/Library/Application Support/dsh-hub-desktop`）里存着用户
 * 保存的实例、凭据与设置，测试既不该往里写，也不该为了「清污染」把整个目录删掉。
 * 用例需要重跑时只清自己那一份 `hub-data/e2e-*`（各 spec 的 beforeAll 负责）。
 *
 * 这里用 `process.cwd()` 而不是 `__dirname`：Playwright 与 Vitest 都从仓库根启动，
 * 同一模块在两边都能加载（Vitest 侧用于静态守卫，见 data-dir.test.ts）。
 * 即使工作目录不是仓库根，解析结果也只会落在 `<cwd>/hub-data` 下，不会碰到真实数据目录。
 */
import { resolve, sep } from 'node:path'

/** E2E 数据根目录（仓库内，已被 Git 忽略） */
export const E2E_DATA_ROOT = resolve(process.cwd(), 'hub-data')

function isInsideRoot(dir: string): boolean {
  return resolve(dir).startsWith(`${E2E_DATA_ROOT}${sep}`)
}

/**
 * 解析 `hub-data/<name>`。`name` 必须是单段目录名，解析结果必须在数据根目录内，
 * 否则直接抛错——宁可测试红，也不能让用例读写真实数据目录。
 */
export function e2eDataDir(name: string): string {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes(sep)
  ) {
    throw new Error(`E2E 数据目录必须是 hub-data 下的一级目录名：${name}`)
  }
  const dir = resolve(E2E_DATA_ROOT, name)
  if (!isInsideRoot(dir)) {
    throw new Error(`E2E 数据目录必须位于 ${E2E_DATA_ROOT} 内：${dir}`)
  }
  return dir
}

/**
 * 构造启动应用的环境变量：在 `process.env` 之上叠加 `extra`，并强制注入指向 `dataDir`
 * 的 `DSH_HUB_DATA_DIR`（最后写入，`extra` 无法覆盖）。`extra` 中值为 `undefined` 的键
 * 会从结果里删除，用于让个别用例撤掉 CI 预设的开关。
 *
 * 返回值是 `Record<string, string>`：`electron.launch()` 的 `env` 不接受 undefined 值。
 */
export function e2eEnv(dataDir: string, extra: NodeJS.ProcessEnv = {}): Record<string, string> {
  const dir = resolve(dataDir)
  if (!isInsideRoot(dir)) {
    throw new Error(`E2E 只允许使用 ${E2E_DATA_ROOT} 下的目录：${dir}`)
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  env['DSH_HUB_DATA_DIR'] = dir
  return env
}
