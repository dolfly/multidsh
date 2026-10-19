/**
 *
 * 归因分类写入状态与审计：exit code + stderr 特征 → 归因类别 + 面向用户的一句话。
 */

export type SshExitKind =
  | 'auth' // 鉴权失败（口令/密钥/权限）
  | 'resolve' // 主机名解析失败
  | 'connect' // 连接层失败（拒绝/重置/不可达）
  | 'timeout' // 连接超时
  | 'forward' // 端口转发失败（本地绑定冲突 / 远端拒绝监听）
  | 'host-key' // 服务器指纹未确认或被更改（需用户重新确认，不应触发换端口）
  | 'closed' // 对端主动/正常关闭（连接被关闭、远端不可达判死）
  | 'unknown'

export interface SshExitAttribution {
  kind: SshExitKind
  /** 面向用户的一句话（英文原文截断 + 归因说明） */
  message: string
}

const FEATURES: Array<{ kind: SshExitKind; patterns: RegExp[]; label: string }> = [
  {
    kind: 'auth',
    patterns: [
      /permission denied/i,
      /authentication failed/i,
      /denied \(publickey/i,
      /no more authentication methods/i,
      /password required/i
    ],
    label: '鉴权失败（口令 / 密钥 / 权限）'
  },
  {
    kind: 'resolve',
    patterns: [
      /could not resolve hostname/i,
      /no address associated/i,
      /temporary failure in name resolution/i
    ],
    label: '主机名解析失败'
  },
  {
    kind: 'connect',
    patterns: [
      /connection refused/i,
      /connection reset/i,
      /no route to host/i,
      /network is unreachable/i,
      /connection closed by remote host/i
    ],
    label: '连接被拒绝或中断'
  },
  {
    kind: 'timeout',
    patterns: [/operation timed out/i, /connection timed out/i, /timed out/i],
    label: '连接超时'
  },
  {
    kind: 'forward',
    patterns: [
      /port forwarding failed/i,
      /forwarding failed/i,
      /remote port forwarding failed/i,
      /exit-on-forward-failure/i,
      /cannot listen to port/i,
      // 本地 -L 绑定失败的典型串(本机端口被占)
      /could not request local forwarding/i,
      /address already in use/i
    ],
    label: '端口转发失败（本地端口被占或远端拒绝监听）'
  },
  {
    kind: 'host-key',
    patterns: [/host key verification failed/i, /remote host identification has changed/i],
    label: '服务器指纹未确认或被更改（请在实例详情重新确认指纹）'
  },
  {
    kind: 'closed',
    patterns: [
      /connection to .* closed/i,
      /closed by remote host/i,
      /server unexpectedly closed network connection/i
    ],
    label: '连接被远端关闭'
  }
]

/** 截断 stderr 原文供状态详情展示（保留特征行） */
function featureLine(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return null
  // 取「关键词最多的最后一行」附近：OpenSSH 的错误通常在尾部
  return lines.slice(-3).join(' | ').slice(0, 280)
}

export function classifySshExit(code: number | null, stderr: string): SshExitAttribution {
  const evidence = featureLine(stderr)
  for (const feature of FEATURES) {
    if (feature.patterns.some((pattern) => pattern.test(stderr))) {
      const detail = evidence ?? ''
      return {
        kind: feature.kind,
        message: `${feature.label}${detail ? `（${detail}）` : ''}`
      }
    }
  }
  if (code === 0) {
    return { kind: 'closed', message: 'SSH 进程正常退出（退出码 0）' }
  }
  return {
    kind: 'unknown',
    message: `SSH 会话异常退出（code=${code ?? 'null'}）` + (evidence ? `；${evidence}` : '')
  }
}
