import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLUGIN_REGISTRY,
  DEFAULT_SETTINGS,
  isAllowedNpmRegistry,
  normalizeSettings,
  pluginRegistryFromUrl,
  pluginRegistryUrl,
  registryPresetKey,
  resolveLanguage,
  sanitizeEnvRegistry,
  SettingsSchema
} from './settings'

describe('settings（非敏感偏好）', () => {
  it('默认值:跟随系统语言与主题、不驻留托盘、不自启、开通知', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      language: 'system',
      theme: 'system',
      tray: false,
      autoStart: false,
      notifications: true,
      preventSleepWhenRunning: false,
      workspaceCacheSize: 3,
      inheritShellEnv: true,
      npmRegistry: ''
    })
  })

  it('resolveLanguage:显式偏好优先,缺失时按系统语言推断', () => {
    expect(resolveLanguage('zh', 'en-US')).toBe('zh')
    expect(resolveLanguage('en', 'zh-CN')).toBe('en')
    expect(resolveLanguage('system', 'zh-CN')).toBe('zh')
    expect(resolveLanguage('system', 'en-US')).toBe('en')
    expect(resolveLanguage(null, 'zh-CN')).toBe('zh')
    expect(resolveLanguage(null, 'zh-Hant-TW')).toBe('zh')
    expect(resolveLanguage(undefined, 'en-GB')).toBe('en')
    // 无系统语言信息 → 回落 en(非中文环境)
    expect(resolveLanguage(null, null)).toBe('en')
    expect(resolveLanguage(null, undefined)).toBe('en')
  })

  it('合法输入原样通过', () => {
    const input = {
      language: 'en',
      theme: 'dark',
      tray: true,
      autoStart: true,
      notifications: false,
      preventSleepWhenRunning: true,
      workspaceCacheSize: 7,
      inheritShellEnv: false,
      npmRegistry: 'https://registry.npmmirror.com'
    }
    expect(normalizeSettings(input)).toEqual(input)
  })

  it('逐字段收敛:一个坏字段不重置整份偏好', () => {
    const normalized = normalizeSettings({
      language: 'en',
      theme: 'rainbow', // 非法
      tray: 'yes', // 非法
      autoStart: true,
      notifications: false
      // workspaceCacheSize 缺失 → 回落默认
    })
    expect(normalized).toEqual({
      language: 'en', // 保留
      theme: 'system', // 回落默认
      tray: false, // 回落默认
      autoStart: true, // 保留
      notifications: false, // 保留
      preventSleepWhenRunning: false, // 缺失回落默认
      workspaceCacheSize: 3, // 缺失回落默认
      inheritShellEnv: true, // 缺失回落默认
      npmRegistry: '' // 缺失回落默认
    })
  })

  it('非对象输入回落默认', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS)
  })

  it('缺字段补默认(向后兼容:新增设置项不破坏旧文件)', () => {
    expect(normalizeSettings({ language: 'en' })).toEqual({
      ...DEFAULT_SETTINGS,
      language: 'en'
    })
  })

  it('schema 不落 `system` 之外的语言值', () => {
    expect(SettingsSchema.safeParse({ language: 'fr' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ theme: 'system' }).success).toBe(true)
  })

  it('npm 镜像信任根:只接受 https,本地镜像放行回环 http', () => {
    expect(
      SettingsSchema.safeParse({ npmRegistry: 'https://registry.npmmirror.com' }).success
    ).toBe(true)
    expect(SettingsSchema.safeParse({ npmRegistry: 'https://[::1]:4873/' }).success).toBe(true)
    expect(SettingsSchema.safeParse({ npmRegistry: 'http://127.0.0.1:4873' }).success).toBe(true)
    expect(SettingsSchema.safeParse({ npmRegistry: 'http://localhost:4873' }).success).toBe(true)
    expect(SettingsSchema.safeParse({ npmRegistry: '' }).success).toBe(true)

    // registry 自证完整性且执行生命周期脚本,是整条下载链的信任根:
    // 其余协议与明文远程源一律拒绝。
    expect(SettingsSchema.safeParse({ npmRegistry: 'file:///tmp/evil-registry' }).success).toBe(
      false
    )
    expect(SettingsSchema.safeParse({ npmRegistry: 'ftp://example.com/' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ npmRegistry: 'javascript:alert(1)' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ npmRegistry: 'http://evil.example.com/' }).success).toBe(
      false
    )
    expect(SettingsSchema.safeParse({ npmRegistry: 'not a url' }).success).toBe(false)
  })

  it('非法镜像地址经 normalizeSettings 回落默认,其余字段不受影响', () => {
    expect(normalizeSettings({ language: 'en', npmRegistry: 'file:///tmp/x' })).toEqual({
      ...DEFAULT_SETTINGS,
      language: 'en',
      npmRegistry: ''
    })
  })

  it('sanitizeEnvRegistry:环境变量镜像走同一信任根,非法值丢弃', () => {
    // 合法值原样返回（去空白）
    expect(sanitizeEnvRegistry('https://registry.npmmirror.com')).toBe(
      'https://registry.npmmirror.com'
    )
    expect(sanitizeEnvRegistry('  https://registry.npmjs.org  ')).toBe('https://registry.npmjs.org')
    expect(sanitizeEnvRegistry('http://127.0.0.1:4873')).toBe('http://127.0.0.1:4873')
    // 空/未设置 → undefined（回落系统 npm 配置）
    expect(sanitizeEnvRegistry(undefined)).toBeUndefined()
    expect(sanitizeEnvRegistry('')).toBeUndefined()
    expect(sanitizeEnvRegistry('   ')).toBeUndefined()
    // 明文远程源与非法协议一律丢弃：绝不重开 MITM → 任意代码路径
    expect(sanitizeEnvRegistry('http://evil.example.com/')).toBeUndefined()
    expect(sanitizeEnvRegistry('file:///tmp/evil-registry')).toBeUndefined()
    expect(sanitizeEnvRegistry('not a url')).toBeUndefined()
  })

  it('插件安装源档位映射为 https URL，缺省与未知档位都回落默认源', () => {
    expect(DEFAULT_PLUGIN_REGISTRY).toBe('npmmirror')
    expect(pluginRegistryUrl('npmmirror')).toBe('https://registry.npmmirror.com')
    expect(pluginRegistryUrl('npmjs')).toBe('https://registry.npmjs.org')
    expect(pluginRegistryUrl(undefined)).toBe('https://registry.npmmirror.com')
    expect(pluginRegistryUrl(null)).toBe('https://registry.npmmirror.com')
    // 映射结果必须过信任根校验：档位无法被用来指定明文或任意源。
    expect(isAllowedNpmRegistry(pluginRegistryUrl('npmmirror'))).toBe(true)
    expect(isAllowedNpmRegistry(pluginRegistryUrl('npmjs'))).toBe(true)
    expect(isAllowedNpmRegistry(pluginRegistryUrl(undefined))).toBe(true)
  })

  it('registryPresetKey:空=system、预设 URL 取 URL、其余归 custom（向导与编辑共用）', () => {
    expect(registryPresetKey('')).toBe('system')
    expect(registryPresetKey('https://registry.npmmirror.com')).toBe(
      'https://registry.npmmirror.com'
    )
    expect(registryPresetKey('https://registry.npmjs.org')).toBe('https://registry.npmjs.org')
    expect(registryPresetKey('http://127.0.0.1:4873')).toBe('custom')
    expect(registryPresetKey('https://npm.example.com/')).toBe('custom')
  })

  it('pluginRegistryFromUrl:预设映射对应档位，自定义与空串回落默认档', () => {
    expect(pluginRegistryFromUrl('https://registry.npmjs.org')).toBe('npmjs')
    expect(pluginRegistryFromUrl('https://registry.npmmirror.com')).toBe('npmmirror')
    // 尾斜杠与首尾空白是用户手输常见形态，按同一档位识别。
    expect(pluginRegistryFromUrl(' https://registry.npmjs.org/ ')).toBe('npmjs')
    expect(pluginRegistryFromUrl('')).toBe(DEFAULT_PLUGIN_REGISTRY)
    expect(pluginRegistryFromUrl('http://127.0.0.1:4873')).toBe(DEFAULT_PLUGIN_REGISTRY)
  })
})
