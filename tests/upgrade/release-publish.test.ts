import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decideDraft,
  decideLocalTag,
  decideRemotePush,
  expectedAssets,
  parseSums,
  PublishError,
  verifyLocalAssets,
  verifyRemoteAssets
} from '../../scripts/release/publish.mjs'

/**
 * 半自动发布脚本的决策与校验逻辑。
 *
 * publish.mjs 会推 tag、建 Release、PATCH 发布——错哪一步都是线上事故，
 * 所以把「该做什么」的判定做成纯函数，连同本地资产校验一起进 pnpm test；
 * 真正执行远端动作的部分由 --dry-run 与人工确认兜底。
 */

const ROOT = process.cwd()
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string
  scripts: Record<string, string>
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

describe('release:publish 脚本注册', () => {
  it('package.json 提供 release:publish 且指向 publish.mjs', () => {
    expect(pkg.scripts['release:publish']).toBe('node scripts/release/publish.mjs')
  })

  it('publish.mjs 入库', () => {
    expect(existsSync(join(ROOT, 'scripts', 'release', 'publish.mjs'))).toBe(true)
  })

  it('publish.mjs 不以 hashbang 开头（CRLF 检出 + vite SSR 变换会把 #! 挤到文件中部）', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'release', 'publish.mjs'), 'utf8')
    expect(source.startsWith('#!')).toBe(false)
  })
})

describe('expectedAssets：分发方式 → 精确资产集合', () => {
  it('source-only 无任何资产', () => {
    expect(expectedAssets('source-only', '9.9.9')).toEqual([])
  })

  it('windows-unsigned 只有安装包与校验清单', () => {
    expect(expectedAssets('windows-unsigned', '9.9.9')).toEqual([
      'DSH-Hub-Setup-9.9.9.exe',
      'SHA256SUMS.txt'
    ])
  })

  it('未知分发方式拒绝', () => {
    expect(() => expectedAssets('dmg', '9.9.9')).toThrow(PublishError)
  })
})

describe('parseSums：校验清单解析', () => {
  it('解析 sha256␠␠文件名 行', () => {
    const map = parseSums(`${'a'.repeat(64)}  DSH-Hub-Setup-1.0.0.exe\n`)
    expect(map.get('DSH-Hub-Setup-1.0.0.exe')).toBe('a'.repeat(64))
  })

  it('形态错误的行拒绝', () => {
    expect(() => parseSums('xyz\n')).toThrow(PublishError)
  })

  it('重复条目拒绝', () => {
    const line = `${'a'.repeat(64)}  x.exe\n`
    expect(() => parseSums(line + line)).toThrow(/重复/)
  })

  it('空清单拒绝', () => {
    expect(() => parseSums('\n')).toThrow(PublishError)
  })
})

describe('verifyLocalAssets：本地资产校验', () => {
  const version = '9.9.9'
  const installer = `DSH-Hub-Setup-${version}.exe`

  function makeUploadDir(files: Record<string, string | Buffer>): string {
    const root = mkdtempSync(join(tmpdir(), 'publish-test-'))
    const dir = join(root, 'dist', 'upload')
    mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content)
    }
    return root
  }

  it('source-only 不需要任何文件', async () => {
    const root = makeUploadDir({})
    await expect(
      verifyLocalAssets({ root, version, distribution: 'source-only' })
    ).resolves.toEqual([])
  })

  it('安装包缺失时提示先构建', async () => {
    const root = makeUploadDir({ 'SHA256SUMS.txt': `${'a'.repeat(64)}  ${installer}\n` })
    await expect(
      verifyLocalAssets({ root, version, distribution: 'windows-unsigned' })
    ).rejects.toThrow(/dist:win:local/)
  })

  it('清单缺失时提示先生成', async () => {
    const root = makeUploadDir({ [installer]: Buffer.from('exe') })
    await expect(
      verifyLocalAssets({ root, version, distribution: 'windows-unsigned' })
    ).rejects.toThrow(/checksums\.mjs/)
  })

  it('清单没有该安装包条目时拒绝', async () => {
    const root = makeUploadDir({
      [installer]: Buffer.from('exe'),
      'SHA256SUMS.txt': `${'a'.repeat(64)}  other.exe\n`
    })
    await expect(
      verifyLocalAssets({ root, version, distribution: 'windows-unsigned' })
    ).rejects.toThrow(/没有.*条目/)
  })

  it('实测 sha256 与清单不一致时拒绝', async () => {
    const root = makeUploadDir({
      [installer]: Buffer.from('exe'),
      'SHA256SUMS.txt': `${'a'.repeat(64)}  ${installer}\n`
    })
    await expect(
      verifyLocalAssets({ root, version, distribution: 'windows-unsigned' })
    ).rejects.toThrow(/不一致/)
  })

  it('齐全且哈希一致时返回待上传文件', async () => {
    const body = Buffer.from('exe-bytes')
    const root = makeUploadDir({
      [installer]: body,
      'SHA256SUMS.txt': `${sha256(body)}  ${installer}\n`
    })
    const files = await verifyLocalAssets({ root, version, distribution: 'windows-unsigned' })
    expect(files.map((file) => basename(file))).toEqual([installer, 'SHA256SUMS.txt'])
  })
})

