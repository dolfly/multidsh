import { describe, expect, it } from 'vitest'
import type { PluginInfo } from '@shared/contracts'
import {
  classifyPluginSpec,
  installedVersionOf,
  isVersionLiteral,
  pickTargetVersion,
  specMatchesName,
  splitNpmSpec
} from './plugin-spec'

/**
 * npm 安装 spec 的形态分类、拆解与目标版本挑选。
 *
 * 重点守卫两条线：
 * - **scoped 包名的 `@` 属于包名**：`@scope/pkg@1.0.0` 的版本段在第二个 `@` 之后。
 * - **版本挑选必须数字感知**：versions 数组不保证按版本序排列，取末位会装到旧版；
 *   预发布后缀内的数字段也按数值比（`rc10` > `rc9`）。
 */

describe('classifyPluginSpec', () => {
  it('npm 形态是缺省', () => {
    expect(classifyPluginSpec('demo-plugin')).toBe('npm')
    expect(classifyPluginSpec('@scope/pkg')).toBe('npm')
    expect(classifyPluginSpec('demo-plugin@1.0.0')).toBe('npm')
  })

  it('github 形态', () => {
    expect(classifyPluginSpec('github:owner/repo')).toBe('github')
    expect(classifyPluginSpec('git+https://github.com/owner/repo.git')).toBe('github')
    expect(classifyPluginSpec('git@github.com:owner/repo.git')).toBe('github')
  })

  it('file 形态', () => {
    expect(classifyPluginSpec('file:../local-plugin')).toBe('file')
  })
})

describe('splitNpmSpec', () => {
  it('无版本段 → requested 为 null', () => {
    expect(splitNpmSpec('demo-plugin')).toEqual({ name: 'demo-plugin', requested: null })
  })

  it('有版本段 → 拆出包名与版本', () => {
    expect(splitNpmSpec('demo-plugin@1.0.0')).toEqual({ name: 'demo-plugin', requested: '1.0.0' })
    expect(splitNpmSpec('demo-plugin@next')).toEqual({ name: 'demo-plugin', requested: 'next' })
  })

  it('scoped 包名的首个 @ 属于包名，版本段在第二个 @ 之后', () => {
    expect(splitNpmSpec('@scope/pkg')).toEqual({ name: '@scope/pkg', requested: null })
    expect(splitNpmSpec('@scope/pkg@1.0.0')).toEqual({ name: '@scope/pkg', requested: '1.0.0' })
  })

  it('版本段为空（尾随 @）按未指定处理', () => {
    expect(splitNpmSpec('demo-plugin@')).toEqual({ name: 'demo-plugin', requested: null })
  })
})

describe('isVersionLiteral', () => {
  it('数字开头或含点 = 精确版本', () => {
    expect(isVersionLiteral('1.0.0')).toBe(true)
    expect(isVersionLiteral('1')).toBe(true)
    expect(isVersionLiteral('1.0.0-rc.2')).toBe(true)
  })

  it('其余按 dist-tag 处理', () => {
    expect(isVersionLiteral('latest')).toBe(false)
    expect(isVersionLiteral('next')).toBe(false)
    expect(isVersionLiteral('beta')).toBe(false)
  })
})

describe('pickTargetVersion', () => {
  it('dist-tag 滞后时取最大稳定版（不装旧版）', () => {
    expect(pickTargetVersion(['1.0.0', '1.0.10', '1.0.9', '1.1.0'], '1.0.0', null)).toBe('1.1.0')
  })

  it('versions 数组乱序时同样取最大（不取末位）', () => {
    expect(pickTargetVersion(['1.0.10', '1.0.9', '1.0.0'], null, null)).toBe('1.0.10')
  })

  it('dist-tag 比最大稳定版新时取 dist-tag', () => {
    expect(pickTargetVersion(['1.0.0'], '2.0.0', null)).toBe('2.0.0')
  })

  it('全是预发布时取最大预发布（数字感知，rc10 > rc2）', () => {
    expect(pickTargetVersion(['1.0.0-rc2', '1.0.0-rc10'], null, null)).toBe('1.0.0-rc10')
  })

  it('候选为空时回落 fallback', () => {
    expect(pickTargetVersion([], null, '0.9.0')).toBe('0.9.0')
    expect(pickTargetVersion([], null, null)).toBeNull()
  })

  it('预发布不参与稳定版挑选', () => {
    // 2.0.0-rc1 是预发布，稳定版只有 1.0.0 → 取 1.0.0。
    expect(pickTargetVersion(['1.0.0', '2.0.0-rc1'], '1.0.0', null)).toBe('1.0.0')
  })
})

describe('installedVersionOf', () => {
  const plugins = [
    { name: 'demo-plugin', version: '1.0.0' },
    { name: 'other', version: '2.0.0' }
  ] as PluginInfo[]

  it('取到同名插件的版本', () => {
    expect(installedVersionOf(plugins, 'demo-plugin')).toBe('1.0.0')
  })

  it('未安装 → null', () => {
    expect(installedVersionOf(plugins, 'missing')).toBeNull()
  })

  it('版本未知（列表里的占位符）→ null', () => {
    const unknown = [{ name: 'demo-plugin', version: '—' }] as PluginInfo[]
    expect(installedVersionOf(unknown, 'demo-plugin')).toBeNull()
  })
})

describe('specMatchesName', () => {
  it('spec 与包名相等', () => {
    expect(specMatchesName('demo-plugin', 'demo-plugin')).toBe(true)
  })

  it('spec 带版本段', () => {
    expect(specMatchesName('demo-plugin@1.0.0', 'demo-plugin')).toBe(true)
  })

  it('scoped 包名带版本段（末个 @ 之前是包名）', () => {
    expect(specMatchesName('@scope/pkg@1.0.0', '@scope/pkg')).toBe(true)
  })

  it('不同包名不匹配', () => {
    expect(specMatchesName('other-plugin', 'demo-plugin')).toBe(false)
  })

  it('宽松匹配：spec 以包名结尾（github/file 形态无法精确得包名）', () => {
    expect(specMatchesName('github:owner/demo-plugin', 'demo-plugin')).toBe(true)
    expect(specMatchesName('file:../demo-plugin', 'demo-plugin')).toBe(true)
  })
})
