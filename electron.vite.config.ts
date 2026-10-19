import { execSync } from 'node:child_process'
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

// 构建期常量：烘进 main bundle 的字面量，供「关于」面板展示当前运行包的来源。
const buildDefine = {
  __DSH_BUILD_COMMIT__: JSON.stringify(gitShortHash()),
  __DSH_BUILD_TIME__: JSON.stringify(new Date().toISOString())
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
