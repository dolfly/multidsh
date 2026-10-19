/**
 * 生成 `dist/SHA256SUMS.txt`。
 *
 * 为什么需要:自动更新链路自带 sha512,但**手工下载安装包**的人没有完整性依据。
 * SHA-256 是发布物的通用校验口径,发布说明里直接引用这个文件。
 *
 * 用法:`node scripts/release/checksums.mjs [distDir]`
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SUMS_FILE = 'SHA256SUMS.txt'
/** `*.blockmap` 是给自动更新做差分的中间产物,不属于「分发给人的产物」 */
const EXCLUDED_SUFFIXES = ['.blockmap']
/**
 * 显式排除非分发产物：点文件（如 macOS 的 .DS_Store）与 builder 调试输出不进入校验和清单。
 * (清单引用了不会被上传的文件会误导手工下载者)。
 */
const EXCLUDED_NAMES = new Set(['builder-debug.yml', 'builder-effective-config.yaml'])

export async function sha256Of(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** 收集 `dist/` 下应当出现在校验和清单里的文件(按文件名排序,保证可复现) */
export async function collectArtifacts(distDir) {
  const names = await readdir(distDir)
  const files = []
  for (const name of names) {
    if (name === SUMS_FILE) continue
    if (name.startsWith('.')) continue
    if (EXCLUDED_NAMES.has(name)) continue
    if (EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue
    const full = join(distDir, name)
    const info = await stat(full)
    if (!info.isFile()) continue
    files.push({ name, size: info.size })
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

async function main() {
  const distDir = resolve(process.argv[2] ?? 'dist')
  const files = await collectArtifacts(distDir)
  if (files.length === 0) {
    console.error(
      `[release] ${distDir} 下没有可校验的产物 —— 先执行 pnpm dist:mac:zip / pnpm dist:win`
    )
    process.exit(1)
  }
  const lines = []
  for (const file of files) {
    const digest = await sha256Of(join(distDir, file.name))
    lines.push(`${digest}  ${file.name}`)
    console.log(`[release] sha256 ${digest}  ${file.name}`)
  }
  const target = join(distDir, SUMS_FILE)
  await writeFile(target, `${lines.join('\n')}\n`, 'utf8')
  console.log(`[release] 已写出 ${target}（${files.length} 个产物）`)
}

// Windows 下 argv[1] 是反斜杠盘符路径,必须经 pathToFileURL 归一后才能与 import.meta.url 比较
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error('[release] 生成校验和失败：', error)
    process.exit(1)
  })
}
