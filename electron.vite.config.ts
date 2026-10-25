import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const sharedAlias = { '@shared': resolve('src/shared') }

/** 构建期的 git 短 hash；无 .git 或 git 不可用时回落 'unknown'，运行时不再触碰 git。 */
function gitShortHash(): string {
  try {
    const out = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim()
    return out || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 读取项目根目录的 JSON 文件；不存在或无法解析时返回 null。 */
function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 包在 node_modules 中的元数据版本；依赖未安装或元数据缺失时返回 null。 */
function installedVersion(name: string): string | null {
  const manifest = readJson(resolve('node_modules', name, 'package.json'))
  const version = manifest?.version
  return typeof version === 'string' && version ? version : null
}

/**
 * 构建期读取 package.json 声明的第三方依赖（dependencies + devDependencies），
 * 版本取 node_modules 中的实际安装值，取不到时回落声明的版本范围；按包名排序。
 */
function thirdPartyDependencies(): Array<{ name: string; version: string }> {
  const manifest = readJson(resolve('package.json'))
  const declared: Record<string, string> = {}
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const group = manifest?.[field]
    if (!group || typeof group !== 'object') continue
    for (const [name, range] of Object.entries(group as Record<string, unknown>)) {
      if (typeof range === 'string') declared[name] = range
    }
  }
  return Object.keys(declared)
    .map((name) => ({ name, version: installedVersion(name) ?? declared[name] ?? 'unknown' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// 构建期常量：烘进 main bundle 的字面量，供「关于」面板展示当前运行包的来源与依赖。
const buildDefine = {
  __DSH_BUILD_COMMIT__: JSON.stringify(gitShortHash()),
  __DSH_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  __DSH_BUILD_DEPS__: JSON.stringify(thirdPartyDependencies())
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    define: buildDefine
  },
  preload: {
    resolve: { alias: sharedAlias }
  },
  renderer: {
    resolve: { alias: sharedAlias },
    plugins: [react()]
  }
})
