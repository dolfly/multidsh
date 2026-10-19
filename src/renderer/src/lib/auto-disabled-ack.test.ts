import { describe, expect, it, vi } from 'vitest'
import {
  ackAutoDisabled,
  isAutoDisabledAcked,
  readAutoDisabledAcks,
  type AckStorage
} from './auto-disabled-ack'

/** 内存版存储；可选注入读/写异常，验证存储不可用时不影响调用方。 */
function memoryStorage(initial?: string): AckStorage & { raw: () => string | null } {
  let value = initial ?? null
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next
    },
    raw: () => value
  }
}

describe('自动禁用提示的确认记录', () => {
  it('未确认 / 版本不一致时都不算已确认', () => {
    const storage = memoryStorage()
    expect(isAutoDisabledAcked(storage, 'inst-1', '0.2.0-rc.2')).toBe(false)

    ackAutoDisabled(storage, 'inst-1', '0.2.0-rc.2')
    expect(isAutoDisabledAcked(storage, 'inst-1', '0.2.0-rc.2')).toBe(true)
    // 新的 dsh 版本 = 新的自动禁用批次，需要重新确认。
    expect(isAutoDisabledAcked(storage, 'inst-1', '0.3.0')).toBe(false)
    // 其它实例各自独立。
    expect(isAutoDisabledAcked(storage, 'inst-2', '0.2.0-rc.2')).toBe(false)
  })

  it('确认覆盖同实例的旧版本，且不影响其它实例', () => {
    const storage = memoryStorage()
    ackAutoDisabled(storage, 'inst-1', '0.2.0-rc.2')
    ackAutoDisabled(storage, 'inst-2', '0.2.0-rc.2')
    ackAutoDisabled(storage, 'inst-1', '0.3.0')

    expect(readAutoDisabledAcks(storage)).toEqual({ 'inst-1': '0.3.0', 'inst-2': '0.2.0-rc.2' })
    expect(isAutoDisabledAcked(storage, 'inst-1', '0.2.0-rc.2')).toBe(false)
    expect(isAutoDisabledAcked(storage, 'inst-1', '0.3.0')).toBe(true)
  })

  it('记录损坏时视为没确认过（宁可再提示一次），并丢弃非法条目', () => {
    expect(readAutoDisabledAcks(memoryStorage('不是 JSON'))).toEqual({})
    expect(readAutoDisabledAcks(memoryStorage('[1,2]'))).toEqual({})
    expect(readAutoDisabledAcks(memoryStorage('null'))).toEqual({})
    expect(
      readAutoDisabledAcks(memoryStorage('{"inst-1":"","inst-2":3,"inst-3":"0.2.0"}'))
    ).toEqual({
      'inst-3': '0.2.0'
    })
    expect(isAutoDisabledAcked(memoryStorage('{}'), 'inst-1', '0.2.0')).toBe(false)
  })

  it('存储读写抛错时读视为未确认、写不抛出（只影响下次是否再提示）', () => {
    const storage: AckStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(readAutoDisabledAcks(storage)).toEqual({})
    expect(() => ackAutoDisabled(storage, 'inst-1', '0.2.0')).not.toThrow()
  })

  it('只读一次即可判定（不重复读存储）', () => {
    const storage = memoryStorage()
    const spy = vi.spyOn(storage, 'getItem')
    ackAutoDisabled(storage, 'inst-1', '0.2.0')
    expect(isAutoDisabledAcked(storage, 'inst-1', '0.2.0')).toBe(true)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
