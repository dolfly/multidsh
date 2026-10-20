import { describe, expect, it } from 'vitest'
import { InstanceStoreError } from '../registry/instance-store'
import {
  isRegistryNotFound,
  parseViewMeta,
  peerMapOf,
  publishedAtOf,
  publishedTimeMap,
  recordOf,
  stringArrayOf
} from './plugin-view-meta'

/**
 * `dsh plugin view … --json` 输出的解析。
 *
 * 重点守卫两条历史上出过问题的线：
 * - **输出形状随查询字段而变**：多字段查询把 time 嵌套在 `time` 键下，仅查 time 时是裸映射。
 *   `publishedTimeMap` 必须两种形状都认（此前按嵌套形状解析，线上必现发布时间为空）。
 * - **registry 未收录的判据**：404 识别成 not-found，其余错误照旧上抛。
 */

describe('parseViewMeta', () => {
  it('解析对象输出', () => {
    expect(parseViewMeta('{"version":"1.0.0"}')).toEqual({ version: '1.0.0' })
  })

  it('空输出按空对象处理', () => {
    expect(parseViewMeta('')).toEqual({})
  })

  it('不可解析的输出 → internal 错误（给不出计划就不静默降级）', () => {
    expect(() => parseViewMeta('not json')).toThrow(InstanceStoreError)
    try {
      parseViewMeta('not json')
    } catch (error) {
      expect((error as InstanceStoreError).code).toBe('internal')
    }
  })

  it('数组与标量输出 → internal 错误', () => {
    for (const stdout of ['[]', '"str"', '123', 'null']) {
      expect(() => parseViewMeta(stdout)).toThrow(InstanceStoreError)
    }
  })
})

describe('publishedTimeMap', () => {
  it('认裸映射（仅查 time 时的输出形状）', () => {
    // 裸映射里含 created/modified 两项，按键取版本值时天然跳过。
    const stdout = JSON.stringify({
      '1.0.0': '2026-09-20T02:30:00.000Z',
      created: 'x',
      modified: 'y'
    })
    expect(publishedTimeMap(stdout)).toEqual({
      '1.0.0': '2026-09-20T02:30:00.000Z',
      created: 'x',
      modified: 'y'
    })
  })

  it('认嵌套在 time 键下的形状（多字段查询的输出形状）', () => {
    const stdout = JSON.stringify({
      version: '1.0.0',
      time: { '1.0.0': '2026-09-20T02:30:00.000Z' }
    })
    expect(publishedTimeMap(stdout)).toEqual({ '1.0.0': '2026-09-20T02:30:00.000Z' })
  })

  it('解析失败或不是对象 → null（调用方按「取不到」处理）', () => {
    expect(publishedTimeMap('not json')).toBeNull()
    expect(publishedTimeMap('[]')).toBeNull()
    expect(publishedTimeMap('null')).toBeNull()
  })

  it('time 键存在但不是对象时按裸映射处理', () => {
    const stdout = JSON.stringify({ time: 'oops', '1.0.0': '2026-09-20T02:30:00.000Z' })
    expect(publishedTimeMap(stdout)).toEqual({ time: 'oops', '1.0.0': '2026-09-20T02:30:00.000Z' })
  })
})

describe('publishedAtOf', () => {
  it('取到该版本的时刻', () => {
    expect(publishedAtOf({ '1.0.0': '2026-09-20T02:30:00.000Z' }, '1.0.0')).toBe(
      '2026-09-20T02:30:00.000Z'
    )
  })

  it('版本缺失 / 空串 / 非字符串 → null', () => {
    expect(publishedAtOf({ '1.0.0': 'x' }, '2.0.0')).toBeNull()
    expect(publishedAtOf({ '1.0.0': '' }, '1.0.0')).toBeNull()
    expect(publishedAtOf(null, '1.0.0')).toBeNull()
  })
})

describe('peerMapOf', () => {
  it('取 peerDependencies', () => {
    expect(peerMapOf({ peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } })).toEqual({
      '@deepseek-ai/dsh': '>=0.2.0'
    })
  })

  it('字段缺失或形态异常 → 空对象（无约束）', () => {
    expect(peerMapOf({})).toEqual({})
    expect(peerMapOf({ peerDependencies: null })).toEqual({})
    expect(peerMapOf({ peerDependencies: [] })).toEqual({})
    expect(peerMapOf({ peerDependencies: 'x' })).toEqual({})
  })
})

describe('stringArrayOf', () => {
  it('取字符串数组', () => {
    expect(stringArrayOf(['1.0.0', '1.1.0'])).toEqual(['1.0.0', '1.1.0'])
  })

  it('空串与非字符串项被忽略', () => {
    expect(stringArrayOf(['1.0.0', '', 123, null, '2.0.0'])).toEqual(['1.0.0', '2.0.0'])
  })

  it('非数组 → 空数组', () => {
    expect(stringArrayOf('1.0.0')).toEqual([])
    expect(stringArrayOf(null)).toEqual([])
    expect(stringArrayOf(undefined)).toEqual([])
  })
})

describe('recordOf', () => {
  it('取对象字段', () => {
    expect(recordOf({ latest: '1.0.0' })).toEqual({ latest: '1.0.0' })
  })

  it('形态不符 → 空对象', () => {
    expect(recordOf([])).toEqual({})
    expect(recordOf(null)).toEqual({})
    expect(recordOf('x')).toEqual({})
  })
})

describe('isRegistryNotFound', () => {
  it('认出 404 / Not Found / ERR_PNPM_FETCH_404', () => {
    for (const message of ['404', 'Not Found', 'ERR_PNPM_FETCH_404', '请求失败 404']) {
      expect(isRegistryNotFound(new InstanceStoreError('internal', message)), message).toBe(true)
    }
  })

  it('其它错误不算未收录', () => {
    expect(isRegistryNotFound(new InstanceStoreError('io-error', '网络不通'))).toBe(false)
    expect(isRegistryNotFound(new Error('404'))).toBe(false)
    expect(isRegistryNotFound('404')).toBe(false)
    expect(isRegistryNotFound(null)).toBe(false)
  })
})
