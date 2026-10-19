import { describe, expect, it } from 'vitest'
import {
  loginItemSettings,
  notificationPlan,
  shouldMinimizeToTrayOnClose,
  shouldNotifyStatus
} from './native-decisions'
import { createTranslator } from '@shared/i18n'

describe('native-decisions（设置 → 原生行为）', () => {
  const on = { notifications: true }

  it('运行/失败状态变化会通知', () => {
    expect(shouldNotifyStatus({ status: 'running' }, 'starting', on)).toBe(true)
    expect(shouldNotifyStatus({ status: 'error' }, 'running', on)).toBe(true)
  })

  it('关掉通知偏好后一律不通知', () => {
    expect(shouldNotifyStatus({ status: 'running' }, 'starting', { notifications: false })).toBe(
      false
    )
  })

  it('首次观测不通知(启动时重放状态不该弹一堆「运行中」)', () => {
    expect(shouldNotifyStatus({ status: 'running' }, null, on)).toBe(false)
    expect(shouldNotifyStatus({ status: 'error' }, null, on)).toBe(false)
  })

  it('状态未变化不重复通知', () => {
    expect(shouldNotifyStatus({ status: 'running' }, 'running', on)).toBe(false)
    expect(shouldNotifyStatus({ status: 'error' }, 'error', on)).toBe(false)
  })

  it('stopped / starting 不打扰用户', () => {
    expect(shouldNotifyStatus({ status: 'stopped' }, 'running', on)).toBe(false)
    expect(shouldNotifyStatus({ status: 'starting' }, 'stopped', on)).toBe(false)
  })

  it('托盘偏好 + 托盘存在才隐藏窗口', () => {
    expect(shouldMinimizeToTrayOnClose({ tray: true }, true)).toBe(true)
    expect(shouldMinimizeToTrayOnClose({ tray: false }, true)).toBe(false)
  })

  it('偏好开着但没有托盘时绝不隐藏(否则应用叫不回来)', () => {
    expect(shouldMinimizeToTrayOnClose({ tray: true }, false)).toBe(false)
  })

  it('自启设置映射为登录项(自启时不抢焦点)', () => {
    expect(loginItemSettings({ autoStart: true })).toEqual({
      openAtLogin: true,
      openAsHidden: true
    })
    expect(loginItemSettings({ autoStart: false })).toEqual({
      openAtLogin: false,
      openAsHidden: false
    })
  })

  it('通知文案跟随语言', () => {
    const event = { id: 'i1', status: 'running' as const, detail: '本地实例已就绪' }
    expect(
      notificationPlan(event, 'starting', { notifications: true }, createTranslator('zh'))
    ).toEqual({
      title: 'DSH Hub · 已连接',
      body: '本地实例已就绪'
    })
    expect(
      notificationPlan(event, 'starting', { notifications: true }, createTranslator('en'))
    ).toEqual({
      title: 'DSH Hub · Connected',
      body: '本地实例已就绪'
    })
  })

  it('不值得打扰的情形返回 null(不产生通知)', () => {
    const t = createTranslator('zh')
    expect(
      notificationPlan({ id: 'i1', status: 'running' }, null, { notifications: true }, t)
    ).toBeNull()
    expect(
      notificationPlan({ id: 'i1', status: 'running' }, 'running', { notifications: true }, t)
    ).toBeNull()
    expect(
      notificationPlan({ id: 'i1', status: 'stopped' }, 'running', { notifications: true }, t)
    ).toBeNull()
    expect(
      notificationPlan({ id: 'i1', status: 'running' }, 'starting', { notifications: false }, t)
    ).toBeNull()
  })

  it('无诊断信息时 body 回落到实例 id(不产生 undefined)', () => {
    const plan = notificationPlan(
      { id: 'i9', status: 'error' },
      'running',
      { notifications: true },
      createTranslator('en')
    )
    expect(plan?.body).toBe('i9')
    expect(plan?.title).toContain('Error')
  })
})
