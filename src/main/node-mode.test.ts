import { describe, expect, it } from 'vitest'
import { resolveNodeModeCommand } from './node-mode'

describe('resolveNodeModeCommand（ELECTRON_RUN_AS_NODE 可执行文件选择）', () => {
  it('darwin：有 Helper 时用 Helper（避免 Dock 图标闪现）', () => {
    expect(
      resolveNodeModeCommand(
        'darwin',
        '/App.app/Contents/MacOS/App',
        '/App.app/Contents/Frameworks/App Helper.app/Contents/MacOS/App Helper'
      )
    ).toBe('/App.app/Contents/Frameworks/App Helper.app/Contents/MacOS/App Helper')
  })

  it('darwin：无 Helper 时回落主二进制', () => {
    expect(resolveNodeModeCommand('darwin', '/App.app/Contents/MacOS/App', undefined)).toBe(
      '/App.app/Contents/MacOS/App'
    )
    expect(resolveNodeModeCommand('darwin', '/App.app/Contents/MacOS/App', '')).toBe(
      '/App.app/Contents/MacOS/App'
    )
  })

  it('非 darwin：一律用主二进制（Helper 概念仅存于 macOS）', () => {
    expect(resolveNodeModeCommand('win32', 'C:\\App\\electron.exe', 'C:\\App\\helper.exe')).toBe(
      'C:\\App\\electron.exe'
    )
    expect(resolveNodeModeCommand('linux', '/usr/bin/electron', '/x/helper')).toBe(
      '/usr/bin/electron'
    )
  })
})
