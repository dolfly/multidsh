/**
 * 外部 dsh 探测的共享测试夹具。
 *
 * 路径与用户名取自当前运行环境：真实 `ps`/`lsof` 输出的就是这些环境相关的绝对路径，
 * 因此探测比写死某个用户的路径更贴近生产，也不会把个人目录带进仓库。
 */
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

export const HOME = homedir()
export const USER = userInfo().username
export const DSH_BIN = join(HOME, '.local/bin/dsh')
export const PATCH = join(HOME, '.dush/cordis.dush.patch.yml')
/** 仓库根(vitest 以项目根为 cwd)，用于模拟 `cd <repo> && …` 的 shell 包装行 */
export const REPO_ROOT = process.cwd()

/** 当前 dsh CLI 形态：profile 由 `--profile` 指定 */
export const DSH_PROFILE_CMD = `node ${DSH_BIN} --patch ${PATCH} --profile web --port 3080 --no-open`
/** 旧形态：web 是位置参数 */
export const DSH_WEB_CMD = `node ${DSH_BIN} web --patch ${PATCH} --no-open`

/** 一段贴近真实的 `ps -axo pid=,ppid=,command=` 输出 */
export const REAL_PS = [
  '  1     0 /sbin/launchd',
  `  84758  39048 ${DSH_PROFILE_CMD}`,
  `  34325  34320 bash -c cd ${REPO_ROOT} && ps -axo pid=,command= | grep "dsh web"`,
  '  34327  34325 grep dsh web',
  '  9001  37931 node /Applications/DSH Hub.app/Contents/Resources/app.asar/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js --profile default --host 127.0.0.1 --port 30501 --no-open'
].join('\n')

/** Windows CIM 的一行：pid<TAB>ppid<TAB>command */
export function windowsProcessLine(pid: number, ppid: number, command: string): string {
  return `${pid}\t${ppid}\t${command}`
}
