import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InstanceRecord } from '@shared/contracts'

/**
 * 推导本机实例 DSH_HOME 所需的最小输入（不涉及打开副作用，便于日志清理等只读复用）。
 *
 * 安全要点：目标目录由主进程从 `dataRoot` 与实例记录自行拼装（隔离空间
 * `<dataRoot>/homes/<id>` 或公共空间 `~/.dsh`），渲染层只传实例 id、不传路径。
 */
export interface DshHomePorts {
  /** 应用数据根目录（装配层负责让 `DSH_HUB_DATA_DIR` 覆盖生效）。 */
  dataRoot: string
  /** 用户主目录来源；公共空间实例的 DSH_HOME 为 `<home>/.dsh`。缺省 os.homedir。 */
  homeDir?: () => string
}

/**
 * 打开本机实例目录所需的副作用端口（生产由 electron `shell.openPath` 实现，测试用 spy）。
 */
export interface OpenInstanceDirPorts extends DshHomePorts {
  /** 沿用 electron `shell.openPath` 约定：返回空串表示成功，非空串是失败原因。 */
  openPath: (path: string) => Promise<string>
}

export class InstanceDirOpenError extends Error {
  constructor(
    readonly code: 'io-error',
    message: string
  ) {
    super(message)
    this.name = 'InstanceDirOpenError'
  }
}

/** 本机实例的 DSH_HOME：隔离空间落在 `<dataRoot>/homes/<id>`，公共空间为 `~/.dsh`。 */
export function instanceHomeDir(ports: DshHomePorts, record: InstanceRecord): string {
  const home = (ports.homeDir ?? homedir)()
  return record.transport === 'local' && !record.useDefaultSpace
    ? join(ports.dataRoot, 'homes', record.id)
    : join(home, '.dsh')
}

async function openResolved(ports: OpenInstanceDirPorts, dir: string): Promise<void> {
  let failure: string
  try {
    await mkdir(dir, { recursive: true })
    failure = await ports.openPath(dir)
  } catch (error) {
    throw new InstanceDirOpenError(
      'io-error',
      error instanceof Error ? error.message : String(error)
    )
  }
  if (failure !== '') throw new InstanceDirOpenError('io-error', failure)
}

/** 打开实例数据目录（DSH_HOME）；不存在时先创建，保证总有目录可开。 */
export async function openInstanceDir(
  ports: OpenInstanceDirPorts,
  record: InstanceRecord
): Promise<void> {
  await openResolved(ports, instanceHomeDir(ports, record))
}

/**
 * 打开实例日志目录：优先 dsh 的插件操作日志目录
 * `<DSH_HOME>/profiles/<profile>/.plugin-manager/logs`（插件安装失败的诊断日志落点），
 * 不存在时回落到 DSH_HOME，保证总有目录可开。
 */
export async function openInstanceLogDir(
  ports: OpenInstanceDirPorts,
  record: InstanceRecord
): Promise<void> {
  const home = instanceHomeDir(ports, record)
  const profile = (record.transport === 'local' ? record.profile : null) ?? 'web'
  const logsDir = join(home, 'profiles', profile, '.plugin-manager', 'logs')
  const exists = await stat(logsDir).then(
    () => true,
    () => false
  )
  await openResolved(ports, exists ? logsDir : home)
}
