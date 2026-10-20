import { describe, expect, it } from 'vitest'
import {
  authorName,
  defaultReadIcon,
  defaultReadLocale,
  defaultReadManifest,
  infoFromPath,
  installSourceOf,
  svgDataUri,
  type PluginInfoReaders,
  type PluginManifest
} from './plugin-info'

/**
 * 插件 manifest / list 输出的读取与字段装配。
 *
 * 重点守卫三条线：
 * - **locale 覆盖**：locale/<lang>.json 的 meta 覆盖 package.json 的英文原值；缺失回落原值。
 * - **安装来源判定**：from / version / resolved 三个字段的组合决定 npm / github / file / unknown。
 * - **enabled 的语义**：只有含 host 半（dsh.bundle.patch）的插件才由 bundles 决定加载与否；
 *   纯 client 插件无法单独禁用 → null（不是 false）。
 */

/** 内存版读取器：按目录给出 manifest / icon / locale。 */
function readersOf(options: {
  manifest?: PluginManifest | null
  icon?: string | null
  locale?: { meta?: { title?: string; description?: string } } | null
}): PluginInfoReaders {
  return {
    readManifest: () => options.manifest ?? null,
    readIcon: () => options.icon ?? null,
    readLocale: () => options.locale ?? null
  }
}

describe('authorName', () => {
  it('字符串形式', () => {
    expect(authorName('demo-author')).toBe('demo-author')
    expect(authorName('  demo-author  ')).toBe('demo-author')
  })

  it('对象形式的 name 字段', () => {
    expect(authorName({ name: 'demo-author', email: 'a@b.c' })).toBe('demo-author')
  })

  it('空串 / 无 name / 非对象 → null', () => {
    expect(authorName('')).toBeNull()
    expect(authorName('   ')).toBeNull()
    expect(authorName({})).toBeNull()
    expect(authorName({ name: '' })).toBeNull()
    expect(authorName(null)).toBeNull()
    expect(authorName(42)).toBeNull()
  })
})

describe('installSourceOf', () => {
  it('resolved 指向 registry → npm', () => {
    expect(
      installSourceOf({
        from: 'demo-plugin',
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/x'
      })
    ).toBe('npm')
  })

  it('from 以 github: / git+ / git@ 开头 → github', () => {
    expect(installSourceOf({ from: 'github:owner/repo' })).toBe('github')
    expect(installSourceOf({ from: 'git+https://github.com/owner/repo.git' })).toBe('github')
    expect(installSourceOf({ from: 'git@github.com:owner/repo.git' })).toBe('github')
  })

  it('from 含 github.com → github', () => {
    expect(installSourceOf({ from: 'https://github.com/owner/repo' })).toBe('github')
  })

  it('file: / link: → file', () => {
    expect(installSourceOf({ from: 'file:../local' })).toBe('file')
    expect(installSourceOf({ from: 'link:../local' })).toBe('file')
  })

  it('无 resolved 但有普通语义化 version → npm', () => {
    expect(installSourceOf({ from: 'demo-plugin', version: '1.0.0' })).toBe('npm')
  })

  it('信息不足 → unknown', () => {
    expect(installSourceOf({})).toBe('unknown')
    expect(installSourceOf({ version: 'owner/repo' })).toBe('unknown')
  })
})

