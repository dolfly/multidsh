import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  STATUS_INFO,
  compactWorkspaceAddress,
  fmtLogTime,
  toDisplayStatus,
  toStatusInfo
} from './format'
import type { DisplayStatus } from './format'

/**
 * 验证状态圆点映射和渲染代码中的动态类名。
 * 测试运行在 Node 环境，因此通过源码检查验证组件使用映射提供的圆点类名。
 */

/** 运行时四态 → 期望的圆点修饰类（`''` = `.status-dot` 基色 `--idle`，即灰） */
const EXPECTED_DOT: ReadonlyArray<{ status: Parameters<typeof toStatusInfo>[0]; dot: string }> = [
  { status: undefined, dot: '' },
  { status: 'stopped', dot: '' },
  { status: 'starting', dot: 's-connecting' },
  { status: 'running', dot: 's-connected' },
  { status: 'error', dot: 's-error' }
]

describe('状态 → 展示圆点映射', () => {
  it('运行时状态映射到共享的圆点修饰类:运行中必须是绿点而不是底色灰点', () => {
    for (const { status, dot } of EXPECTED_DOT) {
      expect(toStatusInfo(status).dotClass, `status=${String(status)}`).toBe(dot)
    }
  })

  it('运行中和处理中使用非空的圆点修饰类', () => {
    // 每个状态映射到对应的圆点修饰类。
    expect(toStatusInfo('running').dotClass).not.toBe('')
    expect(toStatusInfo('starting').dotClass).not.toBe('')
    expect(toStatusInfo('error').dotClass).not.toBe('')
    // 灰点是 idle 的**专属**语义(未连接/已停止),不能拿它兜住所有状态
    expect(toStatusInfo(undefined).dotClass).toBe('')
  })

  it('圆点与胶囊同源:同一个 toStatusInfo 出口同时给出两者的类名与文案,不会各说各话', () => {
    for (const { status } of EXPECTED_DOT) {
      const info = toStatusInfo(status)
      const display: DisplayStatus = toDisplayStatus(status)
      expect(info).toBe(STATUS_INFO[display])
      expect(info.dotClass).toBe(STATUS_INFO[display].dotClass)
      expect(info.chipClass).toBe(STATUS_INFO[display].chipClass)
      expect(info.labelKey).toBe(STATUS_INFO[display].labelKey)
    }
  })

  it('映射是状态事件的纯函数:同一实例状态推进时圆点依次变化,不依赖挂载时机或行创建', () => {
    // 主进程 `onInstanceStatus` 的推进序列(starting → running → error → stopped):
    // 每一帧都只由「最新事件的 status」决定,所以列表重渲染即得到正确圆点。
    const sequence: Array<'starting' | 'running' | 'error' | 'stopped'> = [
      'starting',
      'running',
      'error',
      'stopped'
    ]
    expect(sequence.map((status) => toStatusInfo(status).dotClass)).toEqual([
      's-connecting',
      's-connected',
      's-error',
      ''
    ])
  })

  it('非空圆点类名在 styles.css 中有对应选择器', () => {
    // 类名必须有对应的 CSS 规则。
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    const modifiers = Object.values(STATUS_INFO)
      .map((info) => info.dotClass)
      .filter((dotClass) => dotClass !== '')
    expect(modifiers.length, '至少要有非灰状态').toBeGreaterThan(0)
    for (const modifier of modifiers) {
      expect(new RegExp(`\\.${modifier}\\b`).test(css), `styles.css 缺少 .${modifier}`).toBe(true)
    }
  })
})

describe('工作区标题地址', () => {
  it('远程端点仅显示简短的主机与端口，不能显示认证探测详情', () => {
    expect(
      compactWorkspaceAddress('https://dsh.crazydb.com:8443/workspaces/team-a?ignored=value')
    ).toBe('dsh.crazydb.com:8443')
  })

  it('本地地址保留端口，不能让长路径撑开标题栏', () => {
    expect(compactWorkspaceAddress('http://127.0.0.1:3080/deep/path')).toBe('127.0.0.1:3080')
  })
})

describe('日志时间戳格式', () => {
  it('固定输出 yyyy-MM-dd HH:mm:ss：本地时区，月/日/时分秒补零', () => {
    expect(fmtLogTime(new Date(2026, 0, 5, 7, 8, 9).toISOString())).toBe('2026-01-05 07:08:09')
    expect(fmtLogTime(new Date(2026, 11, 31, 23, 59, 0).toISOString())).toBe('2026-12-31 23:59:00')
  })
})

describe('向导与状态语义色', () => {
  it('选择态和信息提示使用 info 语义色，而非风险色', () => {
    // Windows 检出是 CRLF,先归一化再比对跨行片段
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8').replace(
      /\r\n/g,
      '\n'
    )
    expect(css).toContain(
      ".type-card[aria-pressed='true'] {\n  border-color: var(--info);\n  background: var(--selection-soft);"
    )
    expect(css).toContain('.n-info {\n  background: var(--info-soft);')
  })

  it('成功状态使用固定浅绿底与深绿字，不会误显示为危险色', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    expect(css).toContain('--ok-soft: #eaf8ef;')
    expect(css).toContain('--ok-ink: #166534;')
  })
})

export interface SourceFile {
  path: string
  text: string
}

/**
 * 找出「写死类名的状态圆点」——带 `status-dot` 的 `className` 里没有 `${...dotClass}`
 * 插值。返回 `路径:行` 供断言。纯函数,因此可以用合成源码反证它真的会抓（见下）。
 *
 * 注释中提到 `status-dot` 但没有 `className` 时不会被误报。
 */
export function findHardcodedStatusDots(files: readonly SourceFile[]): string[] {
  const violations: string[] = []
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      if (!line.includes('status-dot') || !line.includes('className')) return
      // 允许使用 dotClass 插值。
      const interpolated = /`[^`]*\$\{[^}]*dotClass[^}]*\}[^`]*`/.test(line)
      if (!interpolated) violations.push(`${file.path}:${index + 1}`)
    })
  }
  return violations
}

function collectTsx(dir: string): SourceFile[] {
  const found: SourceFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...collectTsx(full))
      continue
    }
    if (!entry.name.endsWith('.tsx')) continue
    found.push({
      path: relative(process.cwd(), full).split(sep).join('/'),
      text: readFileSync(full, 'utf8')
    })
  }
  return found
}

describe('状态圆点 className', () => {
  it('检测静态类名，允许动态修饰类名', () => {
    const synthetic: SourceFile[] = [
      {
        path: 'src/renderer/src/components/Broken.tsx',
        text: '<span className="status-dot" aria-hidden="true" />\n'
      },
      {
        path: 'src/renderer/src/components/Fixed.tsx',
        text: '<span className={`status-dot ${props.info.dotClass}`} aria-hidden="true" />\n'
      }
    ]
    expect(findHardcodedStatusDots(synthetic)).toEqual(['src/renderer/src/components/Broken.tsx:1'])
  })

  it('渲染层所有 status-dot 的类名都来自共享映射(不得写死)', () => {
    const files = collectTsx(join(process.cwd(), 'src/renderer/src/components'))
    // 文件集合必须非空，确保扫描实际执行。
    expect(files.length, '应能遍历到组件源文件').toBeGreaterThan(5)
    const violations = findHardcodedStatusDots(files)
    expect(
      violations,
      `以下状态圆点写死了类名(会恒为灰色基色),应改为 \`status-dot \${info.dotClass}\`:\n  ` +
        violations.join('\n  ')
    ).toEqual([])
  })
})
