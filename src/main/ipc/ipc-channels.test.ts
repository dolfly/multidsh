import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC } from '@shared/bridge'
import {
  AUTH_IPC,
  DSH_VERSION_IPC,
  DSH_VERSION_PROGRESS_EVENT,
  HTTP_IPC,
  INSTANCE_IPC,
  INSTANCE_RUNTIME_IPC,
  INSTANCE_STATUS_EVENT,
  PLUGIN_IPC,
  SETTINGS_IPC,
  SPACE_IPC,
  SSH_IPC,
  VAULT_IPC,
  WORKSPACE_HOTKEY_EVENT
} from '@shared/contracts'

/**
 * IPC 通道四面对账（AGENTS「新 IPC 通道需同步更新 5 处」的机器守护）。
 *
 * 通道名单在四处出现：contracts 常量（唯一声明）、主进程 `ipcMain.handle` 注册、
 * preload 的 `ipcRenderer.invoke`（渲染→主）、preload 的 `subscribe`（主→渲染事件）。
 * 任一处漏同步都不会编译报错——只是运行时「通道未注册」或事件静默丢失。
 *
 * 这里不做运行时注册（那由 register.test.ts 的硬编码全集负责），而是把三份**源码字面量**
 * 与契约常量对账：新增通道若只改了其中一两处，集合不等即红。要求通道在注册与桥接处
 * 一律写成 `CONSTANT.member` 字面量——间接引用会让扫描漏记并被本测试拦下。
 */

/** 渲染 → 主（invoke/handle）通道的常量来源。 */
const INVOKE_CONSTANTS: Record<string, Record<string, string>> = {
  IPC,
  SSH_IPC,
  HTTP_IPC,
  AUTH_IPC,
  VAULT_IPC,
  SETTINGS_IPC,
  SPACE_IPC,
  INSTANCE_IPC,
  INSTANCE_RUNTIME_IPC,
  DSH_VERSION_IPC,
  PLUGIN_IPC
}

/**
 * 主 → 渲染（事件）通道：`*_IPC` 里的推送成员 + 独立 `*_EVENT` 常量。
 * preload 用 subscribe 消费，主进程用 webContents.send 发送，不经 ipcMain.handle。
 */
const EVENT_CONSTANTS: Record<string, Record<string, string> | string> = {
  SSH_IPC: { hostKeyDecision: SSH_IPC.hostKeyDecision, askpassRequest: SSH_IPC.askpassRequest },
  AUTH_IPC: { state: AUTH_IPC.state, signal: AUTH_IPC.signal },
  DSH_VERSION_IPC: { confirmRequest: DSH_VERSION_IPC.confirmRequest },
  INSTANCE_STATUS_EVENT,
  DSH_VERSION_PROGRESS_EVENT,
  WORKSPACE_HOTKEY_EVENT
}

const ROOT = process.cwd()

/** 全部 invoke 通道值（契约派生；`*_IPC` 常量对象里的事件成员要扣除）。 */
function invokeChannels(): Set<string> {
  const event = eventChannels()
  const values = new Set<string>()
  for (const members of Object.values(INVOKE_CONSTANTS)) {
    for (const value of Object.values(members)) {
      if (!event.has(value)) values.add(value)
    }
  }
  return values
}

/** 全部事件通道值（契约派生）。 */
function eventChannels(): Set<string> {
  const values = new Set<string>()
  for (const entry of Object.values(EVENT_CONSTANTS)) {
    if (typeof entry === 'string') values.add(entry)
    else for (const value of Object.values(entry)) values.add(value)
  }
  return values
}

/** 把源码里的 `CONSTANT` / `CONSTANT.member` 引用解析为通道值；解析不了即抛（拦间接引用）。 */
function resolveRef(constant: string, member: string | undefined): string {
  const event = EVENT_CONSTANTS[constant]
  if (member === undefined) {
    if (typeof event === 'string') return event
    throw new Error(`事件常量 ${constant} 必须带成员引用`)
  }
  if (event !== undefined && typeof event !== 'string' && event[member] !== undefined) {
    return event[member]
  }
  const invoke = INVOKE_CONSTANTS[constant]
  if (invoke?.[member] !== undefined) return invoke[member]
  throw new Error(`源码引用了未知的通道常量：${constant}.${member}`)
}

