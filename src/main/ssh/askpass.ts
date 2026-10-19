/**
 *
 * 机制：ssh 需要口令（私钥口令 / 密码认证）时，会调用 `SSH_ASKPASS` 指向的程序并
 * 把提示语作为参数传入。hub 在这里：
 *   1. 运行时写入一个极小的 helper（`.cjs`）+ 一个 shell 包装（`.sh`，不经 shell 传参）；
 *   2. 主进程监听一条 **unix socket**（本机、仅当前用户可访问，避免额外监听端口）；
 *   3. helper 把提示语转给主进程 → UI 弹窗 → 用户输入 → 答案经 stdout 回给 ssh。
 *
 * **口令/密钥口令只存在于内存与这条 socket 上，绝不落盘、绝不进日志。**
 */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'

/** helper 脚本文件名（随 socket 目录存放） */
export const ASKPASS_HELPER_NAME = 'askpass-helper.cjs'
export const ASKPASS_WRAPPER_NAME = 'askpass.sh'

/**
 * helper 源码：连接 `DSH_HUB_ASKPASS_SOCKET`，发送提示语，等待答案后写 stdout。
 * 用 CommonJS + 显式 node 包装调用（不依赖 shebang / PATH 里的 node）。
 */
export const ASKPASS_HELPER_SOURCE = `// 由 DSH Hub 运行时写入；把 ssh 的口令提示转发给主进程，答案只经 stdout 回给 ssh。
'use strict'
const net = require('node:net')
const socketPath = process.env.DSH_HUB_ASKPASS_SOCKET
const prompt = process.argv[2] || 'SSH 需要输入口令'
if (!socketPath) {
  process.stderr.write('askpass: DSH_HUB_ASKPASS_SOCKET 未设置\\n')
  process.exit(1)
}
let settled = false
function finish(code, output) {
  if (settled) return
  settled = true
  if (output) process.stdout.write(output)
  process.exit(code)
}
const timer = setTimeout(() => {
  process.stderr.write('askpass: 等待用户输入超时\\n')
  finish(1)
}, 10 * 60 * 1000)
timer.unref()
const client = net.connect(socketPath, () => {
  client.write(JSON.stringify({ prompt }) + '\\n')
})
let buffer = ''
client.on('data', (chunk) => {
  buffer += chunk
  const index = buffer.indexOf('\\n')
  if (index === -1) return
  const line = buffer.slice(0, index)
  client.end()
  try {
    const reply = JSON.parse(line)
    if (reply && reply.cancelled !== true && typeof reply.secret === 'string') {
      finish(0, reply.secret + '\\n')
      return
    }
  } catch {
    /* 落到取消分支 */
  }
  finish(1)
})
client.on('error', (error) => {
  process.stderr.write('askpass: 通道失败 ' + error.message + '\\n')
  finish(1)
})
`

/** 包装脚本：用 hub 自带 Node/Electron-as-Node 执行 helper（argv 不经 shell） */
export function askpassWrapperSource(
  nodeCommand: string,
  nodeArgs: string[],
  helperPath: string
): string {
  const quotedArgs = nodeArgs.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ')
  return [
    '#!/bin/sh',
    '# 由 DSH Hub 运行时写入：用自带 Node 执行 askpass helper（不依赖 PATH 中的 node）',
    `exec '${nodeCommand.replace(/'/g, `'\\''`)}' ${quotedArgs} '${helperPath.replace(/'/g, `'\\''`)}' "$@"`,
    ''
  ].join('\n')
}

export interface AskpassScripts {
  wrapperPath: string
  helperPath: string
}

/** 写入（幂等）helper + wrapper，返回 wrapper 路径（SSH_ASKPASS 指向它） */
export async function ensureAskpassScripts(
  dir: string,
  nodeCommand: string,
  nodeArgs: string[]
): Promise<AskpassScripts> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const helperPath = join(dir, ASKPASS_HELPER_NAME)
  const wrapperPath = join(dir, ASKPASS_WRAPPER_NAME)
  await writeFile(helperPath, ASKPASS_HELPER_SOURCE, { mode: 0o600 })
  await writeFile(wrapperPath, askpassWrapperSource(nodeCommand, nodeArgs, helperPath), {
    mode: 0o700
  })
  await chmod(wrapperPath, 0o700)
  return { wrapperPath, helperPath }
}

export interface AskpassPrompt {
  prompt: string
}

export interface AskpassServer {
  socketPath: string
  close(): Promise<void>
}

export interface AskpassServerOptions {
  socketPath: string
  /** 提示语 → 用户答案；返回 null = 用户取消 */
  onPrompt: (prompt: AskpassPrompt) => Promise<string | null>
  /** 单次提示的超时（默认 10 分钟，与 helper 侧一致） */
  timeoutMs?: number
  /** 传输仅限当前用户：socket 权限 0600 */
  socketMode?: number
}

/**
 * 启动 askpass unix socket 服务（每个隧道实例一条，路径含实例 slug 便于归因）。
 * 无 electron 依赖，可单测（直接连 socket 走协议）。
 */
export function startAskpassServer(options: AskpassServerOptions): Promise<AskpassServer> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  const socketMode = options.socketMode ?? 0o600
  const sockets = new Set<Socket>()

  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
    let buffer = ''
    let handled = false
    const timer = setTimeout(() => socket.destroy(), timeoutMs)
    timer.unref()

    socket.on('data', (chunk) => {
      if (handled) return
      buffer += chunk.toString('utf8')
      const index = buffer.indexOf('\n')
      if (index === -1) return
      handled = true
      clearTimeout(timer)
      let prompt = 'SSH 需要输入口令'
      try {
        const parsed = JSON.parse(buffer.slice(0, index)) as { prompt?: unknown }
        if (typeof parsed.prompt === 'string' && parsed.prompt.trim() !== '') prompt = parsed.prompt
      } catch {
        /* 用默认提示语 */
      }
      void options
        .onPrompt({ prompt })
        .then((secret) => {
          if (socket.destroyed) return
          socket.end(JSON.stringify(secret === null ? { cancelled: true } : { secret }) + '\n')
        })
        .catch(() => {
          if (!socket.destroyed) socket.end(JSON.stringify({ cancelled: true }) + '\n')
        })
    })
  })

  // 陈旧 socket 文件必须先清理:进程被强杀/崩溃后 unix socket 文件会残留,
  // 直接 listen 会 EADDRINUSE,而该失败又会被上层 catch 吞掉 → askpass 永久静默失效
  return rm(options.socketPath, { force: true })
    .catch(() => undefined)
    .then(
      () =>
        new Promise<AskpassServer>((resolve, reject) => {
          server.on('error', reject)
          // chmod 必须在 resolve 之前 await:否则调用方拿到的 socket 权限可能是默认 0755
          server.listen(options.socketPath, () => {
            void chmod(options.socketPath, socketMode)
              .catch(() => undefined)
              .then(() =>
                resolve({
                  socketPath: options.socketPath,
                  close: () =>
                    new Promise<void>((done) => {
                      for (const socket of sockets) socket.destroy()
                      sockets.clear()
                      server.close(() => {
                        // 关闭后一并 unlink,不留残骸(下次 listen 前也会再清一次)
                        void rm(options.socketPath, { force: true })
                          .catch(() => undefined)
                          .then(() => done())
                      })
                    })
                })
              )
          })
        })
    )
}

/** 生成某实例的 askpass socket 路径（调用方保证目录短，避免 unix socket 104 字节上限） */
export function askpassSocketPath(socketsDir: string, instanceSlug: string): string {
  return join(socketsDir, `ap-${instanceSlug}.sock`)
}

export { dirname }
