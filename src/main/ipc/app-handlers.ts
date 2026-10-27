import { app, ipcMain } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  IPC,
  type AppInfo,
  type AppUpdateCheck,
  type DependencyInfo,
  type PingResult
} from '@shared/bridge'
import type { IpcResult } from '@shared/contracts'
import { checkAppUpdate } from '../app-update'
import { systemLocale } from '../system-locale'

/** ping 入参：字符串或省略/null；与其余通道一致在边界走 zod 校验。 */
const PingMessageSchema = z.string().max(4096).nullish()

// 构建期由 electron.vite.config.ts 的 define 文本替换；非构建环境（如单测）无此全局，
// typeof 守卫避免 ReferenceError 并回落 'unknown'。
declare const __DSH_BUILD_COMMIT__: string
declare const __DSH_BUILD_TIME__: string
const BUILD_COMMIT = typeof __DSH_BUILD_COMMIT__ === 'string' ? __DSH_BUILD_COMMIT__ : 'unknown'
const BUILD_TIME = typeof __DSH_BUILD_TIME__ === 'string' ? __DSH_BUILD_TIME__ : 'unknown'

/**
 * 打包进产物的第三方依赖清单：三个构建目标各自在 generateBundle 时写出
 * `out/<目标>/bundled-deps.json`，这里取并集（同名包先到先得，版本同源安装一致）。
 * renderer 是最后构建的目标，其清单缺失说明 out/ 尚未完整构建（如刚 clone 即 pnpm dev），
 * 此时返回空表让「关于」面板隐藏该区块，而不是展示一份残缺清单。
 */
function readBundledDeps(): DependencyInfo[] {
  // 产物外环境（单测等）没有 __dirname 或目录不匹配，直接回落空表。
  if (typeof __dirname !== 'string') return []
  const fragment = (target: string): string => join(__dirname, '..', target, 'bundled-deps.json')
  const rendererManifest = fragment('renderer')
  if (!existsSync(rendererManifest)) return []
  const merged = new Map<string, string>()
  for (const file of [fragment('main'), fragment('preload'), rendererManifest]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(parsed)) continue
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue
        const { name, version } = entry as { name?: unknown; version?: unknown }
        if (typeof name === 'string' && name && typeof version === 'string' && version) {
          if (!merged.has(name)) merged.set(name, version)
        }
      }
    } catch {
      // 单个清单缺失或损坏不影响其余目标的清单。
    }
  }
  return [...merged]
    .map(([name, version]) => ({ name, version }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** 应用级通道的装配依赖。 */
export interface AppHandlerDeps {
  /**
   * 应用更新检查（入参为当前应用版本）；缺省用 GitHub Release 实现，
   * 单测注入假实现，避免通道触发时发起外网请求。
   */
  checkUpdate?: (currentVersion: string) => Promise<AppUpdateCheck>
}

export function registerAppHandlers(
  processVersions: NodeJS.ProcessVersions & { electron?: string },
  wrap: <T>(task: () => Promise<T> | T) => Promise<IpcResult<T>>,
  deps: AppHandlerDeps = {}
): void {
  ipcMain.handle(IPC.info, (): Promise<IpcResult<AppInfo>> =>
    wrap(() => ({
      appVersion: app.getVersion(),
      buildCommit: BUILD_COMMIT,
      buildTime: BUILD_TIME,
      platform: process.platform,
      arch: process.arch,
      chrome: process.versions.chrome,
      electron: processVersions.electron ?? '',
      node: process.versions.node,
      v8: process.versions.v8,
      userDataPath: app.getPath('userData'),
      // dsh 的默认 DSH_HOME：全平台 join(homedir(), '.dsh')，与 dsh 自身一致。
      defaultDshHome: join(homedir(), '.dsh'),
      locale: systemLocale(),
      bundledDeps: readBundledDeps()
    }))
  )

  ipcMain.handle(IPC.ping, (_event, message: unknown): Promise<IpcResult<PingResult>> =>
    wrap(() => {
      const parsed = PingMessageSchema.parse(message)
      return {
        echo: parsed !== null && parsed !== undefined && parsed !== '' ? parsed : null,
        at: Date.now()
      }
    })
  )

  // 检查应用更新：无参数；版本取自身，仓库地址由主进程按 HOMEPAGE_URL 解析，
  // 渲染层只能触发检查动作本身。
  ipcMain.handle(IPC.checkUpdate, (): Promise<IpcResult<AppUpdateCheck>> =>
    wrap(() => (deps.checkUpdate ?? checkAppUpdate)(app.getVersion()))
  )
}
