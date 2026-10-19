import { describe, expect, it } from 'vitest'
import { readPersistedView, writePersistedView, type ViewStorage } from './view-persistence'

/** 内存版存储；可选注入读/写异常，验证存储不可用时回落到总览。 */
function memoryStorage(initial?: string): ViewStorage & { raw: () => string | null } {
  let value = initial ?? null
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next
    },
    raw: () => value
  }
}

describe('刷新后要恢复的视图', () => {
  it('写入后可读回（详情页 / 设置页 / 总览）', () => {
    const storage = memoryStorage()

    writePersistedView(storage, { selection: 'inst-1', settingsOpen: false })
    expect(readPersistedView(storage)).toEqual({ selection: 'inst-1', settingsOpen: false })

    writePersistedView(storage, { selection: null, settingsOpen: true })
    expect(readPersistedView(storage)).toEqual({ selection: null, settingsOpen: true })

    writePersistedView(storage, { selection: null, settingsOpen: false })
    expect(readPersistedView(storage)).toEqual({ selection: null, settingsOpen: false })
  })

  it('缺失或损坏时回落到总览', () => {
    expect(readPersistedView(memoryStorage())).toEqual({ selection: null, settingsOpen: false })
    expect(readPersistedView(memoryStorage('不是 JSON'))).toEqual({
      selection: null,
      settingsOpen: false
    })
    expect(readPersistedView(memoryStorage('[]'))).toEqual({ selection: null, settingsOpen: false })
    expect(readPersistedView(memoryStorage('null'))).toEqual({
      selection: null,
      settingsOpen: false
    })
    // 字段类型不对：选中丢弃，settingsOpen 只认真正的 true。
    expect(readPersistedView(memoryStorage('{"selection":7,"settingsOpen":"yes"}'))).toEqual({
      selection: null,
      settingsOpen: false
    })
    expect(readPersistedView(memoryStorage('{"selection":"","settingsOpen":true}'))).toEqual({
      selection: null,
      settingsOpen: true
    })
  })

  it('存储读写抛错时读回总览、写不抛出', () => {
    const storage: ViewStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(readPersistedView(storage)).toEqual({ selection: null, settingsOpen: false })
    expect(() =>
      writePersistedView(storage, { selection: 'inst-1', settingsOpen: false })
    ).not.toThrow()
  })
})
