import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceStatusEvent } from '@shared/contracts'

/**
 *
 * 「该不该通知」有纯函数测试,而真正送达的那一步没有。这里 mock 掉 electron 的
 * `Notification`,直接断言 `.show()` 被调用、且载荷来自 `notificationPlan`。
 */

const shown = vi.hoisted(() => [] as Array<{ title: string; body: string }>)
const supported = vi.hoisted(() => ({ value: true }))
const constructError = vi.hoisted(() => ({ value: null as Error | null }))

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return supported.value
    }
    private readonly options: { title: string; body: string }
    constructor(options: { title: string; body: string }) {
      if (constructError.value) throw constructError.value
      this.options = options
    }
    show(): void {
      shown.push(this.options)
    }
  }
}))

import { createStatusNotifier } from './status-notifier'
import type { StatusNotifierDeps } from './status-notifier'

function running(detail?: string): InstanceStatusEvent {
  return {
    id: 'inst-1',
    status: 'running',
    at: '2026-01-01T00:00:00.000Z',
    ...(detail ? { detail } : {})
  }
}

function notifier(
  settings: { language: 'zh' | 'en'; notifications: boolean } = {
    language: 'zh',
    notifications: true
  },
  overrides: Partial<StatusNotifierDeps> = {}
) {
  return createStatusNotifier({
    readSettings: () => settings,
    locale: () => 'zh-CN',
    ...overrides
  })
}

beforeEach(() => {
  shown.length = 0
  supported.value = true
  constructError.value = null
})

describe('createStatusNotifier（通知真的发出去）', () => {
  it('状态 stopped→running 且偏好开启 → 真的调用 Notification.show()(「删掉 show」的锚点)', () => {
    const sent = notifier().notify(running('端口 30001'), 'stopped')
    expect(sent).toBe(true)
    expect(shown).toEqual([{ title: 'DSH Hub · 已连接', body: '端口 30001' }])
  })

  it('文案跟随偏好语言(en)', () => {
    notifier({ language: 'en', notifications: true }).notify(running('port 30001'), 'stopped')
    expect(shown).toEqual([{ title: 'DSH Hub · Connected', body: 'port 30001' }])
  })

  it('没有 detail 时用实例 id 兜底', () => {
    notifier().notify(running(), 'stopped')
    expect(shown).toEqual([{ title: 'DSH Hub · 已连接', body: 'inst-1' }])
  })

  it('首次观测 / 偏好关闭 / 状态未变化 / stopped → 一律不发送', () => {
    const notify = notifier().notify
    expect(notify(running(), null)).toBe(false)
    expect(notifier({ language: 'zh', notifications: false }).notify(running(), 'stopped')).toBe(
      false
    )
    expect(notify(running(), 'running')).toBe(false)
    expect(
      notify({ id: 'inst-1', status: 'stopped', at: '2026-01-01T00:00:00.000Z' }, 'running')
    ).toBe(false)
    expect(shown).toEqual([])
  })

  it('平台不支持通知 → 不构造也不发送', () => {
    supported.value = false
    expect(notifier({ language: 'zh', notifications: true }).notify(running(), 'stopped')).toBe(
      false
    )
    expect(shown).toEqual([])
  })

  it('发送失败只经 onError 上报,绝不冒泡进状态流', () => {
    const onError = vi.fn()
    constructError.value = new Error('通知中心不可用')
    expect(
      notifier({ language: 'zh', notifications: true }, { onError }).notify(running(), 'stopped')
    ).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(shown).toEqual([])
  })

  it('偏好每次通知都重新读取(运行中关掉通知后立即生效)', () => {
    let enabled = true
    const notify = createStatusNotifier({
      readSettings: () => ({ language: 'zh' as const, notifications: enabled }),
      locale: () => 'zh-CN'
    }).notify
    expect(notify(running(), 'stopped')).toBe(true)
    enabled = false
    expect(notify(running(), 'stopped')).toBe(false)
    expect(shown).toHaveLength(1)
  })
})
