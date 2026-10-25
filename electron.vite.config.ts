import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

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

/**
 * 模块 id 中的包名：`.../node_modules/[.pnpm/<坑>/node_modules/]<name>/<子路径>`。
 * 只匹配 node_modules 内的模块，src/ 与虚拟模块自然排除。
 */
const PACKAGE_IN_MODULE_ID =
  /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//

/**
 * pnpm 仓库目录名 `<pkg>@<version>[_<peer>@<ver>…]` 中属于该包的版本。
 * peer 依赖以 `_` 连接在版本之后，作用域包在目录名里写作 `@scope+name`；
 * 目录名不是这个包（模块经其它包的 node_modules 到达）时返回 null。
 */
function pnpmVersionOf(dir: string, name: string): string | null {
  const sep = dir.startsWith('@') ? dir.indexOf('@', 1) : dir.indexOf('@')
  if (sep <= 0) return null
  if (dir.slice(0, sep).replace('+', '/') !== name) return null
  const rest = dir.slice(sep + 1)
  const peerAt = rest.indexOf('_')
  return peerAt === -1 ? rest : rest.slice(0, peerAt)
}

/**
 * 模块所属包的安装版本。优先解析 pnpm 目录布局（`.pnpm/<name>@<version>/`），
 * 直接依赖再回落根 node_modules 的包清单；两者都取不到时为 'unknown'。
 */
function packageVersion(name: string, moduleIds: readonly string[]): string {
  for (const id of moduleIds) {
    const dir = id.match(/node_modules\/\.pnpm\/([^/]+)\//)?.[1]
    const version = dir ? pnpmVersionOf(dir, name) : null
    if (version) return version
  }
  try {
    const manifest = JSON.parse(
      readFileSync(resolve('node_modules', name, 'package.json'), 'utf8')
    ) as { version?: unknown }
    if (typeof manifest.version === 'string' && manifest.version) return manifest.version
  } catch {
    // 包元数据缺失（如未安装的间接依赖）：交给 'unknown' 兜底。
  }
  return 'unknown'
}

/**
 * 把本构建目标实际打进产物的第三方包写成 `bundled-deps.json`（out/<目标>/ 根下）。
 * 数据源是产出 chunk 的模块图而非 package.json 声明：只有运行期真正随包分发的依赖
 * 才进清单，纯开发/测试/构建期依赖（vitest、eslint 等）不会出现。
 */
function bundledDepsManifest(): Plugin {
  return {
    name: 'dsh-hub-bundled-deps',
    generateBundle(_options, bundle) {
      const idsByName = new Map<string, string[]>()
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue
        for (const id of Object.keys(file.modules)) {
          const name = PACKAGE_IN_MODULE_ID.exec(id)?.[1]
          if (!name) continue
          const ids = idsByName.get(name)
          if (ids) ids.push(id)
          else idsByName.set(name, [id])
        }
      }
      const deps = [...idsByName]
        .map(([name, ids]) => ({ name, version: packageVersion(name, ids) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      this.emitFile({
        type: 'asset',
        fileName: 'bundled-deps.json',
        source: `${JSON.stringify(deps, null, 2)}\n`
      })
    }
  }
}

// 构建期常量：烘进 main bundle 的字面量，供「关于」面板展示当前运行包的来源。
const buildDefine = {
  __DSH_BUILD_COMMIT__: JSON.stringify(gitShortHash()),
  __DSH_BUILD_TIME__: JSON.stringify(new Date().toISOString())
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    define: buildDefine,
    plugins: [bundledDepsManifest()]
  },
  preload: {
    resolve: { alias: sharedAlias },
    plugins: [bundledDepsManifest()]
  },
  renderer: {
    resolve: { alias: sharedAlias },
    plugins: [react(), bundledDepsManifest()]
  }
})