/** 取正则捕获组；正则保证非空，类型层仍按 possibly-undefined 收窄。 */
function ref(match: RegExpMatchArray): { constant: string; member: string | undefined } {
  const constant = match[1]
  if (constant === undefined) throw new Error('正则缺少常量捕获组')
  return { constant, member: match[2] }
}

/** 扫描 preload：ipcRenderer.invoke(...) 的通道集合与 subscribe(...) 的通道集合。 */
function scanPreload(): { invoked: Set<string>; subscribed: Set<string> } {
  const source = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8')
  const invoked = new Set<string>()
  const subscribed = new Set<string>()
  for (const match of source.matchAll(
    /ipcRenderer\.invoke\(\s*([A-Z][A-Z_0-9]*)\.([A-Za-z_0-9]+)/g
  )) {
    const { constant, member } = ref(match)
    invoked.add(resolveRef(constant, member))
  }
  for (const match of source.matchAll(
    /subscribe(?:<[^>]*>)?\(\s*([A-Z][A-Z_0-9]*)(?:\.([A-Za-z_0-9]+))?/g
  )) {
    // subscribe 的定义处（`const subscribe = <T>(channel: ...)`）参数是小写开头，不会命中。
    const { constant, member } = ref(match)
    subscribed.add(resolveRef(constant, member))
  }
  return { invoked, subscribed }
}

/** 扫描主进程 ipc 目录（排除测试）：ipcMain.handle(CONSTANT.member) 注册的通道集合。 */
function scanRegistered(): Set<string> {
  const dir = join(ROOT, 'src/main/ipc')
  const registered = new Set<string>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
    const source = readFileSync(join(dir, file), 'utf8')
    for (const match of source.matchAll(
      /ipcMain\.handle\(\s*([A-Z][A-Z_0-9]*)\.([A-Za-z_0-9]+)/g
    )) {
      const { constant, member } = ref(match)
      registered.add(resolveRef(constant, member))
    }
  }
  return registered
}

describe('IPC 通道四面对账（contracts ↔ 注册 ↔ preload invoke ↔ preload subscribe）', () => {
  it('invoke 与 event 两集合不相交，且并集覆盖全部通道常量', () => {
    const invoke = invokeChannels()
    const event = eventChannels()
    expect([...invoke].filter((channel) => event.has(channel))).toEqual([])
    // 契约成员必须非空，防扫描退化成空集对空集「假绿」。
    expect(invoke.size).toBeGreaterThan(50)
    expect(event.size).toBe(8)
  })

  it('主进程注册的 handle 通道 = 契约 invoke 集合（不多注册、不漏注册）', () => {
    const registered = scanRegistered()
    const invoke = invokeChannels()
    expect([...registered].filter((channel) => !invoke.has(channel))).toEqual([])
    expect([...invoke].filter((channel) => !registered.has(channel))).toEqual([])
  })

  it('preload invoke 的通道 = 契约 invoke 集合（渲染层可调用面与契约一致）', () => {
    const { invoked } = scanPreload()
    const invoke = invokeChannels()
    expect([...invoked].filter((channel) => !invoke.has(channel))).toEqual([])
    expect([...invoke].filter((channel) => !invoked.has(channel))).toEqual([])
  })

  it('preload subscribe 的通道 = 契约 event 集合（事件不漏订、不误订）', () => {
    const { subscribed } = scanPreload()
    const event = eventChannels()
    expect([...subscribed].filter((channel) => !event.has(channel))).toEqual([])
    expect([...event].filter((channel) => !subscribed.has(channel))).toEqual([])
  })
})
