import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findPlaceholders,
  normalizeArtifactUrl,
  parseReleaseNotes,
  parseUpdateYaml,
  verifyUpdateMetadata,
  type UpdateMetadata
} from '../../scripts/release/lib.mjs'

/**
 * 发布元数据的**离线验证**。
 *
 * 发布相关的东西错在哪都很难发现:版本号漏改、发布说明与产物对不上、更新元数据里的
 * sha512 与实际字节不符 —— 这些在本地「看起来都正常」,只有用户更新失败时才会暴露。
 * 所以把能离线判定的部分放进 `pnpm test`,让它在每次提交时自动跑。
 *
 * 需要真实远端/证书的部分(签名、推送、自动更新闭环)刻意**不**在这里假装通过,
 * 由 `scripts/release/rehearse.mjs` 显式标 SKIP,并在本地发布演练文档(不进 git)记账。
 */

const ROOT = process.cwd()
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string
  dependencies?: Record<string, string>
  scripts: Record<string, string>
}
const version = pkg.version
const tag = `v${version}`

function readText(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

describe('版本与发布说明一致性', () => {
  it('package.json 版本是合法 semver', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })

  it('当前版本存在对应的发布说明，且版本号一致', () => {
    const notes = parseReleaseNotes(readText(`docs/releases/${tag}.md`))
    expect(notes.version).toBe(version)
    expect(notes.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(['source-only', 'windows-unsigned']).toContain(notes.distribution)
  })

  it('发布说明不含占位符', () => {
    expect(findPlaceholders(readText(`docs/releases/${tag}.md`))).toEqual([])
  })

  it('分发方式与资产清单自洽', () => {
    const notes = parseReleaseNotes(readText(`docs/releases/${tag}.md`))
    if (notes.distribution === 'source-only') {
      expect(notes.artifacts).toEqual([])
    } else {
      // windows-unsigned：必须声明当前版本的安装包，只允许安装包与校验清单
      expect(notes.artifacts).toContain(`DSH-Hub-Setup-${version}.exe`)
      for (const artifact of notes.artifacts) {
        expect(artifact).toMatch(/^(DSH-Hub-Setup-.*\.exe|SHA256SUMS\.txt)$/)
      }
    }
  })

  it('parseReleaseNotes 拒绝缺失或未知的分发模式', () => {
    const valid = [
      '# DSH Hub v1.2.3',
      '',
      '- 发布日期: 2026-09-18',
      '',
      '## 分发方式',
      '',
      '- `source-only`'
    ].join('\n')
    expect(parseReleaseNotes(valid)).toMatchObject({
      version: '1.2.3',
      distribution: 'source-only',
      artifacts: []
    })
    expect(() => parseReleaseNotes(valid.replace('- `source-only`', ''))).toThrow(/分发方式/)
    expect(() => parseReleaseNotes(valid.replace('source-only', 'signed-binary'))).toThrow(
      /分发方式/
    )
  })

  it('windows-unsigned 只接受安装包与校验清单，其它资产与缺失安装包一律拒绝', () => {
    const notesFor = (mode: string, artifacts: string[]): string =>
      [
        '# DSH Hub v1.2.3',
        '',
        '- 发布日期: 2026-09-18',
        '',
        '## 分发方式',
        '',
        `- \`${mode}\``,
        '',
        '## 产物',
        '',
        ...artifacts.map((name) => `- \`${name}\``)
      ].join('\n')

    // 合法：安装包 + 校验清单
    expect(
      parseReleaseNotes(notesFor('windows-unsigned', ['DSH-Hub-Setup-1.2.3.exe', 'SHA256SUMS.txt']))
    ).toMatchObject({
      distribution: 'windows-unsigned',
      artifacts: ['DSH-Hub-Setup-1.2.3.exe', 'SHA256SUMS.txt']
    })

    // 必须含安装包：只有校验清单时拒绝
    expect(() => parseReleaseNotes(notesFor('windows-unsigned', ['SHA256SUMS.txt']))).toThrow(
      /必须声明 Windows 安装包/
    )
    // mac 二进制 / zip / 自动更新元数据：任何模式都拒绝
    expect(() =>
      parseReleaseNotes(notesFor('windows-unsigned', ['DSH-Hub-Setup-1.2.3.exe', 'latest.yml']))
    ).toThrow(/不得声明资产/)
    expect(() => parseReleaseNotes(notesFor('windows-unsigned', ['DSH Hub-1.2.3.dmg']))).toThrow(
      /不得声明资产/
    )
    // 不在白名单内的资产拒绝
    expect(() =>
      parseReleaseNotes(notesFor('windows-unsigned', ['DSH-Hub-Setup-1.2.3.exe', 'notes.pdf']))
    ).toThrow(/只允许 Windows 安装包/)

    // source-only 声明安装包、校验和或更新元数据同样拒绝
    expect(() =>
      parseReleaseNotes(notesFor('source-only', ['DSH-Hub-Setup-1.2.3.exe', 'SHA256SUMS.txt']))
    ).toThrow(/不得声明资产|不得声明/)
    expect(() => parseReleaseNotes(notesFor('source-only', ['latest.yml']))).toThrow(/不得声明资产/)
    // 未知分发模式拒绝
    expect(() => parseReleaseNotes(notesFor('macos-signed', ['DSH-Hub-Setup-1.2.3.exe']))).toThrow(
      /分发方式/
    )
  })
})

describe('打包与发布配置', () => {
  const yml = readText('electron-builder.yml')

  it('electron-builder 不配置 GitHub publish provider', () => {
    expect(yml).not.toMatch(/^publish:\s*$/m)
    expect(yml).not.toMatch(/^\s*provider:\s*github\s*$/m)
    expect(yml).not.toMatch(/^\s*releaseType:\s*draft\s*$/m)
  })

  it('dist:mac 仅构建未封装的 macOS .app', () => {
    expect(yml).toMatch(/^\s*target:\s*\n\s*-\s*dir\s*$/m)
    expect(pkg.scripts['dist:mac']).toContain('electron-builder --mac dir')
  })

  it('本地打包脚本结构上不可能误发布', () => {
    for (const name of ['dist', 'dist:mac', 'dist:mac:zip', 'dist:win']) {
      expect(pkg.scripts[name], `缺少脚本 ${name}`).toBeTruthy()
      expect(pkg.scripts[name], `脚本 ${name} 必须带 --publish never`).toContain('--publish never')
    }
    // 发布只能通过 release 脚本显式进行
    expect(pkg.scripts['release:check']).toBeTruthy()
    expect(pkg.scripts['release:checksums']).toBeTruthy()
  })

  it('包内容白名单不含源码/测试/文档', () => {
    expect(yml).toMatch(/files:/)
    expect(yml).toMatch(/-\s*out\/\*\*/)
    expect(yml).not.toMatch(/-\s*src\/\*\*/)
    expect(yml).not.toMatch(/-\s*tests\/\*\*/)
    expect(yml).not.toMatch(/-\s*docs\/\*\*/)
  })

  it('使用设计稿生成的 macOS 与 Windows 应用图标', () => {
    expect(yml).toMatch(/^\s*icon:\s*build\/icon\.icns\s*$/m)
    expect(yml).toMatch(/^\s*icon:\s*build\/icon\.ico\s*$/m)
    expect(existsSync(join(ROOT, 'design', 'dsh-hub-logo.svg'))).toBe(true)
    expect(existsSync(join(ROOT, 'build', 'icon.icns'))).toBe(true)
    expect(existsSync(join(ROOT, 'build', 'icon.ico'))).toBe(true)
  })

  it('macOS 本地打包复用已安装的 Electron 分发包，不依赖下载', () => {
    expect(yml).toMatch(/^electronDist:\s*node_modules\/electron\/dist\s*$/m)
  })

  it('零运行时依赖', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([])
  })
})