describe('tag 决策', () => {
  it('本地 tag 缺失 → 创建', () => {
    expect(decideLocalTag({ hasLocalTag: false, tagSha: null, headSha: 'aaa' })).toBe('create')
  })

  it('本地 tag 在 HEAD 上 → 保持', () => {
    expect(decideLocalTag({ hasLocalTag: true, tagSha: 'aaa', headSha: 'aaa' })).toBe('keep')
  })

  it('本地 tag 不在 HEAD 上 → 拒绝（同版本重发走 runbook §6）', () => {
    expect(() => decideLocalTag({ hasLocalTag: true, tagSha: 'old', headSha: 'aaa' })).toThrow(
      /runbook §6/
    )
  })

  it('远端 tag 缺失 → 推送', () => {
    expect(decideRemotePush({ remoteSha: null, localSha: 'aaa' })).toBe('push')
  })

  it('远端 tag 与本地一致 → 跳过', () => {
    expect(decideRemotePush({ remoteSha: 'aaa', localSha: 'aaa' })).toBe('skip')
  })

  it('远端 tag 与本地不一致 → 拒绝', () => {
    expect(() => decideRemotePush({ remoteSha: 'other', localSha: 'aaa' })).toThrow(/不一致/)
  })
})

describe('Release 状态决策', () => {
  it('Release 不存在 → 创建 draft', () => {
    expect(decideDraft(null, 'v9.9.9')).toBe('create')
  })

  it('已是 draft → 更新', () => {
    expect(decideDraft({ id: 1, draft: true, assets: [] }, 'v9.9.9')).toBe('update')
  })

  it('已发布 → 拒绝（不删 Release 重发同版本）', () => {
    expect(() => decideDraft({ id: 1, draft: false, assets: [] }, 'v9.9.9')).toThrow(/patch/)
  })
})

describe('verifyRemoteAssets：远端资产白名单', () => {
  const version = '9.9.9'
  const full = ['DSH-Hub-Setup-9.9.9.exe', 'SHA256SUMS.txt'] as const

  it('与分发方式完全一致 → 通过', () => {
    expect(verifyRemoteAssets('windows-unsigned', version, [...full].reverse()).sort()).toEqual(
      [...full].sort()
    )
  })

  it('source-only 出现任何资产 → 拒绝', () => {
    expect(() => verifyRemoteAssets('source-only', version, ['DSH-Hub-Setup-9.9.9.exe'])).toThrow(
      /多出/
    )
  })

  it('缺资产 → 拒绝', () => {
    expect(() => verifyRemoteAssets('windows-unsigned', version, [full[0]])).toThrow(/缺少/)
  })

  it('多资产（mac 产物 / 更新元数据）→ 拒绝', () => {
    expect(() =>
      verifyRemoteAssets('windows-unsigned', version, [...full, 'latest.yml', 'x.dmg'])
    ).toThrow(/多出/)
  })
})
