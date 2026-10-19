import { _electron as electron, expect, test } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
/**
 * 应用冒烟：窗口渲染真实外壳、preload 白名单 API 形状、空数据目录展示空态、
 * 主进程版本信息可达。前置：`pnpm build`。
 */

const DATA_DIR = e2eDataDir('e2e-smoke')

let app: ElectronApplication
let win: Page

const launchArgs = buildLaunchArgs()

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  app = await electron.launch({
    args: launchArgs,
    env: e2eEnv(DATA_DIR)
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

test('窗口打开并渲染出应用外壳', async () => {
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await expect(win.getByTestId('brand')).toBeVisible()
  await expect(win.getByTestId('sidebar')).toBeVisible()
})

test('preload 白名单桥接形状正确(无多余暴露)', async () => {
  const api = await win.evaluate(() => (window.dshHub ? Object.keys(window.dshHub).sort() : null))
  // 仅暴露白名单中的 API 组；额外暴露会让本用例失败。
  expect(api).toEqual(
    [
      'auth',
      'getInfo',
      'http',
      'instances',
      'onInstanceStatus',
      'onVersionProgress',
      'onWorkspaceHotkey',
      'openAbout',
      'openHomepage',
      'ping',
      'plugin',
      'runtime',
      'settings',
      'spaces',
      'ssh',
      'vault'
    ].sort()
  )
  const runtimeKeys = await win.evaluate(() =>
    window.dshHub?.runtime ? Object.keys(window.dshHub.runtime).sort() : null
  )
  expect(runtimeKeys).toEqual([
    'adoptExternal',
    'checkDshVersion',
    'disconnectView',
    'hideTooltip',
    'hideView',
    'listDshVersions',
    'listRuntimeConfirms',
    'onRuntimeConfirm',
    'openInBrowser',
    'openView',
    'probeLocalDsh',
    'reloadView',
    'replyRuntimeConfirm',
    'restart',
    'scanExternal',
    'showTooltip',
    'start',
    'stop',
    'updateViewBounds',
    'upgradeDshVersion'
  ])
  const sshKeys = await win.evaluate(() =>
    window.dshHub?.ssh ? Object.keys(window.dshHub.ssh).sort() : null
  )
  expect(sshKeys).toEqual(
    [
      'keyPreview',
      'onAskpassRequest',
      'onHostKeyDecision',
      'replyAskpass',
      'replyHostKey',
      // 指纹变化时，用户可显式删除已保存的指纹后重新确认。
      // 用户显式遗忘本机为该主机保存的指纹,下次连接重新 TOFU。
      // 这是破坏性动作,但没有它就无法从「主机合法换钥」中恢复。
      'forgetHostKey'
    ].sort()
  )
  const httpKeys = await win.evaluate(() =>
    window.dshHub?.http ? Object.keys(window.dshHub.http).sort() : null
  )
  expect(httpKeys).toEqual(['detect'])
  const authKeys = await win.evaluate(() =>
    window.dshHub?.auth ? Object.keys(window.dshHub.auth).sort() : null
  )
  // loginStored 不跨 IPC 传递密码；任何额外暴露都会让本用例失败。
  expect(authKeys).toEqual(['login', 'loginStored', 'logout', 'onSignal', 'onState', 'probe'])
  // 凭据保险库不提供读取凭据的通道。
  const vaultKeys = await win.evaluate(() =>
    window.dshHub?.vault ? Object.keys(window.dshHub.vault).sort() : null
  )
  expect(vaultKeys).toEqual(['clear', 'forget', 'setPolicy', 'status'])
  // openDataDir 不接收参数，目录由主进程自行解析。
  const settingsKeys = await win.evaluate(() =>
    window.dshHub?.settings ? Object.keys(window.dshHub.settings).sort() : null
  )
  expect(settingsKeys).toEqual(['get', 'openDataDir', 'refreshEnvironment', 'update'])
})

test('空数据目录展示空态(真实注册表后端)', async () => {
  await expect(win.getByTestId('view-empty')).toBeVisible()
  await expect(win.getByTestId('empty-new-btn')).toBeVisible()
})

test('主进程版本信息可经桥接读取', async () => {
  const info = await win.evaluate(async () => window.dshHub.getInfo())
  expect(info.ok).toBe(true)
  if (info.ok) {
    expect(info.value.electron).toMatch(/^\d+\.\d+\.\d+/)
    expect(info.value.platform).not.toBe('')
  }
})
