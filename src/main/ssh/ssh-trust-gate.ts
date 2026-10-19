/**
 * SSH 主机指纹的 TOFU 确认闸门：隧道建立前跑一次，决定这次连接是否放行。
 *
 * 判据与写入都在 ssh/host-trust；本模块只负责把「读已信任指纹 → keyscan → 评估 →
 * 询问用户 → 写回 known_hosts」串成一条流程，并绑定实例的 dataRoot 与确认回调。
 *
 * keyscan 拿不到公钥（主机不可达/网络抖动）或远端未出示任何公钥时**放行**：
 * 这是安全的 fail-open —— ssh 侧以 StrictHostKeyChecking=yes + 私有 UserKnownHostsFile
 * 运行（见 ssh-args），未知主机在 ssh 层直接失败关闭，hub 放行不等于自动信任。
 */
import { join } from 'node:path'
import type { SshInstance } from '@shared/contracts'
import {
  evaluateHostTrust,
  hostTargetLabel,
  knownHostsHostField,
  recordHostTrust,
  toFingerprints,
  type HostKeyEntry,
  type HostKeyPrompt,
  type HostTrustProbe,
  type ResolvedSshTarget
} from './host-trust'

export interface HostTrustGateDeps {
  /** 应用数据根：私有 known_hosts 落在 `<dataRoot>/ssh/known_hosts`。 */
  dataRoot: string
  /** 指纹确认回调；未接线（单测）时 unknown 放行、changed 一律拒绝。 */
  confirmHostKey?: (request: HostKeyPrompt) => Promise<'trust' | 'reject'>
  /** 信任探测器工厂（注入以便单测覆盖 TOFU 写入/轮换）。 */
  trustProbeFactory: (host: string, port: number, knownHostsPath: string) => HostTrustProbe
  /** ssh -G 实际目标解析器（对齐别名的真实目标）。 */
  resolveTarget: (
    instance: Pick<SshInstance, 'host' | 'port' | 'username'>
  ) => Promise<ResolvedSshTarget>
}

export interface HostTrustGate {
  /** 返回 true 表示可继续建立隧道；false 表示指纹已变化或用户拒绝。 */
  ensureTrust(instance: SshInstance, emitWaiting: (detail: string) => void): Promise<boolean>
  /** `ssh -G` 不可用时回落实例输入，仍可连接并归因。 */
  resolveTargetOrFallback(instance: SshInstance): Promise<ResolvedSshTarget>
}

export function createHostTrustGate(deps: HostTrustGateDeps): HostTrustGate {
  async function resolveTargetOrFallback(instance: SshInstance): Promise<ResolvedSshTarget> {
    try {
      return await deps.resolveTarget(instance)
    } catch {
      // `ssh -G` 仅用于对齐别名的实际目标；不可用时仍可按实例输入继续连接并归因。
      return { host: instance.host, port: instance.port }
    }
  }

  return {
    resolveTargetOrFallback,

    async ensureTrust(instance, emitWaiting) {
      const target = await resolveTargetOrFallback(instance)
      const knownHostsPath = join(deps.dataRoot, 'ssh', 'known_hosts')
      const hostField = knownHostsHostField(target.host, target.port)
      const probe = deps.trustProbeFactory(target.host, target.port, knownHostsPath)
      const trusted = await probe.readTrusted()
      let scanned: HostKeyEntry[]
      try {
        scanned = await probe.scan()
      } catch {
        return true
      }
      if (scanned.length === 0) return true
      const evaluation = evaluateHostTrust(trusted, scanned)
      if (evaluation.verdict === 'trusted') return true
      if (evaluation.verdict === 'changed') {
        // 这里仍然把新旧指纹如实投给 UI 供人工核对(告警),但**任何回答都不放行**,旧公钥
        // 一个字节都不改。想恢复只能在隧道外显式执行遗忘（forgetHostKey），下次连接重新 TOFU。
        emitWaiting('服务器指纹已变化，已拒绝连接')
        if (deps.confirmHostKey) {
          await deps.confirmHostKey({
            instanceId: instance.id,
            target: hostTargetLabel(target.host, target.port),
            verdict: 'changed',
            fingerprints: toFingerprints(scanned),
            previousFingerprints: toFingerprints(evaluation.mismatched)
          })
        }
        return false
      }
      if (!deps.confirmHostKey) return true // 未接线(单测)则直接放行
      emitWaiting('等待确认服务器指纹')
      const decision = await deps.confirmHostKey({
        instanceId: instance.id,
        target: hostTargetLabel(target.host, target.port),
        verdict: 'unknown',
        fingerprints: toFingerprints(scanned),
        previousFingerprints: []
      })
      if (decision !== 'trust') return false
      await recordHostTrust(knownHostsPath, hostField, scanned, 'append')
      return true
    }
  }
}
