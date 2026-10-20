/**
 * 插件命令的构造与执行：`dsh plugin --profile <p> <pnpm-args>` 转发到实例的 dsh 副本。
 *
 * 全部经 dsh 转发（dsh 内部把 pnpm 参数原样透传，并自动维护 profile package.json 的
 * `dependencies` 与 `bundles` 数组）。DSH_HOME 与 profile 由主进程按实例推导，绝不采信
 * 渲染层路径；命令输出经 `redactLine` + `redactSecret` 脱敏（URL 查询串与键值凭据）。
 *
 * registry 由主进程按档位映射后追加 `--registry <url>`：dsh 把余下参数逐字转给 profile 内的
 * pnpm，因此 view（解析）与 add（安装）能落在同一个源上。
 */
import { delimiter, dirname } from 'node:path'
import { redactLine, redactSecret } from '@shared/redact'
import { pluginRegistryUrl } from '@shared/settings'
import type { LocalInstance, PluginRegistryOption } from '@shared/contracts'
import { InstanceStoreError } from '../registry/instance-store'
import { withBundledPnpmPath } from '../shell/bundled-pnpm'
import { mergeLoginPath } from './login-path'
import { mergeShellEnv } from './shell-env'
import type { CommandResult, CommandRunner } from './exec-file'

export interface PluginCommandDeps {
  run: CommandRunner
  /** 实例的 DSH_HOME 与 profile（与启动路径同一推导，由调用方提供）。 */
  homeAndProfile: (instance: LocalInstance) => { home: string; profile: string }
  /** 真实 node 解析；缺省按脚本同目录探测（见 plugin-manager.defaultResolveNode）。 */
  resolveNode: (scriptPath: string) => string | null
  /** Electron 自带 Node 兜底调用。 */
  nodeInvocation: { command: string; args: string[]; env: NodeJS.ProcessEnv }
  /** 随包分发 pnpm 启动器所在目录；提供时并入插件命令 PATH。 */
  pnpmBinDir?: string
  /** 是否把登录 shell 完整环境合并进插件命令。 */
  inheritShellEnv: () => boolean
  shellEnv: () => Promise<Map<string, string> | null>
  loginPath: () => Promise<string | null>
}

export interface PluginCommandRunner {
  /**
   * 构造并执行一次插件命令；非零退出抛 invalid-state（消息为脱敏后的 stderr 尾部）。
   * dsh 拒绝安装（不兼容闸、pnpm 失败等）时，这段说明是用户唯一能看到的失败原因，
   * 必须透出而不是收敛成「内部错误」。
   */
  runPlugin(
    instance: LocalInstance,
    args: string[],
    resolved: { entry: string; version: string },
    registry?: PluginRegistryOption | null
  ): Promise<CommandResult>
}

export function createPluginCommandRunner(deps: PluginCommandDeps): PluginCommandRunner {
  /**
   * 解析子进程的基础环境：默认合并登录 shell 完整环境（含 .zshrc/.bashrc export），
   * 关闭开关 / 解析失败时回退到仅合并登录 PATH。与本机实例启动同源——保证打包后 GUI
   * 启动也能解析到 pnpm/node（`dsh plugin` 转发 pnpm 需要它们在 PATH 上）。
   */
  async function resolveBaseEnv(): Promise<NodeJS.ProcessEnv> {
    const shellEnvMap = deps.inheritShellEnv() ? await deps.shellEnv().catch(() => null) : null
    if (shellEnvMap !== null) return mergeShellEnv(process.env, shellEnvMap)
    const loginEnvPath = await deps.loginPath().catch(() => null)
    return { ...process.env, PATH: mergeLoginPath(process.env.PATH ?? '', loginEnvPath) }
  }

  return {
    async runPlugin(instance, args, resolved, registry) {
      const { home, profile } = deps.homeAndProfile(instance)
      const fullArgs =
        registry === undefined || registry === null
          ? args
          : [...args, '--registry', pluginRegistryUrl(registry)]
      const pluginArgs = ['plugin', '--profile', profile, ...fullArgs]
      const node = deps.resolveNode(resolved.entry)
      // 登录 shell 完整环境 / 仅登录 PATH（见 resolveBaseEnv）：打包后 GUI 启动缺 pnpm/node 目录，
      // dsh plugin 转发 pnpm 会失败；node 目录始终前置，dsh 自己 spawn 的 pnpm 也解析到同一个 node。
      const baseEnv = await resolveBaseEnv()
      const basePath = baseEnv.PATH ?? ''
      const nodePath = node !== null ? dirname(node) : null
      // node 目录前置；随包 pnpm 启动器目录按平台并入：Windows 前置（系统 pnpm 全局 shim 已损坏，
      // 自带 pnpm 必须胜出），其余平台后置兜底（系统 pnpm 与用户既有 profile 的 store 大版本匹配，
      // 优先用它，避免 pnpm 10 操作 pnpm 12 建的 profile 触发 ERR_PNPM_UNEXPECTED_STORE）。
      const nodeAndBase = nodePath !== null ? `${nodePath}${delimiter}${basePath}` : basePath
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        PATH: withBundledPnpmPath(nodeAndBase, deps.pnpmBinDir),
        DSH_HOME: home,
        // pnpm v12 全局命令默认走「上下文感知 shim」（globalShims）：转发 pnpm 时该 shim 会做
        // 签名完整性校验并二次派发，nvm 等按需切换 node 的 Windows 环境下校验失败
        // （shim integrity check failed）。插件命令把 pnpm 当普通工具直接调用，设 PNPM_SHIM_BYPASS=1
        // 绕过 shim 派发（与启动路径一致；无 shim 的环境下为无副作用的空操作）。
        PNPM_SHIM_BYPASS: '1'
      }
      const nodeInvocation = deps.nodeInvocation
      const invocation =
        node !== null
          ? { command: node, args: [...nodeInvocation.args, resolved.entry, ...pluginArgs], env }
          : resolved.entry.endsWith('.js')
            ? {
                command: nodeInvocation.command,
                args: [...nodeInvocation.args, resolved.entry, ...pluginArgs],
                env: { ...env, ...nodeInvocation.env, DSH_HOME: home }
              }
            : { command: resolved.entry, args: pluginArgs, env }
      const result = await deps.run(invocation.command, invocation.args, { env: invocation.env })
      if (result.code !== 0) {
        // stderr 是自由文本，可能带 npmToken=xxx / password=xxx 形态的凭据：
        // 这段说明会经 IPC 到达渲染层的 toast，必须打掉键值凭据（redactSecret）
        // 与 URL 查询串（redactLine）。
        const tail = redactSecret(redactLine(result.stderr.trim())).split('\n').slice(-8).join('\n')
        throw new InstanceStoreError(
          'invalid-state',
          `dsh plugin ${fullArgs.join(' ')} 失败（exit ${result.code}）：${tail || '无 stderr'}`
        )
      }
      return result
    }
  }
}
