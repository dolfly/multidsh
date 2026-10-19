import { describe, expect, it, vi } from 'vitest'
import { handleWindowClose } from './close-to-tray'

/**
 *
 * **硬编码成 `true`**。纯函数测试覆盖不了它(纯函数本身没错),本文件覆盖接线:
 * 「托盘是否存在」必须实时查询,且只在真的该隐藏时才拦截关闭。
 */
function setup(settings: { tray: boolean } | null, trayAvailable: boolean, quitting = false) {
  const preventDefault = vi.fn()
  const hideWindow = vi.fn()
  const handled = handleWindowClose(
    { preventDefault },
    {
      settings: () => settings,
      trayAvailable: () => trayAvailable,
      isQuitting: () => quitting,
      hideWindow
    }
  )
  return { handled, preventDefault, hideWindow }
}

describe('handleWindowClose（close-to-tray 接线）', () => {
  it('偏好开启且托盘确实存在 → 拦截关闭并隐藏窗口', () => {
    const { handled, preventDefault, hideWindow } = setup({ tray: true }, true)
    expect(handled).toBe(true)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(hideWindow).toHaveBeenCalledTimes(1)
  })

  it('偏好开启但**托盘不存在** → 放行(「第二个实参硬编码 true」的锚点)', () => {
    // 硬编码 true 会让这里拦截关闭并隐藏窗口 —— 应用从此叫不回来(只剩 macOS Dock)
    const { handled, preventDefault, hideWindow } = setup({ tray: true }, false)
    expect(handled).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(hideWindow).not.toHaveBeenCalled()
  })

  it('偏好关闭 → 放行(尊重用户显式设置)', () => {
    const { handled, preventDefault, hideWindow } = setup({ tray: false }, true)
    expect(handled).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(hideWindow).not.toHaveBeenCalled()
  })

  it('偏好尚未装配(null) → 放行(启动早期的关闭必须真的关掉)', () => {
    const { handled, preventDefault } = setup(null, true)
    expect(handled).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('正在退出时放行关闭，避免托盘退出又把窗口隐藏回去', () => {
    const { handled, preventDefault, hideWindow } = setup({ tray: true }, true, true)
    expect(handled).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(hideWindow).not.toHaveBeenCalled()
  })

  it('托盘存在性必须**实时查询**,不能用常量代替(「写死 trayAvailable」的锚点)', () => {
    const trayAvailable = vi.fn(() => false)
    handleWindowClose(
      { preventDefault: vi.fn() },
      {
        settings: () => ({ tray: true }),
        trayAvailable,
        isQuitting: () => false,
        hideWindow: vi.fn()
      }
    )
    expect(trayAvailable).toHaveBeenCalledTimes(1)
  })
})
