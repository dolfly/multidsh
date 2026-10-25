import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// electron 在 vitest node 环境不可加载——整体 mock 掉,只验证注册与边界行为
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    getVersion: () => '9.9.9',
    getPath: () => '/tmp/fake-userdata',
    getLocale: () => 'zh-CN',
    getPreferredSystemLanguages: () => ['zh-Hans-CN', 'en']
  }
}))

import { setupRegister, teardownRegister, type RegisterHarness } from './register.testkit'

let harness: RegisterHarness
let handlers: RegisterHarness['handlers']
let invoke: RegisterHarness['invoke']
let showInstanceTooltip: RegisterHarness['showInstanceTooltip']
let hideInstanceTooltip: RegisterHarness['hideInstanceTooltip']

beforeEach(async () => {
  harness = await setupRegister()
  ;({ handlers, invoke, showInstanceTooltip, hideInstanceTooltip } = harness)
})

afterEach(async () => {
  await teardownRegister(harness)
})

describe('registerIpc', () => {
  it('注册 app 双探针 + 实例 CRUD + 运行时控制 + /辅助通道', () => {
    const expected = [
      'app:info',
      'app:ping',
      'app:open-homepage',
      'app:open-about',
      'app:open-external-link',
      'instances:list',
      'instances:get',
      'instances:create',
      'instances:update',
      'instances:delete',
      'instances:reorder',
      'instances:openDirectory',
      'instances:openLogDirectory',
      'instances:start',
      'instances:stop',
      'instances:restart',
      'instances:openView',
      'instances:reloadView',
      'instances:openInBrowser',
      'instances:updateViewBounds',
      'instances:showTooltip',
      'instances:hideTooltip',
      'instances:hideView',
      'instances:disconnectView',
      'instances:probeLocalDsh',
      'instances:scanExternal',
      'instances:adoptExternal',
      'dsh-version:check',
      'dsh-version:upgrade',
      'dsh-version:list',
      'dsh-version:confirmList',
      'dsh-version:confirmReply',
      'plugin:list',
      'plugin:check',
      'plugin:checkState',
      'plugin:install',
      'plugin:resolveInstall',
      'plugin:packageInfo',
      'plugin:upgrade',
      'plugin:remove',
      'plugin:setEnabled',
      'plugin:openExternal',
      'ssh:keyPreview',
      'ssh:hostKeyReply',
      'ssh:hostKeyForget',
      'ssh:askpassReply',
      'http:detect',
      'auth:probe',
      'auth:login',
      'auth:loginStored',
      'auth:logout',
      'vault:status',
      'vault:setPolicy',
      'vault:forget',
      'vault:clear',
      'settings:get',
      'settings:openDataDir',
      'settings:refreshEnvironment',
      'settings:update',
      'spaces:list',
      'spaces:trash'
    ]
    expect([...handlers.keys()].sort()).toEqual(expected.sort())
  })

  it('将经 schema 校验的原生提示交给主进程，并在隐藏时撤销', async () => {
    const shown = (await invoke('instances:showTooltip', { text: '实例名称', x: 72, y: 160 })) as {
      ok: boolean
      value: null
    }
    const hidden = (await invoke('instances:hideTooltip')) as { ok: boolean; value: null }

    expect(shown).toEqual({ ok: true, value: null })
    expect(hidden).toEqual({ ok: true, value: null })
    expect(showInstanceTooltip).toHaveBeenCalledWith({ text: '实例名称', x: 72, y: 160 })
    expect(hideInstanceTooltip).toHaveBeenCalledOnce()
  })

  it('拒绝超长或越界的原生提示载荷', async () => {
    const result = (await invoke('instances:showTooltip', {
      text: 'x'.repeat(201),
      x: -1,
      y: 160
    })) as {
      ok: boolean
      code?: string
    }

    expect(result).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(showInstanceTooltip).not.toHaveBeenCalled()
  })

  it('app:info 返回版本快照', async () => {
    const result = (await invoke('app:info')) as {
      ok: boolean
      value: {
        appVersion: string
        buildCommit: string
        buildTime: string
        bundledDeps: Array<{ name: string; version: string }>
      }
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.appVersion).toBe('9.9.9')
      // 构建期常量在单测环境无 define 注入，回落 'unknown'；此处守住字段存在与类型。
      expect(typeof result.value.buildCommit).toBe('string')
      expect(typeof result.value.buildTime).toBe('string')
      // 单测环境（src/ 下）没有 out/*/bundled-deps.json，汇总结果是空表。
      expect(Array.isArray(result.value.bundledDeps)).toBe(true)
      for (const dep of result.value.bundledDeps) {
        expect(typeof dep.name).toBe('string')
        expect(dep.name).not.toBe('')
        expect(typeof dep.version).toBe('string')
        expect(dep.version).not.toBe('')
      }
    }
  })

  it('app:ping 原样回显', async () => {
    const result = (await invoke('app:ping', 'hello')) as {
      ok: boolean
      value: { echo: string | null }
    }
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.echo).toBe('hello')
  })

  it('app:ping 非字符串入参 → invalid-input', async () => {
    const result = (await invoke('app:ping', 123)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-input')
  })

  it('ssh:askpassReply 空串/全空白在 IPC 边界拒绝(invalid-input)', async () => {
    const reply = (secret: unknown) =>
      invoke('ssh:askpassReply', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', secret)
    // 空串与全空白都不是有效口令(UI 已 disabled,这里是 IPC 边界的第二道闸)
    const empty = (await reply('')) as { ok: boolean; code?: string }
    expect(empty.ok).toBe(false)
    expect(empty.code).toBe('invalid-input')
    const blank = (await reply('   ')) as { ok: boolean; code?: string }
    expect(blank.ok).toBe(false)
    expect(blank.code).toBe('invalid-input')
    // null 是合法回答(用户显式取消)
    const cancelled = (await reply(null)) as { ok: boolean }
    expect(cancelled.ok).toBe(true)
  })
})
