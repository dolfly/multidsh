/**
 * E2E 数据目录隔离的守卫。
 *
 * 背景：真实 userData 里有用户保存的实例、凭据与设置。一旦某个 spec 忘了注入
 * `DSH_HUB_DATA_DIR`（或把 DATA_DIR 解析到真实目录），用例就会读写甚至清空真实数据。
 * 这里把「只允许 hub-data/e2e-*」固化成可执行的断言，改坏时在单测阶段就红。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { E2E_DATA_ROOT, e2eDataDir, e2eEnv } from './data-dir'

const SPEC_DIR = join(process.cwd(), 'tests', 'e2e')

function readSpecs(): Array<{ file: string; source: string }> {
  return readdirSync(SPEC_DIR)
    .filter((name) => name.endsWith('.spec.ts'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(SPEC_DIR, file), 'utf8') }))
}

describe('e2eDataDir', () => {
  it('把一级目录名解析到 hub-data 下', () => {
    expect(e2eDataDir('e2e-smoke')).toBe(join(E2E_DATA_ROOT, 'e2e-smoke'))
  })

  it('拒绝带路径分隔符或越级的名字', () => {
    for (const name of ['', '.', '..', '../outside', 'nested/dir', `nested${join('a', 'b')}`]) {
      expect(() => e2eDataDir(name), name).toThrow(/hub-data/)
    }
  })
})

describe('e2eEnv', () => {
  it('注入 DSH_HUB_DATA_DIR 并保留进程环境与附加变量', () => {
    const env = e2eEnv(e2eDataDir('e2e-smoke'), { DSH_E2E_PLUGIN_INCOMPAT: '1' })
    expect(env['DSH_HUB_DATA_DIR']).toBe(join(E2E_DATA_ROOT, 'e2e-smoke'))
    expect(env['DSH_E2E_PLUGIN_INCOMPAT']).toBe('1')
    expect(env['PATH']).toBe(process.env['PATH'])
  })

  it('附加变量无法把数据目录改到 hub-data 之外', () => {
    const env = e2eEnv(e2eDataDir('e2e-smoke'), { DSH_HUB_DATA_DIR: '/tmp/elsewhere' })
    expect(env['DSH_HUB_DATA_DIR']).toBe(join(E2E_DATA_ROOT, 'e2e-smoke'))
  })

  it('值为 undefined 的附加键被删除（用于撤掉 CI 预设开关）', () => {
    const env = e2eEnv(e2eDataDir('e2e-smoke'), { DSH_HUB_E2E_DECLINE_DOWNLOAD: undefined })
    expect(env).not.toHaveProperty('DSH_HUB_E2E_DECLINE_DOWNLOAD')
  })

  it('拒绝 hub-data 之外的目录', () => {
    expect(() => e2eEnv('/tmp/not-hub-data')).toThrow(/hub-data/)
    expect(() => e2eEnv(E2E_DATA_ROOT)).toThrow(/hub-data/)
  })
})

describe('spec 文件', () => {
  const specs = readSpecs()

  it('全部走 e2eDataDir 声明数据目录', () => {
    expect(specs.length).toBeGreaterThan(10)
    for (const { file, source } of specs) {
      expect(source, `${file} 必须用 e2eDataDir 声明数据目录`).toContain('e2eDataDir(')
    }
  })

  it('不再手写 hub-data 路径', () => {
    for (const { file, source } of specs) {
      expect(source, `${file} 不应手写 hub-data 路径`).not.toMatch(/resolve\([^)]*'hub-data'/)
    }
  })

  it('每个 electron.launch 都经 e2eEnv 注入数据目录', () => {
    for (const { file, source } of specs) {
      const lines = source.split('\n')
      lines.forEach((line, index) => {
        if (!line.includes('electron.launch(')) return
        const callSite = lines.slice(index, index + 8).join('\n')
        expect(
          callSite,
          `${file}:${index + 1} 的 electron.launch 必须用 env: e2eEnv(...)`
        ).toContain('env: e2eEnv(')
      })
    }
  })

  it('没有任何 spec 指向真实 userData', () => {
    for (const { file, source } of specs) {
      expect(source, `${file} 不应引用真实 userData`).not.toContain('Application Support')
      expect(source, `${file} 不应把 homedir 当数据目录`).not.toMatch(
        /(DATA_DIR|dataDir)\s*=\s*[^\n]*homedir\(/
      )
    }
  })
})