describe('更新元数据解析与校验', () => {
  /** 与 electron-builder 实际产出同形态:注意 url 里的空格已被换成连字符 */
  const sampleYaml = [
    'version: 0.1.0',
    'files:',
    '  - url: DSH-Hub-0.1.0-arm64-mac.zip',
    '    sha512: AAAABBBB',
    '    size: 120994809',
    'path: DSH-Hub-0.1.0-arm64-mac.zip',
    'sha512: AAAABBBB',
    "releaseDate: '2026-09-15T20:24:52.305Z'"
  ].join('\n')

  it('解析 electron-builder 的更新元数据形态', () => {
    const metadata = parseUpdateYaml(sampleYaml)
    expect(metadata.version).toBe('0.1.0')
    expect(metadata.files).toHaveLength(1)
    expect(metadata.files[0]).toEqual({
      url: 'DSH-Hub-0.1.0-arm64-mac.zip',
      sha512: 'AAAABBBB',
      size: 120994809
    })
    expect(metadata.path).toBe('DSH-Hub-0.1.0-arm64-mac.zip')
    expect(metadata.sha512).toBe('AAAABBBB')
    expect(metadata.releaseDate).toBe('2026-09-15T20:24:52.305Z')
  })

  it('畸形/缺字段的元数据必须抛错而不是静默放行', () => {
    expect(() => parseUpdateYaml('')).toThrow()
    expect(() => parseUpdateYaml('files:\n  - url: a.zip\n    sha512: x\n')).toThrow(/version/)
    expect(() => parseUpdateYaml('version: 0.1.0\nfiles: []\n')).toThrow(/files/)
    expect(() => parseUpdateYaml('version: 0.1.0\nfiles:\n  - url: a.zip\n')).toThrow(/sha512/)
  })

  it('磁盘产物名带空格、元数据 url 带连字符时仍能对上', () => {
    // electron-builder 把空格换成连字符写进 URL,磁盘上是 'DSH Hub-0.1.0-arm64-mac.zip'
    expect(normalizeArtifactUrl('DSH-Hub-0.1.0-arm64-mac.zip')).toBe('DSH-Hub-0.1.0-arm64-mac.zip')
    expect(normalizeArtifactUrl('DSH%20Hub-0.1.0-arm64-mac.zip')).toBe(
      'DSH-Hub-0.1.0-arm64-mac.zip'
    )
    expect(normalizeArtifactUrl('https://example.com/x/DSH Hub-0.1.0.zip')).toBe(
      'DSH-Hub-0.1.0.zip'
    )

    const metadata = parseUpdateYaml(sampleYaml)
    const verdict = verifyUpdateMetadata({
      metadata,
      appVersion: '0.1.0',
      // 磁盘实测:原名带空格,sha512/size 与元数据一致
      artifacts: [{ name: 'DSH Hub-0.1.0-arm64-mac.zip', sha512: 'AAAABBBB', size: 120994809 }]
    })
    expect(verdict.problems).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('版本不一致 / sha512 不一致 / 产物缺失 / 顶层字段不一致 全部能被检出', () => {
    const metadata = parseUpdateYaml(sampleYaml)
    const good = [{ name: 'DSH-Hub-0.1.0-arm64-mac.zip', sha512: 'AAAABBBB', size: 120994809 }]

    const versionMismatch = verifyUpdateMetadata({
      metadata,
      appVersion: '0.2.0',
      artifacts: good
    })
    expect(versionMismatch.ok).toBe(false)
    expect(versionMismatch.problems.join()).toMatch(/版本不一致/)

    const hashMismatch = verifyUpdateMetadata({
      metadata,
      appVersion: '0.1.0',
      artifacts: [{ name: 'DSH-Hub-0.1.0-arm64-mac.zip', sha512: 'WRONG', size: 120994809 }]
    })
    expect(hashMismatch.ok).toBe(false)
    expect(hashMismatch.problems.join()).toMatch(/sha512 不匹配/)

    const sizeMismatch = verifyUpdateMetadata({
      metadata,
      appVersion: '0.1.0',
      artifacts: [{ name: 'DSH-Hub-0.1.0-arm64-mac.zip', sha512: 'AAAABBBB', size: 1 }]
    })
    expect(sizeMismatch.ok).toBe(false)
    expect(sizeMismatch.problems.join()).toMatch(/size 不匹配/)

    const missing = verifyUpdateMetadata({ metadata, appVersion: '0.1.0', artifacts: [] })
    expect(missing.ok).toBe(false)
    expect(missing.problems.join()).toMatch(/不存在的产物/)

    const topLevelBroken: UpdateMetadata = { ...metadata, path: 'other.zip' }
    const topLevel = verifyUpdateMetadata({
      metadata: topLevelBroken,
      appVersion: '0.1.0',
      artifacts: good
    })
    expect(topLevel.ok).toBe(false)
    expect(topLevel.problems.join()).toMatch(/顶层 path/)
  })
})

describe('已构建产物与更新元数据端到端自洽', () => {
  const distDir = join(ROOT, 'dist')
  const metadataPath = join(distDir, 'latest-mac.yml')
  const hasMetadata = existsSync(metadataPath)

  it.skipIf(!hasMetadata)('dist/latest-mac.yml 的 version/sha512/size 与实际产物一致', () => {
    const metadata = parseUpdateYaml(readFileSync(metadataPath, 'utf8'))
    const artifacts = metadata.files.map((entry) => {
      // 元数据 url 是「空格→连字符」形态,磁盘上是原名(含空格)。
      // 必须**扫描目录后按归一化名比对**,方向无关 —— 直接对 url 做空格替换是错的
      // (连字符形态里没有空格,替换等于没做)。
      const target = normalizeArtifactUrl(entry.url)
      const name = readdirSync(distDir).find(
        (candidate) => normalizeArtifactUrl(candidate) === target
      )
      expect(name, `元数据引用的产物在 dist/ 下不存在:${entry.url}`).toBeTruthy()
      const full = join(distDir, name!)
      const bytes = readFileSync(full)
      return {
        name: entry.url,
        sha512: createHash('sha512').update(bytes).digest('base64'),
        size: statSync(full).size
      }
    })
    const verdict = verifyUpdateMetadata({ metadata, appVersion: version, artifacts })
    expect(verdict.problems).toEqual([])
  })
})

describe('checksums 清单只收分发产物', () => {
  it('点文件与 builder 调试输出不入清单(手工下载者的校验和只引用会上传的文件)', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { collectArtifacts } = await import('../../scripts/release/checksums.mjs')
    const dir = mkdtempSync(join(tmpdir(), 'sums-exclude-'))
    // 应收录
    writeFileSync(join(dir, 'DSH Hub-0.1.0-arm64-mac.zip'), 'zip-bytes')
    writeFileSync(join(dir, 'latest-mac.yml'), 'yml')
    // 应排除:macOS 点文件 / builder 调试 / 差分中间产物 / 清单自身 / 目录
    writeFileSync(join(dir, '.DS_Store'), 'junk')
    writeFileSync(join(dir, 'builder-debug.yml'), 'debug')
    writeFileSync(join(dir, 'DSH Hub-0.1.0-arm64-mac.zip.blockmap'), 'diff')
    writeFileSync(join(dir, 'SHA256SUMS.txt'), 'self')
    mkdirSync(join(dir, 'mac-arm64'))
    const files = await collectArtifacts(dir)
    const names = files.map((file) => file.name)
    expect(names).toEqual(['DSH Hub-0.1.0-arm64-mac.zip', 'latest-mac.yml'])
  })
})
