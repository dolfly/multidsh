/**
 * ELECTRON_RUN_AS_NODE 子进程的可执行文件选择。
 *
 * 主进程以 `ELECTRON_RUN_AS_NODE=1` 把 Electron 本体当纯 Node 拉起子进程（npm / dsh /
 * 插件命令）时，macOS 上若用主二进制（`process.execPath`）会短暂把应用显示在 Dock——
 * 主 bundle 未声明 LSUIElement，系统仍把它当普通 GUI 应用注册。Helper 二进制
 * （Electron Helper.app，LSUIElement=1）同样支持 ELECTRON_RUN_AS_NODE 以纯 Node 运行，
 * 但不产生 Dock 图标，因此 macOS 优先使用它；非 macOS 平台无此问题，直接用主二进制。
 */
export function resolveNodeModeCommand(
  platform: NodeJS.Platform,
  execPath: string,
  helperExecPath: string | undefined
): string {
  if (platform !== 'darwin') return execPath
  return helperExecPath && helperExecPath.length > 0 ? helperExecPath : execPath
}

/**
 * 当前进程的 node 模式命令：macOS 上取 Helper（不可用时回落主二进制），其它平台取主二进制。
 * `process.helperExecPath` 是 Electron 运行时提供的 Helper 可执行文件路径（非公开类型）。
 */
export function nodeModeExecutable(): string {
  return resolveNodeModeCommand(
    process.platform,
    process.execPath,
    (process as { helperExecPath?: string }).helperExecPath
  )
}
