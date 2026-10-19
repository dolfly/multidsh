import { describe, expect, it } from 'vitest'
import { createNativeSettingsApplier, planNativeSettings } from './native-settings'

const T = (tray: boolean, autoStart = false) => ({ tray, autoStart })

describe('planNativeSettings（设置 → 原生动作）', () => {
  it('托盘:开→无 创建;有→关 销毁', () => {
    expect(planNativeSettings({ settings: T(true), trayExists: false, startup: false })).toEqual([
      { kind: 'create-tray' },
      { kind: 'set-login-item', autoStart: false }
    ])
    expect(
      planNativeSettings({ settings: T(false), trayExists: true, startup: false })
    ).toContainEqual({ kind: 'destroy-tray' })
  })

  it('托盘已存在且仍开启 → **刷新文案**(切换语言后菜单不能停在旧语言)', () => {
    expect(
      planNativeSettings({ settings: T(true), trayExists: true, startup: false })
    ).toContainEqual({ kind: 'update-tray' })
  })

  it('启动时只在需要开启时写登录项(避免无意义地写「关闭」)', () => {
    const off = planNativeSettings({ settings: T(false, false), trayExists: false, startup: true })
    expect(off.some((action) => action.kind === 'set-login-item')).toBe(false)

    const on = planNativeSettings({ settings: T(false, true), trayExists: false, startup: true })
    expect(on).toContainEqual({ kind: 'set-login-item', autoStart: true })
  })

  it('运行期切换自启必须落到 OS(含关闭)', () => {
    expect(
      planNativeSettings({ settings: T(false, true), trayExists: false, startup: false })
    ).toContainEqual({ kind: 'set-login-item', autoStart: true })
    expect(
      planNativeSettings({ settings: T(false, false), trayExists: false, startup: false })
    ).toContainEqual({ kind: 'set-login-item', autoStart: false })
  })

  it('仅切换语言时只刷新已有托盘文案，绝不重写登录项', () => {
    const actions = planNativeSettings({
      settings: T(true, true),
      trayExists: true,
      startup: false,
      changedKeys: ['language']
    })
    expect(actions).toEqual([{ kind: 'update-tray' }])
  })

  it('关托盘时不产生创建/刷新动作(不留下无用图标)', () => {
    const actions = planNativeSettings({ settings: T(false), trayExists: false, startup: false })
    expect(actions.some((a) => a.kind === 'create-tray' || a.kind === 'update-tray')).toBe(false)
  })
})

describe('createNativeSettingsApplier（原生副作用）', () => {
  function spyPorts(trayExists: boolean) {
    return {
      calls: [] as string[],
      trayExists: () => trayExists,
      createTray() {
        this.calls.push('create')
      },
      destroyTray() {
        this.calls.push('destroy')
      },
      updateTray() {
        this.calls.push('update')
      },
      setLoginItem(autoStart: boolean) {
        this.calls.push(`login:${autoStart}`)
      },
      onError() {
        this.calls.push('error')
      }
    }
  }

  it('托盘不存在且开启 → 真的调用 createTray', () => {
    const ports = spyPorts(false)
    createNativeSettingsApplier(ports).apply({ tray: true, autoStart: false }, { startup: false })
    expect(ports.calls).toContain('create')
  })

  it('托盘已存在且开启 → 真的调用 updateTray(的锚点)', () => {
    const ports = spyPorts(true)
    createNativeSettingsApplier(ports).apply({ tray: true, autoStart: false }, { startup: false })
    expect(ports.calls).toContain('update')
  })

  it('开启自启 → 真的把 true 交给登录项(的锚点)', () => {
    const ports = spyPorts(false)
    createNativeSettingsApplier(ports).apply({ tray: false, autoStart: true }, { startup: false })
    expect(ports.calls).toContain('login:true')
  })

  it('启动且未开启自启 → 不触碰登录项', () => {
    const ports = spyPorts(false)
    createNativeSettingsApplier(ports).apply({ tray: false, autoStart: false }, { startup: true })
    expect(ports.calls.some((call) => call.startsWith('login:'))).toBe(false)
  })

  it('某个动作抛错不影响其余动作(失败经 onError 上报)', () => {
    const calls: string[] = []
    const applier = createNativeSettingsApplier({
      trayExists: () => false,
      createTray() {
        throw new Error('托盘不可用')
      },
      destroyTray() {},
      updateTray() {},
      setLoginItem(autoStart) {
        calls.push(`login:${autoStart}`)
      },
      onError(_error, action) {
        calls.push(`error:${action}`)
      }
    })
    const actions = applier.apply({ tray: true, autoStart: true }, { startup: false })
    expect(actions.map((a) => a.kind)).toEqual(['create-tray', 'set-login-item'])
    expect(calls).toEqual(['error:create-tray', 'login:true'])
  })
})
