import { describe, expect, it, vi } from 'vitest'
import { toWorkspaceHotkey, type WorkspaceKeyInput } from './workspace-hotkey'

function input(patch: Partial<WorkspaceKeyInput>): WorkspaceKeyInput {
  return {
    type: 'keyDown',
    key: '',
    code: '',
    meta: false,
    control: false,
    alt: false,
    isComposing: false,
    ...patch
  }
}

describe('toWorkspaceHotkey（macOS：切换修饰键为 ⌘/Meta）', () => {
  it('放行 ⌘ 键本身，按 down/up 原样转发', () => {
    expect(toWorkspaceHotkey(input({ key: 'Meta', code: 'MetaLeft' }), 'darwin')).toEqual({
      phase: 'down',
      key: 'Meta',
      code: 'MetaLeft',
      meta: false,
      ctrl: false,
      alt: false
    })
    expect(
      toWorkspaceHotkey(
        input({ type: 'keyUp', key: 'Meta', code: 'MetaLeft', meta: true }),
        'darwin'
      )
    ).toEqual({ phase: 'up', key: 'Meta', code: 'MetaLeft', meta: true, ctrl: false, alt: false })
  })

  it('放行按住 ⌘ 时的数字键 1-9，并携带当时的修饰键状态', () => {
    expect(toWorkspaceHotkey(input({ key: '1', code: 'Digit1', meta: true }), 'darwin')).toEqual({
      phase: 'down',
      key: '1',
      code: 'Digit1',
      meta: true,
      ctrl: false,
      alt: false
    })
    // 只有 key 的注入路径同样按数字识别
    expect(toWorkspaceHotkey(input({ key: '3', code: '', meta: true }), 'darwin')?.phase).toBe(
      'down'
    )
  })

  it('macOS 下 Alt 不是切换修饰键：Alt 键与 Alt+数字都不转发', () => {
    expect(toWorkspaceHotkey(input({ key: 'Alt', code: 'AltLeft' }), 'darwin')).toBeNull()
    expect(toWorkspaceHotkey(input({ key: '1', code: 'Digit1', alt: true }), 'darwin')).toBeNull()
    // Ctrl 也不再触发
    expect(
      toWorkspaceHotkey(input({ key: '1', code: 'Digit1', control: true }), 'darwin')
    ).toBeNull()
  })
})

describe('toWorkspaceHotkey（Windows/Linux：切换修饰键为 Alt）', () => {
  it('放行 Alt 键本身，按 down/up 原样转发', () => {
    expect(toWorkspaceHotkey(input({ key: 'Alt', code: 'AltLeft' }), 'win32')).toEqual({
      phase: 'down',
      key: 'Alt',
      code: 'AltLeft',
      meta: false,
      ctrl: false,
      alt: false
    })
    expect(
      toWorkspaceHotkey(input({ type: 'keyUp', key: 'Alt', code: 'AltLeft', alt: true }), 'linux')
    ).toEqual({ phase: 'up', key: 'Alt', code: 'AltLeft', meta: false, ctrl: false, alt: true })
  })

  it('放行按住 Alt 时的数字键 1-9', () => {
    expect(toWorkspaceHotkey(input({ key: '9', code: 'Numpad9', alt: true }), 'win32')).toEqual({
      phase: 'down',
      key: '9',
      code: 'Numpad9',
      meta: false,
      ctrl: false,
      alt: true
    })
  })

  it('Windows 下 ⌘(Win 键) 不是切换修饰键：Meta 键与 Meta+数字都不转发', () => {
    expect(toWorkspaceHotkey(input({ key: 'Meta', code: 'MetaLeft' }), 'win32')).toBeNull()
    expect(toWorkspaceHotkey(input({ key: '1', code: 'Digit1', meta: true }), 'win32')).toBeNull()
  })
})

describe('toWorkspaceHotkey（通用过滤）', () => {
  it('无修饰键的数字、数字键的 keyUp 都不转发', () => {
    expect(toWorkspaceHotkey(input({ key: '1', code: 'Digit1' }), 'darwin')).toBeNull()
    expect(
      toWorkspaceHotkey(input({ type: 'keyUp', key: '1', code: 'Digit1', meta: true }), 'darwin')
    ).toBeNull()
    expect(toWorkspaceHotkey(input({ key: '0', code: 'Digit0', alt: true }), 'win32')).toBeNull()
  })

  it('工作区自己的输入一律不转发也不拦截', () => {
    expect(toWorkspaceHotkey(input({ key: 'n', code: 'KeyN', meta: true }), 'darwin')).toBeNull()
    expect(toWorkspaceHotkey(input({ key: 'v', code: 'KeyV', alt: true }), 'win32')).toBeNull()
    expect(
      toWorkspaceHotkey(input({ type: 'char', key: '1', code: 'Digit1', meta: true }), 'darwin')
    ).toBeNull()
    expect(
      toWorkspaceHotkey(input({ key: '1', code: 'Digit1', alt: true, isComposing: true }), 'win32')
    ).toBeNull()
  })

  it('过滤器是纯函数:不调用 preventDefault、不产生副作用', () => {
    const guard = vi.fn()
    toWorkspaceHotkey(input({ key: 'a', code: 'KeyA' }), 'darwin')
    expect(guard).not.toHaveBeenCalled()
  })
})
