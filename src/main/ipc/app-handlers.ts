import { app, ipcMain } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { IPC, type AppInfo, type DependencyInfo, type PingResult } from '@shared/bridge'
import type { IpcResult } from '@shared/contracts'
import { systemLocale } from '../system-locale'

/** ping 入参：字符串或省略/null；与其余通道一致在边界走 zod 校验。 */
const PingMessageSchema = z.string().max(4096).nullish()

// 构建期由 electron.vite.config.ts 的 define 文本替换；非构建环境（如单测）无此全局，
// typeof 守卫避免 ReferenceError 并回落 'unknown' / 空清单。
declare const __DSH_BUILD_COMMIT__: string
declare const __DSH_BUILD_TIME__: string
declare const __DSH_BUILD_DEPS__: DependencyInfo[]
const BUILD_COMMIT = typeof __DSH_BUILD_COMMIT__ === 'string' ? __DSH_BUILD_COMMIT__ : 'unknown'
const BUILD_TIME = typeof __DSH_BUILD_TIME__ === 'string' ? __DSH_BUILD_TIME__ : 'unknown'
const BUILD_DEPS: DependencyInfo[] =
  typeof __DSH_BUILD_DEPS__ === 'object' && Array.isArray(__DSH_BUILD_DEPS__)
    ? [...__DSH_BUILD_DEPS__]
    : []

export function registerAppHandlers(
  processVersions: NodeJS.ProcessVersions & { electron?: string },
  wrap: <T>(task: () => Promise<T> | T) => Promise<IpcResult<T>>
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
      thirdPartyDeps: BUILD_DEPS
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
}
