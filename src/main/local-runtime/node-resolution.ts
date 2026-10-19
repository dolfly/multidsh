/**
 * 本机启动时的 node 解析：决定用哪个可执行文件跑 dsh。
 *
 * dsh 的原生插件按运行时指纹校验，不在白名单的 Electron 版本启动即以 code=1 退出，
 * 因此能用真实 node 时一律用真实 node；找不到时退回 Helper 二进制的纯 Node 模式。
 */
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { nodeModeExecutable } from '../node-mode'
import { searchNodeDirs } from './node-dirs'

export function defaultNodeInvocation(): {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
} {
  // macOS 用 Helper 二进制并带 ELECTRON_RUN_AS_NODE 退化为纯 Node 执行 dsh（避免 Dock 图标闪现；见 node-mode）。
  // `--expose-internals` 是 dsh web profile 的硬性要求（cordis-plugin-hmr 需要），缺失时就绪后即崩

  return {
    command: nodeModeExecutable(),
    args: ['--expose-internals'],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

/**
 * 解析一个真实 node 可执行文件，供 hub 与本机启动器来源执行 dsh/dush/duush。
 *
 * 查找顺序：脚本同目录（npm/pnpm 全局常放在一起）→ 常见安装落点（nvm/homebrew/pnpm 等；
 * GUI 启动时进程 PATH 往往缺 node 目录）→ PATH。
 */
export function resolveNodeFor(scriptPath: string, home: string): string | null {
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const sameDir = join(dirname(scriptPath), nodeName)
  if (existsSync(sameDir)) return sameDir
  const listDir = (dir: string): string[] => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  const dirs = [
    ...searchNodeDirs(home, listDir),
    ...(process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '')
  ]
  for (const dir of [...new Set(dirs)]) {
    const candidate = join(dir, nodeName)
    if (existsSync(candidate)) return candidate
  }
  return null
}
