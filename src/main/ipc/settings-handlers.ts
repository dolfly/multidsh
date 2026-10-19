import { ipcMain } from 'electron'
import { z } from 'zod'
import { SETTINGS_IPC, type EnvironmentRefreshResult, type IpcResult } from '@shared/contracts'
import { SettingsSchema, type Settings } from '@shared/settings'
import type { SettingsStore } from '../settings/settings-store'
import { DataDirOpenError } from '../shell/open-data-dir'
import { emptyEnvironmentDiff } from '../local-runtime/env-diff'

export interface SettingsHandlerDeps {
  settings: SettingsStore
  onSettingsChanged?: (settings: Settings, changedKeys: readonly (keyof Settings)[]) => void
  openDataDir?: () => Promise<void>
  /**
   * 刷新环境缓存（失效并重新解析登录 PATH / shell 环境），返回刷新前后的差异，
   * 以及当前正在运行、可由 hub 重启的本机实例 id，供渲染层报告变化并提示重启生效。
   */
  refreshEnvironment?: () => Promise<EnvironmentRefreshResult>
}

export function registerSettingsHandlers(
  deps: SettingsHandlerDeps,
  wrap: <T>(task: () => Promise<T> | T) => Promise<IpcResult<T>>
): void {
  ipcMain.handle(SETTINGS_IPC.get, (): Promise<IpcResult<Settings>> =>
    wrap(() => deps.settings.read())
  )

  ipcMain.handle(SETTINGS_IPC.update, (_event, patch: unknown): Promise<IpcResult<Settings>> =>
    wrap(async () => {
      const raw = z.record(z.string(), z.unknown()).parse(patch)
      SettingsSchema.partial().strict().parse(raw)
      const known = Object.keys(SettingsSchema.shape) as Array<keyof Settings>
      const provided: Partial<Settings> = {}
      for (const key of known) {
        if (key in raw) provided[key] = raw[key] as never
      }
      const next = await deps.settings.update(provided)
      deps.onSettingsChanged?.(next, Object.keys(provided) as Array<keyof Settings>)
      return next
    })
  )

  ipcMain.handle(SETTINGS_IPC.openDataDir, (_event, ...args: unknown[]): Promise<IpcResult<null>> =>
    wrap(async () => {
      z.tuple([]).parse(args)
      if (!deps.openDataDir) throw new DataDirOpenError('internal', '打开数据目录不可用')
      await deps.openDataDir()
      return null
    })
  )

  ipcMain.handle(
    SETTINGS_IPC.refreshEnvironment,
    (_event, ...args: unknown[]): Promise<IpcResult<EnvironmentRefreshResult>> =>
      wrap(async () => {
        z.tuple([]).parse(args)
        // 不可用时按「无实例、无可比差异」处理：刷新是副作用，返回空结果也不报错。
        if (!deps.refreshEnvironment) return { instances: [], diff: emptyEnvironmentDiff() }
        return deps.refreshEnvironment()
      })
  )
}