describe('svgDataUri', () => {
  it('base64 → data-uri', () => {
    expect(svgDataUri('PHN2Zz48L3N2Zz4=')).toBe('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
  })

  it('null → null（列表不带图标）', () => {
    expect(svgDataUri(null)).toBeNull()
  })
})

describe('默认读取器', () => {
  it('读不到 / 不可解析时按 null（列表降级，不报错）', () => {
    expect(defaultReadManifest('/不存在的路径/xyz')).toBeNull()
    expect(defaultReadIcon('/不存在的路径/icon.svg')).toBeNull()
    expect(defaultReadLocale('/不存在的路径/locale.json')).toBeNull()
  })
})

describe('infoFromPath', () => {
  const manifest: PluginManifest = {
    name: 'demo-plugin',
    version: '1.0.0',
    description: '英文简介',
    author: 'demo-author',
    license: 'MIT',
    homepage: 'https://github.com/demo/demo-plugin',
    dependencies: { 'left-pad': '^1.0.0' },
    peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
    engines: { node: '>=20' },
    icon: 'icon.svg',
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }
  }

  it('装配基础字段', () => {
    const info = infoFromPath(
      readersOf({ manifest }),
      'demo-plugin',
      { from: 'demo-plugin', version: '1.0.0', resolved: 'https://registry.npmjs.org/x' },
      '/tmp/profile/node_modules',
      'zh',
      null
    )
    expect(info.name).toBe('demo-plugin')
    expect(info.version).toBe('1.0.0')
    expect(info.author).toBe('demo-author')
    expect(info.license).toBe('MIT')
    expect(info.description).toBe('英文简介')
    expect(info.dependencies).toEqual(['left-pad'])
    expect(info.dshPeer).toBe('>=0.1.7-rc.2')
    expect(info.nodeEngine).toBe('>=20')
    expect(info.npmUrl).toBe('https://www.npmjs.com/package/demo-plugin')
    expect(info.githubUrl).toBe('https://github.com/demo/demo-plugin')
    expect(info.installSource).toBe('npm')
    expect(info.hasHostSide).toBe(true)
    expect(info.hasClientSide).toBe(true)
  })

  it('locale 的 title / description 覆盖 package.json 原值', () => {
    const info = infoFromPath(
      readersOf({
        manifest,
        locale: { meta: { title: '示例插件', description: '中文简介' } }
      }),
      'demo-plugin',
      { version: '1.0.0' },
      '/tmp/profile/node_modules',
      'zh',
      null
    )
    expect(info.title).toBe('示例插件')
    expect(info.description).toBe('中文简介')
  })

  it('locale 缺失时回落 package.json 原值', () => {
    const info = infoFromPath(
      readersOf({ manifest, locale: null }),
      'demo-plugin',
      { version: '1.0.0' },
      '/tmp/profile/node_modules',
      'zh',
      null
    )
    expect(info.title).toBeNull()
    expect(info.description).toBe('英文简介')
  })

  it('locale 的 title 为空白串时按缺失处理', () => {
    const info = infoFromPath(
      readersOf({ manifest, locale: { meta: { title: '   ' } } }),
      'demo-plugin',
      { version: '1.0.0' },
      '/tmp/profile/node_modules',
      'zh',
      null
    )
    expect(info.title).toBeNull()
  })

  it('含 host 半时 enabled 由 bundles 决定', () => {
    const withBundles = (bundles: readonly string[] | null): boolean | null =>
      infoFromPath(
        readersOf({ manifest }),
        'demo-plugin',
        { version: '1.0.0' },
        '/tmp/profile/node_modules',
        'zh',
        bundles
      ).enabled
    expect(withBundles(['demo-plugin'])).toBe(true)
    expect(withBundles(['other'])).toBe(false)
    // bundles 未知（null）时按已启用处理。
    expect(withBundles(null)).toBe(true)
  })

  it('纯 client 插件的 enabled 为 null（无法单独禁用，不是 false）', () => {
    const clientOnly: PluginManifest = { name: 'client-only', dsh: { client: { platform: 'web' } } }
    const info = infoFromPath(
      readersOf({ manifest: clientOnly }),
      'client-only',
      { version: '1.0.0' },
      '/tmp/profile/node_modules',
      'zh',
      ['client-only']
    )
    expect(info.hasHostSide).toBe(false)
    expect(info.hasClientSide).toBe(true)
    expect(info.enabled).toBeNull()
  })

  it('版本优先取列表给出的值，其次 manifest，都没有时用占位符', () => {
    const withEntry = infoFromPath(
      readersOf({ manifest }),
      'demo-plugin',
      { version: '2.0.0' },
      '/tmp/profile/node_modules',
      'zh',
      null
    )
    expect(withEntry.version).toBe('2.0.0')

    const withoutEntry = infoFromPath(
      readersOf({ manifest }),
      'demo-plugin',
      {},
      '/tmp/profile/node_modules',
      'zh',
      null
    )
    expect(withoutEntry.version).toBe('1.0.0')

    const noManifest = infoFromPath(
      readersOf({ manifest: null }),
      'demo-plugin',
      {},
      '/tmp/profile/node_modules',
      'zh',
      null
    )
    expect(noManifest.version).toBe('—')
  })

  it('manifest 缺失时字段按缺省处理，不抛错', () => {
    const info = infoFromPath(
      readersOf({ manifest: null }),
      'demo-plugin',
      { version: '1.0.0' },
      '/tmp/profile/node_modules',
      'zh',
      null
    )
    expect(info.author).toBeNull()
    expect(info.license).toBeNull()
    expect(info.dependencies).toEqual([])
    expect(info.dshPeer).toBeNull()
    expect(info.iconDataUri).toBeNull()
    expect(info.publishedAt).toBeNull()
  })

  it('icon 读不到时 iconDataUri 为 null', () => {
    const info = infoFromPath(
      readersOf({ manifest, icon: null }),
      'demo-plugin',
      { version: '1.0.0' },
      '/tmp/profile/node_modules',
      'zh',
      null
    )
    expect(info.iconDataUri).toBeNull()
  })

  it('icon 读到时给出 data-uri', () => {
    const info = infoFromPath(
      readersOf({ manifest, icon: 'PHN2Zz48L3N2Zz4=' }),
      'demo-plugin',
      { version: '1.0.0' },
      '/tmp/profile/node_modules',
      'zh',
      null
    )
    expect(info.iconDataUri).toBe('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
  })
})
