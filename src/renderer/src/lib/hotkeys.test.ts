import { describe, expect, it } from 'vitest'
import { instanceSwitchIndex } from './hotkeys'

function key(
  patch: Partial<
    Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'altKey' | 'ctrlKey' | 'isComposing'>
  >
): Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'altKey' | 'ctrlKey' | 'isComposing'> {
  return {
    key: '',
    code: '',
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    ...patch
  }
}

describe('instanceSwitchIndex', () => {
  it('macOS 下按住 ⌘(Meta) 的数字键映射为 0 起下标', () => {
    expect(instanceSwitchIndex(key({ key: '1', code: 'Digit1', metaKey: true }), 'darwin')).toBe(0)
    expect(instanceSwitchIndex(key({ key: '3', code: 'Numpad3', metaKey: true }), 'darwin')).toBe(2)
  })

  it('Windows/Linux 下按住 Alt 的数字键映射为 0 起下标', () => {
    expect(instanceSwitchIndex(key({ key: '1', code: 'Digit1', altKey: true }), 'win32')).toBe(0)
    expect(instanceSwitchIndex(key({ key: '9', code: 'Digit9', altKey: true }), 'linux')).toBe(8)
  })

  it('平台不匹配的修饰键不切换：Windows 的 ⌘(Win 键)、macOS 的 Alt 都不触发', () => {
    expect(
      instanceSwitchIndex(key({ key: '1', code: 'Digit1', metaKey: true }), 'win32')
    ).toBeNull()
    expect(
      instanceSwitchIndex(key({ key: '1', code: 'Digit1', altKey: true }), 'darwin')
    ).toBeNull()
    // Ctrl 不再是切换修饰键
    expect(
      instanceSwitchIndex(key({ key: '1', code: 'Digit1', ctrlKey: true }), 'win32')
    ).toBeNull()
  })

  it('缺 code 时按 key 兜底', () => {
    expect(instanceSwitchIndex(key({ key: '4', metaKey: true }), 'darwin')).toBe(3)
    expect(instanceSwitchIndex(key({ key: '4', altKey: true }), 'win32')).toBe(3)
  })

  it('无修饰键、非数字键、0 都不切换', () => {
    expect(instanceSwitchIndex(key({ key: '1', code: 'Digit1' }), 'darwin')).toBeNull()
    expect(instanceSwitchIndex(key({ key: 'n', code: 'KeyN', metaKey: true }), 'darwin')).toBeNull()
    expect(instanceSwitchIndex(key({ key: '0', code: 'Digit0', altKey: true }), 'win32')).toBeNull()
  })

  it('输入法组合期间不接管', () => {
    expect(
      instanceSwitchIndex(
        key({ key: '1', code: 'Digit1', metaKey: true, isComposing: true }),
        'darwin'
      )
    ).toBeNull()
  })
})
